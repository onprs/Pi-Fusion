import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildCandidatePool, discoverCandidatesFromRegistry } from "./catalog.ts";
import {
	buildClassifierContext,
	buildClassifierInputSummary,
	readPiClassifierEndpointHints,
	resolveClassifierChain,
	runClassifierDecision,
} from "./classifier.ts";
import { parseModelKey } from "./config.ts";
import { resolveThinkingLevel } from "./effort.ts";
import type { ModelHealthTracker } from "./health.ts";
import type { FusionRouteState, FusionRouterConfig, LoadedConfigResult } from "./types.ts";
import { openFusionSettingsPanel, updateRouterStatusBar } from "./ui.ts";

export interface FusionCommandRuntime {
	getLoadedConfig: () => LoadedConfigResult;
	reloadConfig: (cwd?: string) => LoadedConfigResult;
	updateAndSaveConfig: (
		patch: Partial<FusionRouterConfig>,
		scope?: "global" | "project",
	) => { config: FusionRouterConfig; savedPath: string };
	getHealthTracker: () => ModelHealthTracker;
	getLastState: () => FusionRouteState | undefined;
}

const SUBCOMMANDS = [
	{ value: "status", label: "status", description: "查看路由器当前状态与配置摘要" },
	{ value: "explain", label: "explain", description: "查看最近一次路由决策的完整诊断详情" },
	{ value: "config", label: "config", description: "打开交互式路由设置面板" },
	{ value: "models", label: "models", description: "查看或自动导入候选物理模型池" },
	{ value: "classifier", label: "classifier", description: "查看或切换专用决策分类器" },
	{ value: "health", label: "health", description: "查看或重置模型健康冷却状态" },
	{ value: "mode", label: "mode", description: "切换运行模式 (auto / observe / on / off)" },
	{ value: "enable", label: "enable", description: "启用动态路由" },
	{ value: "disable", label: "disable", description: "停用动态路由" },
	{ value: "reload", label: "reload", description: "重新加载配置文件" },
	{ value: "test", label: "test", description: "执行一次干跑路由测试" },
];

function formatDurationSeconds(ms: number): string {
	return `${Math.ceil(ms / 1000)}s`;
}

function sendCommandOutput(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
	} else {
		console.log(text);
	}
}

async function handleStatus(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): Promise<void> {
	const loaded = runtime.getLoadedConfig();
	const config = loaded.config;
	const state = runtime.getLastState();
	const pool = buildCandidatePool({
		modelRegistry: ctx.modelRegistry,
		config,
		healthTracker: runtime.getHealthTracker(),
		currentModelKey: state?.selectedModel,
	});
	const classifiers = await resolveClassifierChain(ctx.modelRegistry, config.classifier);

	const lines = [
		`Pi-Fusion 路由状态`,
		`开关: ${config.enabled ? "已启用" : "已停用"} | 模式: ${config.mode}`,
		`虚拟模型: ${config.virtualModel.provider}/${config.virtualModel.id}`,
		`决策分类器: ${classifiers.length > 0 ? classifiers[0]!.key : "未检测到可用分类器"} (备选 ${Math.max(0, classifiers.length - 1)} 个)`,
		`候选物理池: 共 ${pool.allResolved.length} 个 (健康 ${pool.healthy.length} 个${pool.discoveredFromRegistry ? "，自动发现" : ""})`,
		`全局配置: ${loaded.globalPath}${loaded.globalExists ? " [存在]" : " [未创建]"}`,
		`项目配置: ${loaded.projectPath}${loaded.projectExists ? " [存在]" : " [未创建]"}`,
	];

	if (state) {
		lines.push(
			`当前路由: ${state.selectedModel} (${state.thinkingLevel})`,
			`最近触发: ${state.lastDecision.trigger} — ${state.lastDecision.reason}`,
		);
	}
	sendCommandOutput(ctx, lines.join("\n"));
}

function handleExplain(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): void {
	const state = runtime.getLastState();
	if (!state) {
		sendCommandOutput(ctx, "当前会话尚无路由决策记录。");
		return;
	}

	const d = state.lastDecision;
	const lines = [
		`最近一次路由决策详情`,
		`派发模型: ${d.model} (${d.thinkingLevel})`,
		`触发类型: ${d.trigger}`,
		`决策说明: ${d.reason}`,
	];

	if (d.classifierModel) {
		lines.push(`决策分类器: ${d.classifierModel}${d.latencyMs !== undefined ? ` (${d.latencyMs}ms)` : ""}`);
	}
	if (d.recommendedModel) {
		const confText = d.confidence !== undefined ? ` (置信度 ${Math.round(d.confidence * 100)}%)` : "";
		lines.push(`分类器推荐: ${d.recommendedModel}${confText}`);
	}
	if (d.switchBenefit) {
		const benefitConf =
			d.switchBenefitConfidence !== undefined ? ` (置信度 ${Math.round(d.switchBenefitConfidence * 100)}%)` : "";
		lines.push(`切换收益评估: ${d.switchBenefit}${benefitConf}`);
	}

	lines.push(
		`当前轮次统计: 延续步数 ${state.continuationSteps} | 连续工具错误 ${state.consecutiveToolErrors}`,
		`已尝试模型: ${state.attemptedModels.join(", ") || "无"}`,
	);

	sendCommandOutput(ctx, lines.join("\n"));
}

