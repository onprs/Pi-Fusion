import {
	type ExtensionAPI,
	type ExtensionContext,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "@earendil-works/pi-coding-agent";
import { registerCustomClassifierEndpoint } from "./classifier.ts";
import { registerFusionCommands } from "./commands.ts";
import { loadFusionRouterConfig, modelKey, saveConfigPatchToLayer } from "./config.ts";
import { DEFAULT_VIRTUAL_THINKING_LEVELS } from "./constants.ts";
import { ModelHealthTracker } from "./health.ts";
import { routeRequest } from "./router.ts";
import type { FusionRouteState, FusionRouterConfig, LoadedConfigResult, PartialFusionRouterConfig } from "./types.ts";
import { notifyRouteTransition, updateRouterStatusBar } from "./ui.ts";

/** 从当前会话分支恢复虚拟模型的最新路由状态 */
function readBranchRouteState(
	ctx: Pick<ExtensionContext, "sessionManager">,
	provider: string,
	modelId: string,
): FusionRouteState | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as VirtualModelStateData<FusionRouteState> | undefined;
		if (data && data.provider === provider && data.modelId === modelId) {
			return data.state;
		}
	}
	return undefined;
}

/** Pi-Fusion 多模型动态路由器扩展入口 */
export default function (pi: ExtensionAPI): void {
	let loadedConfig: LoadedConfigResult = loadFusionRouterConfig({ cwd: process.cwd() });
	let currentCwd = process.cwd();
	const healthTracker = new ModelHealthTracker();
	let lastState: FusionRouteState | undefined;
	let registeredClassifierProviderId: string | undefined;

	/** 同步自定义决策端点：端点被移除或更换提供商 ID 时注销旧的注册 */
	const syncCustomClassifierEndpoint = (cfg: FusionRouterConfig): void => {
		const registered = registerCustomClassifierEndpoint(pi, cfg);
		if (registeredClassifierProviderId && registeredClassifierProviderId !== registered?.providerId) {
			pi.unregisterProvider(registeredClassifierProviderId);
		}
		registeredClassifierProviderId = registered?.providerId;
	};

	const registerVirtualModelFromConfig = (cfg: FusionRouterConfig): void => {
		syncCustomClassifierEndpoint(cfg);
		pi.registerVirtualModel<FusionRouteState>({
			provider: cfg.virtualModel.provider,
			id: cfg.virtualModel.id,
			name: cfg.virtualModel.name,
			thinkingLevels: cfg.virtualModel.thinkingLevels ?? [...DEFAULT_VIRTUAL_THINKING_LEVELS],
			contextWindow: cfg.virtualModel.contextWindow ?? 200_000,
			maxTokens: cfg.virtualModel.maxTokens ?? 64_000,
			input: ["text", "image"],
			async route(request, ctx) {
				const contextUsage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
				const usedTokens =
					typeof contextUsage?.tokens === "number" && contextUsage.tokens > 0
						? contextUsage.tokens
						: undefined;
				const resolved = await routeRequest(request, {
					modelRegistry: ctx.modelRegistry,
					config: loadedConfig.config,
					healthTracker,
					usedTokens,
					onRouteResolved(info) {
						lastState = info.state;
						updateRouterStatusBar(ctx, loadedConfig.config, info.state);
						notifyRouteTransition(ctx, loadedConfig.config, {
							selectedModel: info.state.selectedModel,
							thinkingLevel: info.route.thinkingLevel,
							switchedFrom: info.switchedFrom,
							trigger: info.trigger,
							reason: info.state.lastDecision.reason,
						});
					},
				});
				return resolved;
			},
		});
	};

	const reloadConfigForCwd = (cwd?: string): LoadedConfigResult => {
		if (cwd) currentCwd = cwd;
		const prevVirtual = loadedConfig.config.virtualModel;
		loadedConfig = loadFusionRouterConfig({ cwd: currentCwd });
		const nextVirtual = loadedConfig.config.virtualModel;
		if (prevVirtual.provider !== nextVirtual.provider || prevVirtual.id !== nextVirtual.id) {
			pi.unregisterVirtualModel(prevVirtual.provider, prevVirtual.id);
		}
		registerVirtualModelFromConfig(loadedConfig.config);
		return loadedConfig;
	};

	const updateAndSaveConfig = (
		patch: PartialFusionRouterConfig,
		scope?: "global" | "project",
	): { config: FusionRouterConfig; savedPath: string } => {
		const targetScope = scope ?? (loadedConfig.projectExists ? "project" : "global");
		// 仅写入目标层级文件，再按全局 < 项目的顺序重新加载，避免两层配置互相渗透
		const savedPath = saveConfigPatchToLayer(patch, { scope: targetScope, cwd: currentCwd });
		const loaded = reloadConfigForCwd();
		return { config: loaded.config, savedPath };
	};

	// 初次加载时注册虚拟模型（满足 --list-models 等离线/无会话命令）
	registerVirtualModelFromConfig(loadedConfig.config);

	// 监听会话启动，按会话工作目录加载项目级配置并恢复分支状态
	pi.on("session_start", async (_event, ctx) => {
		reloadConfigForCwd(ctx.cwd);
		const vm = loadedConfig.config.virtualModel;
		lastState = readBranchRouteState(ctx, vm.provider, vm.id);
		updateRouterStatusBar(ctx, loadedConfig.config, lastState);
		if (ctx.hasUI && loadedConfig.warnings.length > 0) {
			ctx.ui.notify(`Pi-Fusion 配置警告：${loadedConfig.warnings[0]}`, "warning");
		}
	});

	// 监听会话树切换，按目标分支恢复路由状态
	pi.on("session_tree", async (_event, ctx) => {
		const vm = loadedConfig.config.virtualModel;
		lastState = readBranchRouteState(ctx, vm.provider, vm.id);
		updateRouterStatusBar(ctx, loadedConfig.config, lastState);
	});

	// 监听模型选择切换，及时更新或清理状态栏
	pi.on("model_select", async (_event, ctx) => {
		updateRouterStatusBar(ctx, loadedConfig.config, lastState);
	});

	// 监听会话关闭，清理状态栏与内存会话状态
	pi.on("session_shutdown", async (_event, ctx) => {
		lastState = undefined;
		if (ctx.hasUI) {
			ctx.ui.setStatus("fusion-router", undefined);
		}
	});

	// 监听物理模型最终响应：成功清除冷却，失败记录故障
	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;
		const key = modelKey(msg.provider, msg.model);

		if (msg.stopReason === "error") {
			healthTracker.reportFailure(key, msg.stopReason, msg.errorMessage, loadedConfig.config.health);
		} else if (msg.stopReason === "stop" || msg.stopReason === "toolUse" || msg.stopReason === "length") {
			healthTracker.reportSuccess(key);
		}
		updateRouterStatusBar(ctx, loadedConfig.config, lastState);
	});

	registerFusionCommands(pi, {
		getLoadedConfig: () => loadedConfig,
		reloadConfig: reloadConfigForCwd,
		updateAndSaveConfig,
		getHealthTracker: () => healthTracker,
		getLastState: () => lastState,
	});
}
