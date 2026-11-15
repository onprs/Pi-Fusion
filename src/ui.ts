import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { STATUS_BAR_KEY } from "./constants.ts";
import type { FusionRouteState, FusionRouterConfig, RouteTrigger } from "./types.ts";

/** 更新状态栏中的路由器状态 */
export function updateRouterStatusBar(
	ctx: Pick<ExtensionContext, "hasUI" | "ui" | "model">,
	config: FusionRouterConfig,
	state?: FusionRouteState,
): void {
	if (!ctx.hasUI) return;
	if (!config.ui.showStatusBar) {
		ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
		return;
	}

	const selectedIsFusion =
		ctx.model?.provider === config.virtualModel.provider &&
		ctx.model?.id === config.virtualModel.id;

	if (!selectedIsFusion) {
		ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	if (!config.enabled) {
		ctx.ui.setStatus(STATUS_BAR_KEY, theme.fg("dim", "Fusion: 已停用"));
		return;
	}

	if (!state) {
		const modeLabel = config.mode === "observe" ? " [观察]" : "";
		ctx.ui.setStatus(STATUS_BAR_KEY, theme.fg("dim", `Fusion${modeLabel}: 就绪`));
		return;
	}

	const modePrefix = config.mode === "observe" ? "Fusion [观察]" : "Fusion";
	const summary = `${modePrefix}: ${state.selectedModel} (${state.thinkingLevel})`;
	if (state.lastDecision.trigger === "failover") {
		ctx.ui.setStatus(STATUS_BAR_KEY, theme.fg("warning", summary));
		return;
	}
	ctx.ui.setStatus(STATUS_BAR_KEY, theme.fg("accent", summary));
}

/** 根据配置决定是否弹出切换或故障转移通知 */
export function notifyRouteTransition(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	config: FusionRouterConfig,
	info: {
		selectedModel: string;
		thinkingLevel: string;
		switchedFrom?: string;
		trigger: RouteTrigger;
		reason: string;
	},
): void {
	if (!ctx.hasUI) return;

	if (info.trigger === "failover" && config.ui.notifyOnFailover) {
		const fromText = info.switchedFrom ? `${info.switchedFrom} → ` : "";
		ctx.ui.notify(
			`模型故障转移：${fromText}${info.selectedModel} (${info.thinkingLevel})`,
			"warning",
		);
		return;
	}

	if (info.switchedFrom && config.ui.notifyOnSwitch) {
		ctx.ui.notify(
			`模型已切换：${info.switchedFrom} → ${info.selectedModel} (${info.thinkingLevel})`,
			"info",
		);
	}
}

export interface ConfigPanelCallbacks {
	getConfig: () => FusionRouterConfig;
	getAvailableClassifierProviders: () => Promise<string[]>;
	getSaveScope: () => "global" | "project";
	onApplyPatch: (patch: Partial<FusionRouterConfig>, scope: "global" | "project") => FusionRouterConfig;
}

/** 打开交互式 TUI 配置面板 */
export async function openFusionSettingsPanel(
	ctx: ExtensionContext,
	callbacks: ConfigPanelCallbacks,
): Promise<void> {
	if (!ctx.hasUI) return;

	const initial = callbacks.getConfig();
	const providers = await callbacks.getAvailableClassifierProviders();
	const classifierChoices = Array.from(new Set(["auto", initial.classifier.provider, ...providers]));
	let activeScope: "global" | "project" = callbacks.getSaveScope();

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const title = new Text(theme.fg("accent", theme.bold("Pi-Fusion 路由设置")), 1, 0);
		const subtitle = new Text(
			theme.fg("dim", "使用方向键选择，Enter/Space 切换选项，Esc 关闭面板"),
			1,
			0,
		);

		const boolLabel = (value: boolean): string => (value ? "开启" : "关闭");
		const scopeLabel = (scope: "global" | "project"): string =>
			scope === "project" ? "项目配置 (.pi)" : "全局配置 (~/.pi)";

		const buildItems = (cfg: FusionRouterConfig): SettingItem[] => [
			{
				id: "enabled",
				label: "路由器总开关",
				description: "关闭后将始终派发默认模型，不执行智能选路",
				currentValue: boolLabel(cfg.enabled),
				values: ["开启", "关闭"],
			},
			{
				id: "mode",
				label: "运行模式",
				description: "auto 自动派发决策模型；observe 仅记录决策但派发默认模型",
				currentValue: cfg.mode,
				values: ["auto", "observe"],
			},
			{
				id: "classifierProvider",
				label: "决策分类器提供商",
				description: "选择专用决策模型提供商，auto 按内置优先级自动发现",
				currentValue: cfg.classifier.provider,
				values: classifierChoices,
			},
			{
				id: "thinkingMode",
				label: "思考强度模式",
				description: "auto 由分类器决定；passthrough 透传用户选择；profile-default 使用模型默认",
				currentValue: cfg.thinkingMode,
				values: ["auto", "passthrough", "profile-default"],
			},
			{
				id: "stickyDuringToolLoop",
				label: "工具循环粘性保持",
				description: "工具调用返回后优先保持当前模型以保护 Prompt 缓存",
				currentValue: boolLabel(cfg.redecision.stickyDuringToolLoop),
				values: ["开启", "关闭"],
			},
			{
				id: "autoFailover",
				label: "故障自动转移",
				description: "限流、超时或上游不可用时自动冷却并切换健康备用模型",
				currentValue: boolLabel(cfg.health.autoFailover),
				values: ["开启", "关闭"],
			},
			{
				id: "showStatusBar",
				label: "状态栏显示",
				description: "在底部状态栏展示当前选路模型与思考强度",
				currentValue: boolLabel(cfg.ui.showStatusBar),
				values: ["开启", "关闭"],
			},
			{
				id: "notifyOnSwitch",
				label: "切换模型通知",
				description: "模型发生切换时弹出提示消息",
				currentValue: boolLabel(cfg.ui.notifyOnSwitch),
				values: ["开启", "关闭"],
			},
			{
				id: "notifyOnFailover",
				label: "故障转移通知",
				description: "发生故障冷却并自动切换时弹出告警消息",
				currentValue: boolLabel(cfg.ui.notifyOnFailover),
				values: ["开启", "关闭"],
			},
			{
				id: "saveScope",
				label: "配置保存位置",
				description: "选择修改后写入全局配置还是当前项目配置",
				currentValue: scopeLabel(activeScope),
				values: ["全局配置 (~/.pi)", "项目配置 (.pi)"],
			},
		];

		const settingsList = new SettingsList(
			buildItems(initial),
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				const current = callbacks.getConfig();
				const toBool = (v: string): boolean => v === "开启";

				if (id === "saveScope") {
					activeScope = newValue.startsWith("项目") ? "project" : "global";
					settingsList.updateValue(id, scopeLabel(activeScope));
					tui.requestRender();
					return;
				}

				let updated = current;
				switch (id) {
					case "enabled":
						updated = callbacks.onApplyPatch({ enabled: toBool(newValue) }, activeScope);
						break;
					case "mode":
						updated = callbacks.onApplyPatch({ mode: newValue as FusionRouterConfig["mode"] }, activeScope);
						break;
					case "classifierProvider":
						updated = callbacks.onApplyPatch(
							{ classifier: { ...current.classifier, provider: newValue } },
							activeScope,
						);
						break;
					case "thinkingMode":
						updated = callbacks.onApplyPatch(
							{ thinkingMode: newValue as FusionRouterConfig["thinkingMode"] },
							activeScope,
						);
						break;
					case "stickyDuringToolLoop":
						updated = callbacks.onApplyPatch(
							{ redecision: { ...current.redecision, stickyDuringToolLoop: toBool(newValue) } },
							activeScope,
						);
						break;
					case "autoFailover":
						updated = callbacks.onApplyPatch(
							{ health: { ...current.health, autoFailover: toBool(newValue) } },
							activeScope,
						);
						break;
					case "showStatusBar":
						updated = callbacks.onApplyPatch(
							{ ui: { ...current.ui, showStatusBar: toBool(newValue) } },
							activeScope,
						);
						break;
					case "notifyOnSwitch":
						updated = callbacks.onApplyPatch(
							{ ui: { ...current.ui, notifyOnSwitch: toBool(newValue) } },
							activeScope,
						);
						break;
					case "notifyOnFailover":
						updated = callbacks.onApplyPatch(
							{ ui: { ...current.ui, notifyOnFailover: toBool(newValue) } },
							activeScope,
						);
						break;
				}
				updateRouterStatusBar(ctx, updated);
				tui.requestRender();
			},
			() => {
				done();
			},
		);

		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(title);
		container.addChild(subtitle);
		container.addChild(new Spacer(1));
		container.addChild(settingsList);
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