async function handleClassifier(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	restArgs: string,
): Promise<void> {
	const loaded = runtime.getLoadedConfig();
	const config = loaded.config;
	const arg = restArgs.trim();

	if (arg === "import") {
		const hints = readPiClassifierEndpointHints();
		if (!hints.baseUrl) {
			sendCommandOutput(ctx, "未在全局 settings.json 中检测到可导入的分类器端点设置。", "warning");
			return;
		}
		const { config: updated, savedPath } = runtime.updateAndSaveConfig({
			classifier: {
				...config.classifier,
				provider: "auto",
				model: hints.model || config.classifier.model,
				customEndpoint: {
					...config.classifier.customEndpoint,
					baseUrl: hints.baseUrl,
					importFromPiClassifier: true,
				},
			},
		});
		updateRouterStatusBar(ctx, updated, runtime.getLastState());
		sendCommandOutput(ctx, `已导入分类器端点 ${hints.baseUrl}（已保存至 ${savedPath}）`);
		return;
	}

	if (arg === "auto") {
		const { config: updated, savedPath } = runtime.updateAndSaveConfig({
			classifier: {
				...config.classifier,
				provider: "auto",
			},
		});
		updateRouterStatusBar(ctx, updated, runtime.getLastState());
		sendCommandOutput(ctx, `已将决策分类器切换为 auto 自动发现（已保存至 ${savedPath}）`);
		return;
	}

	if (arg) {
		const parsed = parseModelKey(arg);
		if (!parsed) {
			sendCommandOutput(ctx, "用法: /fusion classifier [auto | import | <provider/model>]", "warning");
			return;
		}
		const { config: updated, savedPath } = runtime.updateAndSaveConfig({
			classifier: {
				...config.classifier,
				provider: parsed.provider,
				model: parsed.id,
			},
		});
		updateRouterStatusBar(ctx, updated, runtime.getLastState());
		sendCommandOutput(
			ctx,
			`已将决策分类器设置为 ${updated.classifier.provider}/${updated.classifier.model}（已保存至 ${savedPath}）`,
		);
		return;
	}

	const chain = await resolveClassifierChain(ctx.modelRegistry, config.classifier);
	const lines = [
		`决策分类器配置: ${config.classifier.provider}/${config.classifier.model} (超时 ${config.classifier.timeoutMs}ms，最低置信度 ${config.classifier.minConfidence})`,
	];
	if (chain.length === 0) {
		lines.push("当前未检测到已配置凭据的专用决策分类器模型。");
	} else {
		lines.push(`可用分类器链 (${chain.length} 个):`);
		for (let i = 0; i < chain.length; i++) {
			const item = chain[i]!;
			lines.push(`${i + 1}. ${item.key} [${item.source}]`);
		}
	}
	sendCommandOutput(ctx, lines.join("\n"));
}

function handleModels(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime, restArgs: string): void {
	const loaded = runtime.getLoadedConfig();
	const config = loaded.config;
	const sub = restArgs.trim().toLowerCase();

	if (sub === "import") {
		const available = ctx.modelRegistry.getAvailable();
		const discovered = discoverCandidatesFromRegistry(available);
		if (discovered.length === 0) {
			sendCommandOutput(ctx, "未发现可导入的已认证物理模型。", "warning");
			return;
		}
		const { savedPath } = runtime.updateAndSaveConfig({ models: discovered });
		sendCommandOutput(ctx, `已导入 ${discovered.length} 个候选物理模型并保存至 ${savedPath}`);
		return;
	}

	const state = runtime.getLastState();
	const healthTracker = runtime.getHealthTracker();
	const pool = buildCandidatePool({
		modelRegistry: ctx.modelRegistry,
		config,
		healthTracker,
		currentModelKey: state?.selectedModel,
	});

	if (pool.allResolved.length === 0) {
		sendCommandOutput(ctx, "当前没有可用的已认证物理模型。", "warning");
		return;
	}

	const lines = [
		`候选物理模型池 (${pool.allResolved.length} 个，${pool.discoveredFromRegistry ? "自动发现，可执行 /fusion models import 保存定制" : "配置文件"}):`,
	];
	for (const c of pool.allResolved) {
		const health = healthTracker.getSnapshot(c.key, config.health);
		const healthLabel = health.status === "cooldown"
			? `冷却 ${formatDurationSeconds(health.remainingCooldownMs)}`
			: "健康";
		const ctxK = Math.round(c.contextWindow / 1000);
		lines.push(
			`- ${c.key} | ${c.profile.costTier} | P${c.profile.priority} | ${ctxK}k | ${c.model.reasoning ? "推理" : "非推理"} | ${healthLabel}`,
		);
	}
	sendCommandOutput(ctx, lines.join("\n"));
}

function handleHealth(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime, restArgs: string): void {
	const loaded = runtime.getLoadedConfig();
	const config = loaded.config;
	const tracker = runtime.getHealthTracker();
	const tokens = restArgs.trim().split(/\s+/).filter(Boolean);

	if (tokens[0] === "reset") {
		const target = tokens[1];
		tracker.reset(target);
		sendCommandOutput(ctx, target ? `已重置模型健康状态: ${target}` : "已重置全部模型健康状态。");
		return;
	}

	const pool = buildCandidatePool({
		modelRegistry: ctx.modelRegistry,
		config,
		healthTracker: tracker,
	});
	const keys = pool.allResolved.map((c) => c.key);
	const snapshots = tracker.listSnapshots(keys, config.health);

	if (snapshots.length === 0) {
		sendCommandOutput(ctx, "暂无已追踪的模型健康记录。");
		return;
	}

	const lines = ["模型健康状态:"];
	for (const s of snapshots) {
		if (s.status === "healthy") {
			lines.push(`- ${s.key}: 健康`);
		} else if (s.status === "cooldown") {
			lines.push(
				`- ${s.key}: 冷却中 (${formatDurationSeconds(s.remainingCooldownMs)}，连续失败 ${s.consecutiveFailures} 次，${s.lastSummary ?? "异常"})`,
			);
		} else {
			lines.push(`- ${s.key}: 待恢复探测 (历史失败 ${s.consecutiveFailures} 次)`);
		}
	}
	sendCommandOutput(ctx, lines.join("\n"));
}

async function handleTest(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime, promptText: string): Promise<void> {
	const loaded = runtime.getLoadedConfig();
	const config = loaded.config;
	const pool = buildCandidatePool({
		modelRegistry: ctx.modelRegistry,
		config,
		healthTracker: runtime.getHealthTracker(),
	});

	if (pool.forDecision.length === 0) {
		sendCommandOutput(ctx, "没有可用于测试的候选模型。", "warning");
		return;
	}

	const classifiers = await resolveClassifierChain(ctx.modelRegistry, config.classifier);
	if (classifiers.length === 0) {
		sendCommandOutput(ctx, "未检测到可用的专用分类器模型。", "warning");
		return;
	}

	const samplePrompt = promptText.trim() || "请帮我重构一个多模块异步任务调度器并补充单元测试";
	const summary = buildClassifierInputSummary({
		messages: [{ role: "user", content: samplePrompt, timestamp: Date.now() }],
		turnStepCount: 0,
		consecutiveToolErrors: 0,
	});
	const classifierContext = buildClassifierContext({
		summary,
		candidates: pool.forDecision,
		efforts: config.efforts,
		preferences: config.preferences,
		includeSwitchBenefit: false,
	});

	const decision = await runClassifierDecision({
		modelRegistry: ctx.modelRegistry,
		classifiers,
		context: classifierContext,
		timeoutMs: config.classifier.timeoutMs,
	});

	if (!decision) {
		sendCommandOutput(ctx, "分类器测试调用失败或超时，请检查网络连接与凭据。", "warning");
		return;
	}

	const matched = pool.forDecision.find((c) => c.key === decision.selectedModelKey);
	const resolvedThinking = matched
		? resolveThinkingLevel({
				physicalModel: matched.model,
				profile: matched.profile,
				requestedThinkingLevel: ctx.model?.reasoning ? "medium" : "off",
				classifierEffortLabel: decision.effortLabel,
				thinkingMode: config.thinkingMode,
			})
		: decision.effortLabel;

	const lines = [
		`干跑路由测试结果:`,
		`测试输入: ${samplePrompt}`,
		`分类器: ${decision.classifierModelKey} (${decision.latencyMs}ms)`,
		`推荐模型: ${decision.selectedModelKey} (置信度 ${Math.round(decision.selectedModelConfidence * 100)}%)`,
		`思考强度: ${decision.effortLabel} → 适配后 ${resolvedThinking}`,
	];
	sendCommandOutput(ctx, lines.join("\n"));
}

/** 注册 /fusion 与 /router 斜杠命令 */
export function registerFusionCommands(pi: ExtensionAPI, runtime: FusionCommandRuntime): void {
	const commandDef = {
		description: "查看和配置 Pi-Fusion 多模型动态路由器",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trim().toLowerCase();
			if (trimmed.startsWith("mode ")) {
				const sub = trimmed.slice(5);
				return ["auto", "observe", "on", "off"]
					.filter((v) => v.startsWith(sub))
					.map((v) => ({ value: `mode ${v}`, label: `mode ${v}` }));
			}
			if (trimmed.startsWith("models ")) {
				return [{ value: "models import", label: "models import", description: "导入当前可用物理模型到配置文件" }];
			}
			if (trimmed.startsWith("classifier ")) {
				return [
					{ value: "classifier auto", label: "classifier auto", description: "自动发现可用分类器" },
					{ value: "classifier import", label: "classifier import", description: "导入全局分类器端点设置" },
				];
			}
			if (trimmed.startsWith("health ")) {
				return [{ value: "health reset", label: "health reset", description: "清除冷却记录" }];
			}
			return SUBCOMMANDS.filter((item) => item.value.startsWith(trimmed));
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const trimmed = args.trim();
			const firstSpace = trimmed.indexOf(" ");
			const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
			const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

			if (!sub || sub === "config") {
				if (ctx.hasUI) {
					await openFusionSettingsPanel(ctx, {
						getConfig: () => runtime.getLoadedConfig().config,
						getAvailableClassifierProviders: async () => {
							const classifiers = await ctx.modelRegistry.getAvailableOfType("classifier");
							return Array.from(new Set(classifiers.map((c) => c.provider)));
						},
						getSaveScope: () => (runtime.getLoadedConfig().projectExists ? "project" : "global"),
						onApplyPatch: (patch, scope) => {
							const { config } = runtime.updateAndSaveConfig(patch, scope);
							return config;
						},
					});
					return;
				}
				await handleStatus(ctx, runtime);
				return;
			}

			switch (sub) {
				case "status":
					await handleStatus(ctx, runtime);
					return;
				case "explain":
				case "last":
					handleExplain(ctx, runtime);
					return;
				case "models":
					handleModels(ctx, runtime, rest);
					return;
				case "classifier":
					await handleClassifier(ctx, runtime, rest);
					return;
				case "health":
					handleHealth(ctx, runtime, rest);
					return;
				case "mode": {
					const modeArg = rest.toLowerCase();
					if (modeArg === "on") {
						const { config, savedPath } = runtime.updateAndSaveConfig({ enabled: true });
						updateRouterStatusBar(ctx, config, runtime.getLastState());
						sendCommandOutput(ctx, `已启用 Pi-Fusion 动态路由（已保存至 ${savedPath}）`);
						return;
					}
					if (modeArg === "off") {
						const { config, savedPath } = runtime.updateAndSaveConfig({ enabled: false });
						updateRouterStatusBar(ctx, config, runtime.getLastState());
						sendCommandOutput(ctx, `已停用 Pi-Fusion 动态路由（已保存至 ${savedPath}）`);
						return;
					}
					if (modeArg !== "auto" && modeArg !== "observe") {
						sendCommandOutput(ctx, "用法: /fusion mode <auto|observe|on|off>", "warning");
						return;
					}
					const { config, savedPath } = runtime.updateAndSaveConfig({ mode: modeArg });
					updateRouterStatusBar(ctx, config, runtime.getLastState());
					sendCommandOutput(ctx, `已切换运行模式为 ${config.mode}（已保存至 ${savedPath}）`);
					return;
				}
				case "enable": {
					const { config, savedPath } = runtime.updateAndSaveConfig({ enabled: true });
					updateRouterStatusBar(ctx, config, runtime.getLastState());
					sendCommandOutput(ctx, `已启用 Pi-Fusion 动态路由（已保存至 ${savedPath}）`);
					return;
				}
				case "disable": {
					const { config, savedPath } = runtime.updateAndSaveConfig({ enabled: false });
					updateRouterStatusBar(ctx, config, runtime.getLastState());
					sendCommandOutput(ctx, `已停用 Pi-Fusion 动态路由（已保存至 ${savedPath}）`);
					return;
				}
				case "reload": {
					const loaded = runtime.reloadConfig(ctx.cwd);
					updateRouterStatusBar(ctx, loaded.config, runtime.getLastState());
					const warningNote = loaded.warnings.length > 0
						? `\n警告 (${loaded.warnings.length}): ${loaded.warnings.join("; ")}`
						: "";
					sendCommandOutput(ctx, `已重新加载 Pi-Fusion 配置。${warningNote}`);
					return;
				}
				case "test":
					await handleTest(ctx, runtime, rest);
					return;
				default:
					sendCommandOutput(
						ctx,
						"未知子命令。可用命令: status, explain, config, models, classifier, health, mode, enable, disable, reload, test",
						"warning",
					);
			}
		},
	};

	pi.registerCommand("fusion", commandDef);
	pi.registerCommand("router", commandDef);
}
