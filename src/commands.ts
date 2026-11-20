import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildCandidatePool, discoverCandidatesFromRegistry, isVirtualCatalogModel } from "./catalog.ts";
import {
	buildClassifierContext,
	buildClassifierInputSummary,
	readPiClassifierEndpointHints,
	resolveClassifierChain,
	resolveCustomClassifierTarget,
	runClassifierDecision,
} from "./classifier.ts";
import { modelKey, parseModelKey } from "./config.ts";
import { MAX_CLASSIFIER_TIMEOUT_MS, MIN_CLASSIFIER_TIMEOUT_MS } from "./constants.ts";
import { resolveThinkingLevel } from "./effort.ts";
import type { ModelHealthTracker } from "./health.ts";
import type {
	CandidateModelPatch,
	CandidateModelProfile,
	CostTier,
	DiscoveredClassifier,
	FusionRouteState,
	FusionRouterConfig,
	LoadedConfigResult,
	PartialFusionRouterConfig,
	SupportedClassifierApi,
} from "./types.ts";
import {
	classifierChoiceToPatch,
	type DetailTone,
	formatClassifierChoice,
	type MenuPanelItem,
	openFusionSettingsPanel,
	openTabbedSplitWorkspace,
	selectMenuPanel,
	type SummarySegment,
	updateRouterStatusBar,
	type WorkspaceItem,
} from "./ui.ts";

type SaveScope = "global" | "project";

interface ScopeRef {
	value: SaveScope;
}

export interface FusionCommandRuntime {
	getLoadedConfig: () => LoadedConfigResult;
	reloadConfig: (cwd?: string) => LoadedConfigResult;
	updateAndSaveConfig: (
		patch: PartialFusionRouterConfig,
		scope?: SaveScope,
	) => { config: FusionRouterConfig; savedPath: string };
	getHealthTracker: () => ModelHealthTracker;
	getLastState: () => FusionRouteState | undefined;
}

const SUBCOMMANDS = [
	{ value: "status", label: "status", description: "查看路由器当前状态与配置摘要" },
	{ value: "explain", label: "explain", description: "查看最近一次路由决策的完整诊断详情" },
	{ value: "config", label: "config", description: "打开分区式路由策略与界面设置面板" },
	{ value: "models", label: "models", description: "管理候选物理模型池" },
	{ value: "classifier", label: "classifier", description: "查看或配置专用决策分类器" },
	{ value: "health", label: "health", description: "查看或管理模型健康冷却状态" },
	{ value: "mode", label: "mode", description: "切换运行模式 (auto / observe / on / off)" },
	{ value: "enable", label: "enable", description: "启用动态路由" },
	{ value: "disable", label: "disable", description: "停用动态路由" },
	{ value: "reload", label: "reload", description: "重新加载配置文件" },
	{ value: "test", label: "test", description: "执行一次干跑路由测试" },
];

const MODELS_SUBCOMMANDS = [
	{ value: "list", description: "列出候选模型池及健康状态" },
	{ value: "import", description: "导入当前已认证物理模型到配置文件" },
	{ value: "enable", description: "启用候选模型" },
	{ value: "disable", description: "停用候选模型" },
	{ value: "default", description: "设置或清除默认回退模型" },
	{ value: "set", description: "修改候选模型画像字段" },
];

const CLASSIFIER_SUBCOMMANDS = [
	{ value: "list", description: "列出可用决策分类器链" },
	{ value: "auto", description: "自动发现可用分类器" },
	{ value: "import", description: "导入全局分类器端点设置" },
	{ value: "endpoint", description: "配置或清除自定义决策端点" },
];

const HEALTH_SUBCOMMANDS = [
	{ value: "manage", description: "打开模型健康与冷却管理面板" },
	{ value: "reset", description: "重置单个或全部模型的冷却记录" },
];

const PROFILE_FIELDS = ["priority", "costTier", "thinking", "specialty", "avoid", "label"] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

const COST_TIERS: readonly CostTier[] = ["budget", "balanced", "premium"];
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLASSIFIER_APIS: readonly SupportedClassifierApi[] = [
	"typesafe-system-one",
	"cloudflare-workers-ai-system-one",
	"openai-decisions",
];

const DEFAULT_TEST_PROMPT = "请帮我重构一个多模块异步任务调度器并补充单元测试";

const MODELS_USAGE = [
	"用法:",
	"/fusion models [list]",
	"/fusion models import",
	"/fusion models enable|disable <provider/model>",
	"/fusion models default <provider/model|clear>",
	"/fusion models set <provider/model> <priority|costTier|thinking|specialty|avoid|label> <值>",
].join("\n");

const CLASSIFIER_USAGE = [
	"用法:",
	"/fusion classifier [list]",
	"/fusion classifier auto",
	"/fusion classifier <provider/model>",
	"/fusion classifier import",
	"/fusion classifier endpoint <baseUrl> [api] [密钥环境变量]",
	"/fusion classifier endpoint clear",
].join("\n");

function formatDurationSeconds(ms: number): string {
	return `${Math.ceil(ms / 1000)}s`;
}

function boolText(value: boolean): string {
	return value ? "开启" : "关闭";
}

function boolTone(value: boolean): DetailTone {
	return value ? "success" : "dim";
}

function shortModelLabel(key: string): string {
	return parseModelKey(key)?.id ?? key;
}

function scopeLabel(scope: SaveScope): string {
	return scope === "project" ? "项目配置" : "全局配置";
}

function buildHeaderBadge(config: FusionRouterConfig, scope: SaveScope): { text: string; tone: DetailTone } {
	if (!config.enabled) {
		return { text: `○ 已停用 · ${scopeLabel(scope)}`, tone: "dim" };
	}
	return config.mode === "observe"
		? { text: `● 观察 · ${scopeLabel(scope)}`, tone: "warning" }
		: { text: `● 自动 · ${scopeLabel(scope)}`, tone: "success" };
}

function defaultSaveScope(runtime: FusionCommandRuntime): SaveScope {
	return runtime.getLoadedConfig().projectExists ? "project" : "global";
}

function cycleString<T extends string>(current: T, list: readonly T[]): T {
	const idx = list.indexOf(current);
	return list[(idx + 1) % list.length]!;
}

function sendCommandOutput(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(text, level);
	} else {
		console.log(text);
	}
}

/** 保存配置补丁并输出结果；保存失败时输出错误并返回 undefined */
function applyConfigPatch(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	patch: PartialFusionRouterConfig,
	describe: (config: FusionRouterConfig, savedPath: string) => string,
	scope?: SaveScope,
): FusionRouterConfig | undefined {
	try {
		const { config, savedPath } = runtime.updateAndSaveConfig(patch, scope);
		updateRouterStatusBar(ctx, config, runtime.getLastState());
		sendCommandOutput(ctx, describe(config, savedPath));
		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		sendCommandOutput(ctx, `保存配置失败：${message}`, "error");
		return undefined;
	}
}

function reloadConfiguration(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): LoadedConfigResult {
	const loaded = runtime.reloadConfig(ctx.cwd);
	updateRouterStatusBar(ctx, loaded.config, runtime.getLastState());
	const warningNote = loaded.warnings.length > 0
		? `\n警告 (${loaded.warnings.length}): ${loaded.warnings.join("; ")}`
		: "";
	sendCommandOutput(ctx, `已重新加载 Pi-Fusion 配置。${warningNote}`);
	return loaded;
}

// ───────────────────────── 状态与决策详情构建 ─────────────────────────

function buildStatusLinesFromChain(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	classifiers: readonly DiscoveredClassifier[],
): string[] {
	const loaded = runtime.getLoadedConfig();
	const config = loaded.config;
	const state = runtime.getLastState();
	const healthTracker = runtime.getHealthTracker();
	const pool = buildCandidatePool({
		modelRegistry: ctx.modelRegistry,
		config,
		healthTracker,
		currentModelKey: state?.selectedModel,
	});
	const custom = resolveCustomClassifierTarget(config.classifier);
	const cooling = healthTracker
		.listSnapshots(pool.allResolved.map((c) => c.key), config.health)
		.filter((s) => s.status === "cooldown");

	const lines = [
		`Pi-Fusion 路由状态`,
		`开关: ${config.enabled ? "已启用" : "已停用"} | 模式: ${config.mode}`,
		`虚拟模型: ${config.virtualModel.provider}/${config.virtualModel.id}`,
		`决策分类器: ${classifiers.length > 0 ? classifiers[0]!.key : "未检测到可用分类器"} (备选 ${Math.max(0, classifiers.length - 1)} 个)`,
	];
	if (custom) {
		lines.push(`自定义决策端点: ${custom.baseUrl} (${custom.api})`);
	}
	lines.push(
		`候选物理池: 共 ${pool.allResolved.length} 个 (可用 ${pool.allResolved.length - cooling.length} 个${pool.discoveredFromRegistry ? "，自动发现" : ""})`,
	);
	for (const s of cooling) {
		lines.push(`  冷却中: ${s.key} (剩余 ${formatDurationSeconds(s.remainingCooldownMs)}，${s.lastSummary ?? "异常"})`);
	}
	lines.push(
		`全局配置: ${loaded.globalPath}${loaded.globalExists ? " [存在]" : " [未创建]"}`,
		`项目配置: ${loaded.projectPath}${loaded.projectExists ? " [存在]" : " [未创建]"}`,
	);

	if (state) {
		lines.push(
			`当前路由: ${state.selectedModel} (${state.thinkingLevel})`,
			`最近触发: ${state.lastDecision.trigger} — ${state.lastDecision.reason}`,
		);
	}
	return lines;
}

async function buildStatusReport(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): Promise<string> {
	const classifiers = await resolveClassifierChain(ctx.modelRegistry, runtime.getLoadedConfig().config.classifier);
	return buildStatusLinesFromChain(ctx, runtime, classifiers).join("\n");
}

function buildExplainLines(state: FusionRouteState | undefined): string[] {
	if (!state) return ["当前会话尚无路由决策记录。"];

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

	return lines;
}

async function handleStatus(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): Promise<void> {
	sendCommandOutput(ctx, await buildStatusReport(ctx, runtime));
}

function handleExplain(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): void {
	sendCommandOutput(ctx, buildExplainLines(runtime.getLastState()).join("\n"));
}

// ───────────────────────── 决策分类器 ─────────────────────────

function buildClassifierLinesFromChain(config: FusionRouterConfig, chain: readonly DiscoveredClassifier[]): string[] {
	const lines = [
		`决策分类器配置: ${formatClassifierChoice(config)} (超时 ${config.classifier.timeoutMs}ms，最低置信度 ${config.classifier.minConfidence})`,
	];
	const custom = resolveCustomClassifierTarget(config.classifier);
	if (custom) {
		const keyEnv = config.classifier.customEndpoint?.apiKeyEnv;
		const envText = keyEnv ? `，密钥变量 ${keyEnv}` : "";
		lines.push(`自定义端点: ${custom.baseUrl} (${custom.api}，模型 ${custom.modelId}${envText})`);
	}
	if (chain.length === 0) {
		lines.push("当前未检测到已配置凭据的专用决策分类器模型。");
	} else {
		lines.push(`可用分类器链 (${chain.length} 个):`);
		for (let i = 0; i < chain.length; i++) {
			const item = chain[i]!;
			lines.push(`${i + 1}. ${item.key} [${item.source}]`);
		}
	}
	return lines;
}

async function buildClassifierReport(ctx: ExtensionCommandContext, config: FusionRouterConfig) {
	const chain = await resolveClassifierChain(ctx.modelRegistry, config.classifier);
	const lines = buildClassifierLinesFromChain(config, chain);
	return { text: lines.join("\n"), lines, chain, custom: resolveCustomClassifierTarget(config.classifier) };
}

async function listClassifiers(ctx: ExtensionCommandContext, config: FusionRouterConfig): Promise<void> {
	const { text } = await buildClassifierReport(ctx, config);
	sendCommandOutput(ctx, text);
}

function clearCustomClassifierEndpoint(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	config: FusionRouterConfig,
	scope?: SaveScope,
): void {
	const custom = resolveCustomClassifierTarget(config.classifier);
	const provider = config.classifier.provider;
	const resetProvider = provider === "custom" || (custom !== undefined && provider === custom.providerId);
	applyConfigPatch(
		ctx,
		runtime,
		{ classifier: { customEndpoint: null, ...(resetProvider ? { provider: "auto" } : {}) } },
		(_cfg, savedPath) => `已清除自定义决策端点（已保存至 ${savedPath}）`,
		scope,
	);
}

function importClassifierEndpoint(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scope?: SaveScope,
): void {
	const hints = readPiClassifierEndpointHints();
	if (!hints.baseUrl) {
		sendCommandOutput(ctx, "未在全局 settings.json 中检测到可导入的分类器端点设置。", "warning");
		return;
	}
	applyConfigPatch(
		ctx,
		runtime,
		{
			classifier: {
				provider: "auto",
				...(hints.model ? { model: hints.model } : {}),
				customEndpoint: { baseUrl: hints.baseUrl, importFromPiClassifier: true },
			},
		},
		(_cfg, savedPath) => `已导入分类器端点 ${hints.baseUrl}（已保存至 ${savedPath}）`,
		scope,
	);
}

function validateEndpointUrl(rawUrl: string): string | undefined {
	try {
		const url = new URL(rawUrl.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return rawUrl.trim().replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

function handleClassifierEndpoint(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	config: FusionRouterConfig,
	tokens: string[],
): void {
	const [first, second, third] = tokens;
	if (!first) {
		sendCommandOutput(ctx, CLASSIFIER_USAGE, "warning");
		return;
	}

	if (first.toLowerCase() === "clear") {
		clearCustomClassifierEndpoint(ctx, runtime, config);
		return;
	}

	const baseUrl = validateEndpointUrl(first);
	if (!baseUrl) {
		sendCommandOutput(ctx, `端点地址无效：${first}`, "warning");
		return;
	}

	let api: SupportedClassifierApi | undefined;
	let apiKeyEnv: string | undefined;
	for (const token of [second, third]) {
		if (!token) continue;
		if ((CLASSIFIER_APIS as readonly string[]).includes(token)) {
			api = token as SupportedClassifierApi;
		} else if (/^\$?[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
			apiKeyEnv = token.replace(/^\$/, "");
		} else {
			sendCommandOutput(ctx, `无法识别的参数：${token}\n可用接口类型: ${CLASSIFIER_APIS.join(", ")}`, "warning");
			return;
		}
	}

	applyConfigPatch(
		ctx,
		runtime,
		{
			classifier: {
				provider: "auto",
				customEndpoint: {
					baseUrl,
					importFromPiClassifier: false,
					...(api ? { api } : {}),
					...(apiKeyEnv ? { apiKeyEnv } : {}),
				},
			},
		},
		(cfg, savedPath) => {
			const target = resolveCustomClassifierTarget(cfg.classifier);
			const apiText = target?.api ?? api ?? "typesafe-system-one";
			return `已配置自定义决策端点 ${baseUrl} (${apiText})（已保存至 ${savedPath}）`;
		},
	);
}

/** 交互式配置自定义决策端点 */
async function configureCustomEndpointInteractive(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scope: SaveScope,
): Promise<void> {
	const current = runtime.getLoadedConfig().config.classifier.customEndpoint;
	const rawUrl = await ctx.ui.input("自定义决策端点地址（http:// 或 https://）", current?.baseUrl ?? "https://");
	if (rawUrl === undefined || !rawUrl.trim()) return;
	const baseUrl = validateEndpointUrl(rawUrl);
	if (!baseUrl) {
		sendCommandOutput(ctx, `端点地址无效：${rawUrl.trim()}`, "warning");
		return;
	}

	const apiChoice = await ctx.ui.select("选择决策端点协议类型", [...CLASSIFIER_APIS]);
	if (!apiChoice) return;
	const api = apiChoice as SupportedClassifierApi;

	const rawEnv = await ctx.ui.input(
		"密钥环境变量名（留空使用默认 CLASSIFIER_API_KEY / TYPESAFE_API_KEY）",
		current?.apiKeyEnv ?? "",
	);
	if (rawEnv === undefined) return;
	const trimmedEnv = rawEnv.trim();
	let apiKeyEnv = "";
	if (trimmedEnv) {
		if (!/^\$?[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedEnv)) {
			sendCommandOutput(ctx, `环境变量名格式无效：${trimmedEnv}`, "warning");
			return;
		}
		apiKeyEnv = trimmedEnv.replace(/^\$/, "");
	}

	applyConfigPatch(
		ctx,
		runtime,
		{
			classifier: {
				provider: "auto",
				customEndpoint: {
					baseUrl,
					api,
					apiKeyEnv,
					importFromPiClassifier: false,
				},
			},
		},
		(_cfg, savedPath) => `已配置自定义决策端点 ${baseUrl} (${api})（已保存至 ${savedPath}）`,
		scope,
	);
}

async function promptClassifierTimeout(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scope: SaveScope,
): Promise<void> {
	const config = runtime.getLoadedConfig().config;
	const raw = await ctx.ui.input(
		`分类器超时时间（${MIN_CLASSIFIER_TIMEOUT_MS}~${MAX_CLASSIFIER_TIMEOUT_MS} 毫秒）`,
		String(config.classifier.timeoutMs),
	);
	if (raw === undefined || !raw.trim()) return;
	const num = Number(raw.trim());
	if (!Number.isInteger(num) || num < MIN_CLASSIFIER_TIMEOUT_MS || num > MAX_CLASSIFIER_TIMEOUT_MS) {
		sendCommandOutput(
			ctx,
			`超时时间必须是 ${MIN_CLASSIFIER_TIMEOUT_MS}~${MAX_CLASSIFIER_TIMEOUT_MS} 的整数。`,
			"warning",
		);
		return;
	}
	applyConfigPatch(
		ctx,
		runtime,
		{ classifier: { timeoutMs: num } },
		(_cfg, savedPath) => `已将分类器超时时间设置为 ${num}ms（已保存至 ${savedPath}）`,
		scope,
	);
}

async function promptClassifierMinConfidence(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scope: SaveScope,
): Promise<void> {
	const config = runtime.getLoadedConfig().config;
	const raw = await ctx.ui.input("分类器最低置信度（0~1）", String(config.classifier.minConfidence));
	if (raw === undefined || !raw.trim()) return;
	const num = Number(raw.trim());
	if (!Number.isFinite(num) || num < 0 || num > 1) {
		sendCommandOutput(ctx, "最低置信度必须是 0~1 之间的数值。", "warning");
		return;
	}
	applyConfigPatch(
		ctx,
		runtime,
		{ classifier: { minConfidence: num } },
		(_cfg, savedPath) => `已将分类器最低置信度设置为 ${num}（已保存至 ${savedPath}）`,
		scope,
	);
}

/** 交互式决策分类器查看与管理菜单（单栏固定列表） */
async function openClassifierManager(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	options?: { scopeRef?: ScopeRef; exitOnSelectClassifier?: boolean },
): Promise<void> {
	const scopeRef: ScopeRef = options?.scopeRef ?? { value: defaultSaveScope(runtime) };
	let lastSelectedId: string | undefined;

	for (;;) {
		const config = runtime.getLoadedConfig().config;
		const { text, chain, custom } = await buildClassifierReport(ctx, config);
		const current = formatClassifierChoice(config);
		const classifierChoices = Array.from(new Set(["auto", ...chain.map((c) => c.key)]));

		const items: MenuPanelItem[] = [
			...classifierChoices.map((choice): MenuPanelItem => {
				const isCurrent = choice === current;
				const matched = chain.find((c) => c.key === choice);
				const hint =
					choice === "auto"
						? chain.length > 0
							? `自动发现 · 首选 ${chain[0]!.key}（共 ${chain.length} 个可用）`
							: "按内置优先级自动发现（当前未检测到可用分类器）"
						: `来源: ${matched?.source ?? "显式配置"}`;
				return {
					value: `cls:${choice}`,
					label: choice,
					valueBadge: isCurrent ? "当前" : undefined,
					valueTone: isCurrent ? "success" : undefined,
					hint,
					selectLabel: isCurrent ? `${choice}（当前）` : choice,
				};
			}),
			{
				value: "__configure_endpoint__",
				label: "配置自定义决策端点",
				valueBadge: custom ? "已配置" : "未配置",
				valueTone: custom ? "success" : "dim",
				hint: custom ? `${custom.baseUrl} (${custom.api})` : "配置兼容的自定义决策端点地址、协议与密钥变量",
			},
			{
				value: "__import_endpoint__",
				label: "导入全局分类器端点",
				valueBadge: "导入 ›",
				valueTone: "muted",
				hint: "从 Pi 全局 settings.json 导入 classifier 端点设置",
			},
			{
				value: "__clear_endpoint__",
				label: "清除自定义决策端点",
				valueBadge: config.classifier.customEndpoint ? "清除" : "无",
				valueTone: config.classifier.customEndpoint ? "warning" : "dim",
				hint: config.classifier.customEndpoint ? "清除自定义端点并回退自动发现" : "当前未配置自定义端点",
			},
			{
				value: "__timeout__",
				label: "超时时间",
				valueBadge: `${config.classifier.timeoutMs}ms`,
				valueTone: "text",
				hint: `范围 ${MIN_CLASSIFIER_TIMEOUT_MS}~${MAX_CLASSIFIER_TIMEOUT_MS}ms，超时后降级至备选分类器`,
			},
			{
				value: "__confidence__",
				label: "最低置信度",
				valueBadge: String(config.classifier.minConfidence),
				valueTone: "text",
				hint: "范围 0~1，低于该置信度时回退默认模型",
			},
			{
				value: "__scope__",
				label: "保存位置",
				valueBadge: scopeLabel(scopeRef.value),
				valueTone: "accent",
				hint: scopeRef.value === "project" ? "写入 .pi/fusion-router.json" : "写入 ~/.pi/agent/fusion-router.json",
			},
		];

		const picked = await selectMenuPanel(ctx, {
			title: "专用决策分类器管理",
			headerBadge: buildHeaderBadge(config, scopeRef.value),
			details: text,
			items,
			initialValue: lastSelectedId,
			listRows: 10,
		});
		if (!picked) return;
		lastSelectedId = picked;

		if (picked === "__scope__") {
			scopeRef.value = scopeRef.value === "project" ? "global" : "project";
			continue;
		}
		if (picked === "__configure_endpoint__") {
			await configureCustomEndpointInteractive(ctx, runtime, scopeRef.value);
			continue;
		}
		if (picked === "__import_endpoint__") {
			importClassifierEndpoint(ctx, runtime, scopeRef.value);
			continue;
		}
		if (picked === "__clear_endpoint__") {
			if (!config.classifier.customEndpoint) {
				sendCommandOutput(ctx, "当前未配置自定义决策端点。", "info");
				continue;
			}
			clearCustomClassifierEndpoint(ctx, runtime, config, scopeRef.value);
			continue;
		}
		if (picked === "__timeout__") {
			await promptClassifierTimeout(ctx, runtime, scopeRef.value);
			continue;
		}
		if (picked === "__confidence__") {
			await promptClassifierMinConfidence(ctx, runtime, scopeRef.value);
			continue;
		}

		if (!picked.startsWith("cls:")) continue;
		const choice = picked.slice(4);
		if (choice !== current) {
			const patch = classifierChoiceToPatch(choice);
			if (patch) {
				applyConfigPatch(
					ctx,
					runtime,
					patch,
					(cfg, savedPath) =>
						choice === "auto"
							? `已将决策分类器切换为 auto 自动发现（已保存至 ${savedPath}）`
							: `已将决策分类器设置为 ${formatClassifierChoice(cfg)}（已保存至 ${savedPath}）`,
					scopeRef.value,
				);
			}
		}
		if (options?.exitOnSelectClassifier) return;
	}
}

async function handleClassifier(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	restArgs: string,
): Promise<void> {
	const config = runtime.getLoadedConfig().config;
	const tokens = restArgs.trim().split(/\s+/).filter(Boolean);
	const sub = tokens[0]?.toLowerCase();

	if (!sub) {
		if (ctx.hasUI) {
			await openClassifierManager(ctx, runtime, { exitOnSelectClassifier: true });
		} else {
			await listClassifiers(ctx, config);
		}
		return;
	}

	switch (sub) {
		case "list":
			await listClassifiers(ctx, config);
			return;
		case "import":
			importClassifierEndpoint(ctx, runtime);
			return;
		case "endpoint":
			handleClassifierEndpoint(ctx, runtime, config, tokens.slice(1));
			return;
		default: {
			const patch = classifierChoiceToPatch(tokens[0]!);
			if (!patch) {
				sendCommandOutput(ctx, CLASSIFIER_USAGE, "warning");
				return;
			}
			applyConfigPatch(ctx, runtime, patch, (cfg, savedPath) =>
				sub === "auto"
					? `已将决策分类器切换为 auto 自动发现（已保存至 ${savedPath}）`
					: `已将决策分类器设置为 ${formatClassifierChoice(cfg)}（已保存至 ${savedPath}）`,
			);
		}
	}
}

// ───────────────────────── 候选模型管理 ─────────────────────────

interface ManagedModelEntry {
	key: string;
	profile: CandidateModelProfile;
	available: boolean;
}

/** 列出可管理的候选模型：存在显式配置时使用配置列表，否则使用自动发现结果 */
function listManagedModels(
	ctx: ExtensionCommandContext,
	config: FusionRouterConfig,
): { entries: ManagedModelEntry[]; discovered: boolean } {
	const available = ctx.modelRegistry.getAvailable();
	const availableKeys = new Set(available.map((m) => modelKey(m.provider, m.id)));
	if (config.models.length > 0) {
		return {
			entries: config.models.map((profile) => {
				const key = modelKey(profile.provider, profile.id);
				return { key, profile, available: availableKeys.has(key) };
			}),
			discovered: false,
		};
	}
	return {
		entries: discoverCandidatesFromRegistry(available).map((profile) => ({
			key: modelKey(profile.provider, profile.id),
			profile,
			available: true,
		})),
		discovered: true,
	};
}

/** 解析模型键：必须是候选列表中的模型或当前已认证的物理模型 */
function resolveManagedModelKey(
	ctx: ExtensionCommandContext,
	config: FusionRouterConfig,
	rawKey: string | undefined,
): { provider: string; id: string; key: string } | string {
	const parsed = rawKey ? parseModelKey(rawKey) : undefined;
	if (!parsed) return "请提供 provider/model 格式的模型标识。";
	const key = modelKey(parsed.provider, parsed.id);
	const { entries } = listManagedModels(ctx, config);
	if (entries.some((e) => e.key === key)) return { ...parsed, key };
	const physical = ctx.modelRegistry
		.getAvailable()
		.find((m) => m.provider === parsed.provider && m.id === parsed.id && !isVirtualCatalogModel(m));
	if (physical) return { ...parsed, key };
	return `未找到已认证的模型：${key}`;
}

/** 构造候选模型修改补丁；处于自动发现状态时先将发现结果写入配置，保持候选池不变 */
function buildModelChangePatch(
	ctx: ExtensionCommandContext,
	config: FusionRouterConfig,
	change: CandidateModelPatch,
): PartialFusionRouterConfig {
	const { entries, discovered } = listManagedModels(ctx, config);
	const models: CandidateModelPatch[] = discovered ? entries.map((e) => ({ ...e.profile })) : [];
	models.push(change);
	return { models };
}

/** 判断停用某模型后是否仍保留至少 1 个已启用且可用的候选模型 */
function canDisableModel(ctx: ExtensionCommandContext, config: FusionRouterConfig, key: string): boolean {
	const { entries } = listManagedModels(ctx, config);
	return entries.some((e) => e.key !== key && e.profile.enabled && e.available);
}

/** 解析画像字段取值，返回补丁片段或错误说明 */
function parseProfileFieldValue(
	field: ProfileField,
	value: string,
): { patch: Omit<Partial<CandidateModelPatch>, "provider" | "id"> } | { error: string } {
	const trimmed = value.trim();
	switch (field) {
		case "priority": {
			const num = Number(trimmed);
			if (!Number.isInteger(num) || num < 1 || num > 100) return { error: "优先级必须是 1~100 的整数。" };
			return { patch: { priority: num } };
		}
		case "costTier":
			if (!(COST_TIERS as readonly string[]).includes(trimmed)) {
				return { error: `成本档位可选值：${COST_TIERS.join(", ")}` };
			}
			return { patch: { costTier: trimmed as CostTier } };
		case "thinking":
			if (trimmed === "auto") return { patch: { defaultThinking: null } };
			if (!(THINKING_LEVELS as readonly string[]).includes(trimmed)) {
				return { error: `思考强度可选值：auto, ${THINKING_LEVELS.join(", ")}` };
			}
			return { patch: { defaultThinking: trimmed as ModelThinkingLevel } };
		case "specialty":
			if (!trimmed) return { error: "擅长场景不能为空。" };
			return { patch: { specialty: trimmed } };
		case "avoid":
			return { patch: { avoid: trimmed === "clear" ? "" : trimmed } };
		case "label":
			if (!trimmed) return { error: "显示名称不能为空。" };
			return { patch: { label: trimmed } };
	}
}

function formatModelLine(entry: ManagedModelEntry, config: FusionRouterConfig, healthTracker: ModelHealthTracker): string {
	const p = entry.profile;
	const parts = [entry.key, p.enabled ? "启用" : "停用", p.costTier, `P${p.priority}`];
	if (p.defaultThinking) parts.push(`思考 ${p.defaultThinking}`);
	if (config.defaultModel === entry.key) parts.push("默认");
	if (!entry.available) {
		parts.push("未认证");
	} else {
		const health = healthTracker.getSnapshot(entry.key, config.health);
		if (health.status === "cooldown") parts.push(`冷却 ${formatDurationSeconds(health.remainingCooldownMs)}`);
	}
	return parts.join(" | ");
}

function getModelStatusBadge(
	entry: ManagedModelEntry,
	config: FusionRouterConfig,
	healthTracker: ModelHealthTracker,
): { text: string; tone: DetailTone } {
	const p = entry.profile;
	if (!p.enabled) return { text: "停用", tone: "dim" };
	if (!entry.available) return { text: "未认证", tone: "error" };
	const health = healthTracker.getSnapshot(entry.key, config.health);
	if (health.status === "cooldown") {
		return { text: `冷却 ${formatDurationSeconds(health.remainingCooldownMs)}`, tone: "warning" };
	}
	if (config.defaultModel === entry.key) return { text: "★ 默认", tone: "accent" };
	return { text: `启用 P${p.priority}`, tone: "success" };
}

function formatModelInlineHint(entry: ManagedModelEntry, includePriority: boolean): string {
	const p = entry.profile;
	const parts: string[] = [];
	if (includePriority) parts.push(`P${p.priority}`);
	parts.push(p.costTier);
	if (p.defaultThinking) parts.push(`思考 ${p.defaultThinking}`);
	if (p.specialty) parts.push(p.specialty);
	return parts.join(" · ");
}

function listModels(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): void {
	const config = runtime.getLoadedConfig().config;
	const { entries, discovered } = listManagedModels(ctx, config);
	if (entries.length === 0) {
		sendCommandOutput(ctx, "当前没有可用的已认证物理模型。", "warning");
		return;
	}
	const healthTracker = runtime.getHealthTracker();
	const lines = [`候选物理模型池 (${entries.length} 个，${discovered ? "自动发现" : "配置文件"}):`];
	for (const entry of entries) {
		lines.push(`- ${formatModelLine(entry, config, healthTracker)}`);
	}
	sendCommandOutput(ctx, lines.join("\n"));
}

function importModels(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime, scope?: SaveScope): void {
	const discovered = discoverCandidatesFromRegistry(ctx.modelRegistry.getAvailable());
	if (discovered.length === 0) {
		sendCommandOutput(ctx, "未发现可导入的已认证物理模型。", "warning");
		return;
	}
	applyConfigPatch(
		ctx,
		runtime,
		{ models: discovered },
		(_cfg, savedPath) => `已导入 ${discovered.length} 个候选物理模型并保存至 ${savedPath}`,
		scope,
	);
}

function setModelEnabled(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	rawKey: string | undefined,
	enabled: boolean,
	scope?: SaveScope,
): void {
	const config = runtime.getLoadedConfig().config;
	const target = resolveManagedModelKey(ctx, config, rawKey);
	if (typeof target === "string") {
		sendCommandOutput(ctx, target, "warning");
		return;
	}
	if (!enabled && !canDisableModel(ctx, config, target.key)) {
		sendCommandOutput(ctx, "至少需要保留 1 个已启用且可用的候选模型。", "warning");
		return;
	}
	applyConfigPatch(
		ctx,
		runtime,
		buildModelChangePatch(ctx, config, { provider: target.provider, id: target.id, enabled }),
		(_cfg, savedPath) => `已${enabled ? "启用" : "停用"}候选模型 ${target.key}（已保存至 ${savedPath}）`,
		scope,
	);
}

function setDefaultModel(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	rawKey: string | undefined,
	scope?: SaveScope,
): void {
	const config = runtime.getLoadedConfig().config;
	if (rawKey?.toLowerCase() === "clear") {
		applyConfigPatch(ctx, runtime, { defaultModel: "" }, (_cfg, savedPath) =>
			`已清除默认回退模型（已保存至 ${savedPath}）`, scope);
		return;
	}
	const target = resolveManagedModelKey(ctx, config, rawKey);
	if (typeof target === "string") {
		sendCommandOutput(ctx, target, "warning");
		return;
	}
	applyConfigPatch(ctx, runtime, { defaultModel: target.key }, (_cfg, savedPath) =>
		`已将默认回退模型设置为 ${target.key}（已保存至 ${savedPath}）`, scope);
}

function setModelField(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	rawKey: string | undefined,
	field: string | undefined,
	value: string,
	scope?: SaveScope,
): void {
	const config = runtime.getLoadedConfig().config;
	const target = resolveManagedModelKey(ctx, config, rawKey);
	if (typeof target === "string") {
		sendCommandOutput(ctx, target, "warning");
		return;
	}
	if (!field || !(PROFILE_FIELDS as readonly string[]).includes(field)) {
		sendCommandOutput(ctx, `可修改字段：${PROFILE_FIELDS.join(", ")}`, "warning");
		return;
	}
	const parsed = parseProfileFieldValue(field as ProfileField, value);
	if ("error" in parsed) {
		sendCommandOutput(ctx, parsed.error, "warning");
		return;
	}
	applyConfigPatch(
		ctx,
		runtime,
		buildModelChangePatch(ctx, config, { provider: target.provider, id: target.id, ...parsed.patch }),
		(_cfg, savedPath) => `已更新候选模型 ${target.key} 的 ${field}（已保存至 ${savedPath}）`,
		scope,
	);
}

/** 交互式查看并编辑单个候选模型（单栏固定列表） */
async function editManagedModel(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	key: string,
	scope: SaveScope,
): Promise<void> {
	const config = runtime.getLoadedConfig().config;
	const entry = listManagedModels(ctx, config).entries.find((e) => e.key === key);
	if (!entry) return;
	const p = entry.profile;
	const isDefault = config.defaultModel === key;

	const items: MenuPanelItem[] = [
		{
			value: "toggleEnabled",
			label: "启用状态",
			valueBadge: p.enabled ? "已启用" : "已停用",
			valueTone: boolTone(p.enabled),
			hint: p.enabled ? "Enter 停用该候选模型" : "Enter 重新启用该候选模型",
		},
		{
			value: "toggleDefault",
			label: "默认回退模型",
			valueBadge: isDefault ? "当前默认" : "否",
			valueTone: isDefault ? "accent" : "dim",
			hint: isDefault ? "Enter 取消默认回退设置" : "分类器不可用或观察模式时派发该模型",
		},
		{
			value: "priority",
			label: "优先级",
			valueBadge: String(p.priority),
			valueTone: "text",
			hint: "1~100 整数，越高越优先作为默认与回退首选",
		},
		{
			value: "costTier",
			label: "成本档位",
			valueBadge: p.costTier,
			valueTone: "text",
			hint: `可选 ${COST_TIERS.join(" / ")}，用于候选池收敛与成本权衡`,
		},
		{
			value: "thinking",
			label: "默认思考强度",
			valueBadge: p.defaultThinking ?? "auto",
			valueTone: p.defaultThinking ? "text" : "muted",
			hint: "profile-default 模式或分类器未指定强度时使用",
		},
		{
			value: "specialty",
			label: "擅长场景",
			valueBadge: p.specialty ? "已设置" : "未设置",
			valueTone: p.specialty ? "success" : "dim",
			hint: p.specialty || "Enter 打开编辑器填写擅长场景（供分类器参考）",
		},
		{
			value: "avoid",
			label: "不适用场景",
			valueBadge: p.avoid ? "已设置" : "未设置",
			valueTone: p.avoid ? "warning" : "dim",
			hint: p.avoid || "Enter 打开编辑器填写（留空清除）",
		},
		{
			value: "label",
			label: "显示名称",
			valueBadge: p.label || p.id,
			valueTone: "muted",
			hint: `模型标识: ${key}`,
		},
	];

	const picked = await selectMenuPanel(ctx, {
		title: `模型编辑：${key}`,
		headerBadge: buildHeaderBadge(config, scope),
		items,
		listRows: 8,
	});
	if (!picked) return;

	switch (picked) {
		case "toggleEnabled":
			setModelEnabled(ctx, runtime, key, !p.enabled, scope);
			return;
		case "toggleDefault":
			setDefaultModel(ctx, runtime, isDefault ? "clear" : key, scope);
			return;
		case "priority": {
			const value = await ctx.ui.input("优先级（1~100）", String(p.priority));
			if (value === undefined || !value.trim()) return;
			setModelField(ctx, runtime, key, "priority", value, scope);
			return;
		}
		case "costTier": {
			const value = await ctx.ui.select("成本档位", [...COST_TIERS]);
			if (value) setModelField(ctx, runtime, key, "costTier", value, scope);
			return;
		}
		case "thinking": {
			const value = await ctx.ui.select("默认思考强度", ["auto", ...THINKING_LEVELS]);
			if (value) setModelField(ctx, runtime, key, "thinking", value, scope);
			return;
		}
		case "specialty": {
			const value = await ctx.ui.editor("擅长场景", p.specialty);
			if (value !== undefined) setModelField(ctx, runtime, key, "specialty", value, scope);
			return;
		}
		case "avoid": {
			const value = await ctx.ui.editor("不适用场景（留空表示清除）", p.avoid ?? "");
			if (value !== undefined) setModelField(ctx, runtime, key, "avoid", value.trim() ? value : "clear", scope);
			return;
		}
		case "label": {
			const value = await ctx.ui.input("显示名称", p.label ?? p.id);
			if (value !== undefined && value.trim()) setModelField(ctx, runtime, key, "label", value, scope);
			return;
		}
	}
}

/** 交互式候选模型管理菜单（单栏固定列表） */
async function openModelsManager(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scopeRef?: ScopeRef,
): Promise<void> {
	const activeScopeRef: ScopeRef = scopeRef ?? { value: defaultSaveScope(runtime) };
	let lastPickedId: string | undefined;

	for (;;) {
		const config = runtime.getLoadedConfig().config;
		const { entries, discovered } = listManagedModels(ctx, config);
		const healthTracker = runtime.getHealthTracker();

		const items: MenuPanelItem[] = [
			{
				value: "__scope__",
				label: "保存位置",
				valueBadge: scopeLabel(activeScopeRef.value),
				valueTone: "accent",
				hint: activeScopeRef.value === "project" ? "写入 .pi/fusion-router.json" : "写入 ~/.pi/agent/fusion-router.json",
			},
			{
				value: "__import__",
				label: "导入全部已认证物理模型",
				valueBadge: "导入 ›",
				valueTone: "muted",
				hint: discovered ? "当前为自动发现，导入后写入配置文件固定候选池" : "将已认证物理模型同步至配置文件",
			},
			...entries.map((entry): MenuPanelItem => {
				const badge = getModelStatusBadge(entry, config, healthTracker);
				return {
					value: `model:${entry.key}`,
					label: entry.key,
					valueBadge: badge.text,
					valueTone: badge.tone,
					hint: formatModelInlineHint(entry, !badge.text.includes(`P${entry.profile.priority}`)),
					selectLabel: formatModelLine(entry, config, healthTracker),
				};
			}),
		];

		const defaultNote = config.defaultModel ? ` • 默认模型：${config.defaultModel}` : "";
		const plainSummary = discovered
			? `自动发现 ${entries.length} 个模型，修改任意项后保存为配置${defaultNote}`
			: `共 ${entries.length} 个配置模型${defaultNote}`;

		const picked = await selectMenuPanel(ctx, {
			title: `候选模型池 (${entries.length}${discovered ? " · 自动" : ""})`,
			headerBadge: buildHeaderBadge(config, activeScopeRef.value),
			details: plainSummary,
			items,
			initialValue: lastPickedId,
			listRows: 10,
		});
		if (!picked) return;
		lastPickedId = picked;

		if (picked === "__scope__") {
			activeScopeRef.value = activeScopeRef.value === "project" ? "global" : "project";
			continue;
		}
		if (picked === "__import__") {
			importModels(ctx, runtime, activeScopeRef.value);
			continue;
		}
		if (picked.startsWith("model:")) {
			await editManagedModel(ctx, runtime, picked.slice(6), activeScopeRef.value);
		}
	}
}

async function promptSelectDefaultModel(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scope: SaveScope,
): Promise<void> {
	const config = runtime.getLoadedConfig().config;
	const { entries } = listManagedModels(ctx, config);
	const clearChoice = "清除默认回退模型";
	const modelChoices = entries.map((e) => (e.key === config.defaultModel ? `${e.key}（当前默认）` : e.key));
	const chosen = await ctx.ui.select("选择默认回退模型", [
		...(config.defaultModel ? [clearChoice] : []),
		...modelChoices,
	]);
	if (!chosen) return;
	if (chosen === clearChoice) {
		setDefaultModel(ctx, runtime, "clear", scope);
	} else {
		const targetEntry = entries[modelChoices.indexOf(chosen)];
		if (targetEntry) setDefaultModel(ctx, runtime, targetEntry.key, scope);
	}
}

async function handleModels(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime, restArgs: string): Promise<void> {
	const tokens = restArgs.trim().split(/\s+/).filter(Boolean);
	const sub = tokens[0]?.toLowerCase();

	if (!sub) {
		if (ctx.hasUI) {
			await openModelsManager(ctx, runtime);
		} else {
			listModels(ctx, runtime);
		}
		return;
	}

	switch (sub) {
		case "list":
			listModels(ctx, runtime);
			return;
		case "import":
			importModels(ctx, runtime);
			return;
		case "enable":
		case "disable":
			setModelEnabled(ctx, runtime, tokens[1], sub === "enable");
			return;
		case "default":
			setDefaultModel(ctx, runtime, tokens[1]);
			return;
		case "set":
			setModelField(ctx, runtime, tokens[1], tokens[2], tokens.slice(3).join(" "));
			return;
		default:
			sendCommandOutput(ctx, MODELS_USAGE, "warning");
	}
}

// ───────────────────────── 健康管理与干跑测试 ─────────────────────────

function buildHealthReport(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime) {
	const config = runtime.getLoadedConfig().config;
	const tracker = runtime.getHealthTracker();
	const pool = buildCandidatePool({
		modelRegistry: ctx.modelRegistry,
		config,
		healthTracker: tracker,
	});
	const keys = pool.allResolved.map((c) => c.key);
	const snapshots = tracker.listSnapshots(keys, config.health);

	const lines = [
		`冷却追踪：${boolText(config.health.enabled)}   故障自动转移：${boolText(config.health.autoFailover)}`,
		`冷却时长：${config.health.cooldownSeconds}s ~ ${config.health.maxCooldownSeconds}s`,
		"",
	];
	if (snapshots.length === 0) {
		lines.push("暂无已追踪的模型健康记录。");
	} else {
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
	}
	return { text: lines.join("\n"), lines, snapshots };
}

async function promptCooldownSeconds(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scope: SaveScope,
): Promise<void> {
	const config = runtime.getLoadedConfig().config;
	const raw = await ctx.ui.input("基础冷却时长（5~3600 秒）", String(config.health.cooldownSeconds));
	if (raw === undefined || !raw.trim()) return;
	const num = Number(raw.trim());
	if (!Number.isInteger(num) || num < 5 || num > 3600) {
		sendCommandOutput(ctx, "基础冷却时长必须是 5~3600 的整数秒。", "warning");
		return;
	}
	applyConfigPatch(
		ctx,
		runtime,
		{ health: { cooldownSeconds: num } },
		(_cfg, savedPath) => `已将基础冷却时长设置为 ${num}s（已保存至 ${savedPath}）`,
		scope,
	);
}

async function promptMaxCooldownSeconds(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scope: SaveScope,
): Promise<void> {
	const config = runtime.getLoadedConfig().config;
	const minAllowed = config.health.cooldownSeconds;
	const raw = await ctx.ui.input(
		`最大冷却时长（${minAllowed}~86400 秒）`,
		String(config.health.maxCooldownSeconds),
	);
	if (raw === undefined || !raw.trim()) return;
	const num = Number(raw.trim());
	if (!Number.isInteger(num) || num < minAllowed || num > 86400) {
		sendCommandOutput(ctx, `最大冷却时长必须是 ${minAllowed}~86400 的整数秒。`, "warning");
		return;
	}
	applyConfigPatch(
		ctx,
		runtime,
		{ health: { maxCooldownSeconds: num } },
		(_cfg, savedPath) => `已将最大冷却时长设置为 ${num}s（已保存至 ${savedPath}）`,
		scope,
	);
}

/** 交互式模型健康与冷却管理菜单（单栏固定顺序列表） */
async function openHealthManager(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scopeRef?: ScopeRef,
): Promise<void> {
	const activeScopeRef: ScopeRef = scopeRef ?? { value: defaultSaveScope(runtime) };
	const tracker = runtime.getHealthTracker();
	let lastPickedId: string | undefined;

	for (;;) {
		const config = runtime.getLoadedConfig().config;
		const { text, snapshots } = buildHealthReport(ctx, runtime);
		const degraded = snapshots.filter((s) => s.status !== "healthy");

		// 顶部固定 6 个管理项 + 下方固定列出全部模型，重置后列表长度与位置保持稳定
		const items: MenuPanelItem[] = [
			{
				value: "__reset_all__",
				label: "重置全部模型健康状态",
				valueBadge: degraded.length > 0 ? `${degraded.length} 个异常` : "全部健康",
				valueTone: degraded.length > 0 ? "warning" : "success",
				hint: degraded.length > 0 ? "Enter 清空所有冷却与失败计数" : "当前所有候选模型均健康",
			},
			{
				value: "__toggle_health__",
				label: "健康冷却追踪",
				valueBadge: boolText(config.health.enabled),
				valueTone: boolTone(config.health.enabled),
				hint: "记录限流、超时等上游故障并执行指数退避冷却",
			},
			{
				value: "__toggle_failover__",
				label: "故障自动转移",
				valueBadge: boolText(config.health.autoFailover),
				valueTone: boolTone(config.health.autoFailover),
				hint: "可重试故障时自动切换至下一个健康备用模型",
			},
			{
				value: "__cooldown__",
				label: "基础冷却时长",
				valueBadge: `${config.health.cooldownSeconds}s`,
				valueTone: "text",
				hint: "首次故障冷却初始时长（5~3600 秒）",
			},
			{
				value: "__max_cooldown__",
				label: "最大冷却时长",
				valueBadge: `${config.health.maxCooldownSeconds}s`,
				valueTone: "text",
				hint: `指数退避冷却上限（${config.health.cooldownSeconds}~86400 秒）`,
			},
			{
				value: "__scope__",
				label: "保存位置",
				valueBadge: scopeLabel(activeScopeRef.value),
				valueTone: "accent",
				hint: activeScopeRef.value === "project" ? "写入 .pi/fusion-router.json" : "写入 ~/.pi/agent/fusion-router.json",
			},
			...snapshots.map((s): MenuPanelItem => {
				const badgeText =
					s.status === "healthy"
						? "健康"
						: s.status === "cooldown"
							? `冷却 ${formatDurationSeconds(s.remainingCooldownMs)}`
							: `待恢复 (${s.consecutiveFailures})`;
				const badgeTone: DetailTone = s.status === "healthy" ? "success" : "warning";
				const detailPart =
					s.status === "healthy"
						? "运行健康"
						: `连续失败 ${s.consecutiveFailures} 次${s.lastSummary ? ` · ${s.lastSummary}` : ""}（Enter 重置）`;
				return {
					value: `reset:${s.key}`,
					label: s.key,
					valueBadge: badgeText,
					valueTone: badgeTone,
					hint: detailPart,
					hintTone: s.status === "healthy" ? undefined : "warning",
				};
			}),
		];

		const picked = await selectMenuPanel(ctx, {
			title: "模型健康与冷却管理",
			headerBadge: buildHeaderBadge(config, activeScopeRef.value),
			details: text,
			items,
			initialValue: lastPickedId,
			listRows: 10,
		});
		if (!picked) return;
		lastPickedId = picked;

		if (picked === "__scope__") {
			activeScopeRef.value = activeScopeRef.value === "project" ? "global" : "project";
			continue;
		}
		if (picked === "__reset_all__") {
			tracker.reset();
			sendCommandOutput(ctx, "已重置全部模型健康状态。");
			continue;
		}
		if (picked === "__toggle_health__") {
			const nextEnabled = !config.health.enabled;
			applyConfigPatch(
				ctx,
				runtime,
				{ health: { enabled: nextEnabled } },
				(_cfg, savedPath) => `已${nextEnabled ? "开启" : "关闭"}健康冷却追踪（已保存至 ${savedPath}）`,
				activeScopeRef.value,
			);
			continue;
		}
		if (picked === "__toggle_failover__") {
			const nextAuto = !config.health.autoFailover;
			applyConfigPatch(
				ctx,
				runtime,
				{ health: { autoFailover: nextAuto } },
				(_cfg, savedPath) => `已${nextAuto ? "开启" : "关闭"}故障自动转移（已保存至 ${savedPath}）`,
				activeScopeRef.value,
			);
			continue;
		}
		if (picked === "__cooldown__") {
			await promptCooldownSeconds(ctx, runtime, activeScopeRef.value);
			continue;
		}
		if (picked === "__max_cooldown__") {
			await promptMaxCooldownSeconds(ctx, runtime, activeScopeRef.value);
			continue;
		}
		if (picked.startsWith("reset:")) {
			const key = picked.slice(6);
			tracker.reset(key);
			sendCommandOutput(ctx, `已重置模型健康状态: ${key}`);
		}
	}
}

async function handleHealth(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime, restArgs: string): Promise<void> {
	const tracker = runtime.getHealthTracker();
	const tokens = restArgs.trim().split(/\s+/).filter(Boolean);
	const sub = tokens[0]?.toLowerCase();

	if (sub === "manage") {
		if (ctx.hasUI) {
			await openHealthManager(ctx, runtime);
		} else {
			sendCommandOutput(ctx, buildHealthReport(ctx, runtime).text);
		}
		return;
	}

	if (sub === "reset") {
		const target = tokens[1];
		tracker.reset(target);
		sendCommandOutput(ctx, target ? `已重置模型健康状态: ${target}` : "已重置全部模型健康状态。");
		return;
	}

	const { text, snapshots } = buildHealthReport(ctx, runtime);
	if (snapshots.length === 0) {
		sendCommandOutput(ctx, "暂无已追踪的模型健康记录。");
		return;
	}
	sendCommandOutput(ctx, text);
}

interface DryRunTestResult {
	text: string;
	summaryLine: string;
	level: "info" | "warning";
}

async function executeDryRunTest(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	promptText: string,
): Promise<DryRunTestResult> {
	const config = runtime.getLoadedConfig().config;
	const pool = buildCandidatePool({
		modelRegistry: ctx.modelRegistry,
		config,
		healthTracker: runtime.getHealthTracker(),
	});

	if (pool.forDecision.length === 0) {
		const msg = "没有可用于测试的候选模型。";
		return { text: msg, summaryLine: msg, level: "warning" };
	}

	const classifiers = await resolveClassifierChain(ctx.modelRegistry, config.classifier);
	if (classifiers.length === 0) {
		const msg = "未检测到可用的专用分类器模型。";
		return { text: msg, summaryLine: msg, level: "warning" };
	}

	const samplePrompt = promptText.trim() || DEFAULT_TEST_PROMPT;
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
		const msg = "分类器测试调用失败或超时，请检查网络连接与凭据。";
		return { text: msg, summaryLine: msg, level: "warning" };
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

	const confidencePct = Math.round(decision.selectedModelConfidence * 100);
	const lines = [
		`干跑路由测试结果:`,
		`测试输入: ${samplePrompt}`,
		`分类器: ${decision.classifierModelKey} (${decision.latencyMs}ms)`,
		`推荐模型: ${decision.selectedModelKey} (置信度 ${confidencePct}%)`,
		`思考强度: ${decision.effortLabel} → 适配后 ${resolvedThinking}`,
	];
	const summaryLine = `推荐 ${shortModelLabel(decision.selectedModelKey)} (${confidencePct}%) · ${resolvedThinking} · ${decision.latencyMs}ms`;
	return { text: lines.join("\n"), summaryLine, level: "info" };
}

async function handleTest(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime, promptText: string): Promise<void> {
	const result = await executeDryRunTest(ctx, runtime, promptText);
	sendCommandOutput(ctx, result.text, result.level);
}

// ───────────────────────── /fusion 横向 4 分区双栏路由控制中心 ─────────────────────────

async function openSettingsFromRuntime(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scopeRef?: ScopeRef,
): Promise<void> {
	const activeScopeRef: ScopeRef = scopeRef ?? { value: defaultSaveScope(runtime) };
	await openFusionSettingsPanel(ctx, {
		getConfig: () => runtime.getLoadedConfig().config,
		getAvailableClassifiers: async () => {
			const chain = await resolveClassifierChain(
				ctx.modelRegistry,
				runtime.getLoadedConfig().config.classifier,
			);
			return chain.map((c) => c.key);
		},
		getSaveScope: () => activeScopeRef.value,
		onScopeChange: (nextScope) => {
			activeScopeRef.value = nextScope;
		},
		getLastState: () => runtime.getLastState(),
		onApplyPatch: (patch, scope) => runtime.updateAndSaveConfig(patch, scope).config,
	});
}

/**
 * 打开 /fusion 单栏固定高度横向分区路由控制中心：
 * 分为「概览与诊断」「路由策略」「模型与分类器」「健康与测试」4 个标签页，
 * 采用全宽三列固定列表（名称 + 固定槽位状态值 + 精简摘要），无多余右侧概览板块。
 */
async function openFusionHub(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): Promise<void> {
	const scopeRef: ScopeRef = { value: defaultSaveScope(runtime) };
	let cachedClassifiers: DiscoveredClassifier[] = [];
	let lastTestResult: DryRunTestResult | undefined;

	const refreshClassifiers = async (): Promise<void> => {
		cachedClassifiers = await resolveClassifierChain(
			ctx.modelRegistry,
			runtime.getLoadedConfig().config.classifier,
		);
	};
	await refreshClassifiers();

	const runPromptDryTest = async (): Promise<void> => {
		const rawPrompt = await ctx.ui.input("输入干跑测试任务描述（直接回车使用默认示例）", DEFAULT_TEST_PROMPT);
		if (rawPrompt === undefined) return;
		const res = await executeDryRunTest(ctx, runtime, rawPrompt);
		lastTestResult = res;
		sendCommandOutput(ctx, res.text, res.level);
	};

	await openTabbedSplitWorkspace(ctx, () => {
		const loaded = runtime.getLoadedConfig();
		const config = loaded.config;
		const state = runtime.getLastState();
		const healthTracker = runtime.getHealthTracker();
		const pool = buildCandidatePool({
			modelRegistry: ctx.modelRegistry,
			config,
			healthTracker,
			currentModelKey: state?.selectedModel,
		});

		const statusLines = buildStatusLinesFromChain(ctx, runtime, cachedClassifiers).slice(1);
		const rawExplainLines = buildExplainLines(state);
		const explainLines = rawExplainLines.length > 1 ? rawExplainLines.slice(1) : rawExplainLines;
		const healthReport = buildHealthReport(ctx, runtime);
		const degradedSnapshots = healthReport.snapshots.filter((s) => s.status !== "healthy");
		const coolingSnapshots = degradedSnapshots.filter((s) => s.status === "cooldown");
		const coolingCount = coolingSnapshots.length;
		const availableCount = pool.allResolved.length - coolingCount;

		const stateSummary = state ? `${shortModelLabel(state.selectedModel)} (${state.thinkingLevel})` : "待命";
		const primaryClassifier = cachedClassifiers[0]?.key;
		const classifierSummary = primaryClassifier ? shortModelLabel(primaryClassifier) : "未检测到";
		const customTarget = resolveCustomClassifierTarget(config.classifier);

		// 顶栏固定单行关键指标（永不折行）
		const summarySegments: SummarySegment[] = [
			{ label: "路由", value: stateSummary, tone: state ? "accent" : "muted" },
			{ label: "分类器", value: classifierSummary, tone: primaryClassifier ? "text" : "warning" },
			{
				label: "候选池",
				value: coolingCount > 0 ? `${availableCount}/${pool.allResolved.length} (冷却 ${coolingCount})` : `${availableCount}/${pool.allResolved.length} 可用`,
				tone: coolingCount > 0 ? "warning" : "success",
			},
		];

		const errCount = config.redecision.redecideOnConsecutiveToolErrors;
		const reviewSteps = config.redecision.periodicReviewSteps;
		const errValues = Array.from(new Set(["0", "1", "2", "3", "4", "5", String(errCount)]));
		const stepValues = Array.from(new Set(["0", "4", "8", "12", "16", "24", String(reviewSteps)]));

		const explainHint = state
			? `${shortModelLabel(state.selectedModel)} (${state.thinkingLevel}) · ${state.lastDecision.reason}`
			: "尚无决策记录（Enter 发起干跑测试）";

		// ── 分区 1：概览与诊断（固定 5 项）──
		const overviewItems: WorkspaceItem[] = [
			{
				id: "enabled",
				label: "路由器总开关",
				value: boolText(config.enabled),
				valueTone: boolTone(config.enabled),
				hint: config.enabled
					? `虚拟模型 ${config.virtualModel.provider}/${config.virtualModel.id} 已启用`
					: "关闭后跳过分类器，始终派发默认回退模型",
				allowSpace: true,
				onActivate: () => {
					const next = !config.enabled;
					applyConfigPatch(
						ctx,
						runtime,
						{ enabled: next },
						(_cfg, savedPath) => `已${next ? "启用" : "停用"} Pi-Fusion 动态路由（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			},
			{
				id: "mode",
				label: "运行模式",
				value: config.mode,
				valueTone: config.mode === "observe" ? "warning" : "success",
				hint: "auto 按决策自动切换；observe 仅记录推荐并派发默认模型",
				allowSpace: true,
				onActivate: () => {
					const nextMode: FusionRouterConfig["mode"] = config.mode === "auto" ? "observe" : "auto";
					applyConfigPatch(
						ctx,
						runtime,
						{ mode: nextMode },
						(cfg, savedPath) => `已切换运行模式为 ${cfg.mode}（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			},
			{
				id: "explain",
				label: "最近一次决策详情",
				value: state ? state.lastDecision.trigger : "暂无",
				valueTone: state ? "text" : "dim",
				hint: explainHint,
				onActivate: async () => {
					const testOpt = "执行干跑路由测试";
					const backOpt = "返回控制中心";
					const picked = await selectMenuPanel(ctx, {
						title: "最近一次路由决策详情",
						headerBadge: buildHeaderBadge(config, scopeRef.value),
						details: explainLines.join("\n"),
						infoLines: explainLines,
						items: [
							{ value: testOpt, label: testOpt, valueBadge: "运行 ›", valueTone: "accent", hint: "输入任务描述模拟选路" },
							{ value: backOpt, label: backOpt, hint: "返回控制中心" },
						],
						listRows: 4,
					});
					if (picked === testOpt) {
						await runPromptDryTest();
					}
				},
			},
			{
				id: "reload",
				label: "重新加载配置文件",
				value: loaded.projectExists ? "全局+项目" : "全局",
				valueTone: "muted",
				hint: loaded.projectExists ? "已加载全局与 .pi 项目配置（Enter 刷新）" : "仅加载全局配置（Enter 刷新）",
				onActivate: async () => {
					reloadConfiguration(ctx, runtime);
					await refreshClassifiers();
				},
			},
			{
				id: "saveScope",
				label: "配置保存位置",
				value: scopeLabel(scopeRef.value),
				valueTone: "accent",
				hint: scopeRef.value === "project" ? "写入 .pi/fusion-router.json（仅变更字段）" : "写入 ~/.pi/agent/fusion-router.json（仅变更字段）",
				allowSpace: true,
				onActivate: () => {
					scopeRef.value = scopeRef.value === "project" ? "global" : "project";
				},
			},
		];

		// ── 分区 2：路由策略（固定 9 项）──
		const makePolicyItem = (params: {
			id: string;
			label: string;
			value: string;
			valueTone?: DetailTone;
			hint: string;
			allowSpace?: boolean;
			run: () => void | Promise<void>;
		}): WorkspaceItem => ({
			id: params.id,
			label: params.label,
			value: params.value,
			valueTone: params.valueTone,
			hint: params.hint,
			allowSpace: params.allowSpace ?? true,
			onActivate: async () => {
				await params.run();
			},
		});

		const policyItems: WorkspaceItem[] = [
			makePolicyItem({
				id: "thinkingMode",
				label: "思考强度模式",
				value: config.thinkingMode,
				valueTone: "text",
				hint: "auto 分类器 · passthrough 透传 · profile-default 默认",
				run: () => {
					const next = cycleString(config.thinkingMode, ["auto", "passthrough", "profile-default"] as const);
					applyConfigPatch(
						ctx,
						runtime,
						{ thinkingMode: next },
						(_cfg, savedPath) => `已将思考强度模式设置为 ${next}（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyItem({
				id: "stickyDuringToolLoop",
				label: "工具循环粘性保持",
				value: boolText(config.redecision.stickyDuringToolLoop),
				valueTone: boolTone(config.redecision.stickyDuringToolLoop),
				hint: "工具调用返回后优先保持当前模型，保护上下文缓存",
				run: () => {
					const next = !config.redecision.stickyDuringToolLoop;
					applyConfigPatch(
						ctx,
						runtime,
						{ redecision: { stickyDuringToolLoop: next } },
						(_cfg, savedPath) => `已${next ? "开启" : "关闭"}工具循环粘性保持（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyItem({
				id: "redecideOnTaskShift",
				label: "新消息重新决策",
				value: boolText(config.redecision.redecideOnTaskShift),
				valueTone: boolTone(config.redecision.redecideOnTaskShift),
				hint: "收到新用户消息时重新评估模型；关闭后整段会话沿用当前模型",
				run: () => {
					const next = !config.redecision.redecideOnTaskShift;
					applyConfigPatch(
						ctx,
						runtime,
						{ redecision: { redecideOnTaskShift: next } },
						(_cfg, savedPath) => `已${next ? "开启" : "关闭"}新消息重新决策（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyItem({
				id: "protectThinkingSignature",
				label: "思考签名保护",
				value: boolText(config.redecision.protectThinkingSignature),
				valueTone: boolTone(config.redecision.protectThinkingSignature),
				hint: "本轮已有思考块时锁定周期复查，防止跨模型丢失推理签名",
				run: () => {
					const next = !config.redecision.protectThinkingSignature;
					applyConfigPatch(
						ctx,
						runtime,
						{ redecision: { protectThinkingSignature: next } },
						(_cfg, savedPath) => `已${next ? "开启" : "关闭"}思考签名保护（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyItem({
				id: "redecideOnConsecutiveToolErrors",
				label: "连续工具报错阈值",
				value: errCount > 0 ? `${errCount} 次` : "关闭",
				valueTone: errCount > 0 ? "text" : "dim",
				hint: "连续报错达阈值后重新选路或升级模型（0 关 · 1~5）",
				run: () => {
					const next = Number(cycleString(String(errCount), errValues));
					applyConfigPatch(
						ctx,
						runtime,
						{ redecision: { redecideOnConsecutiveToolErrors: next } },
						(_cfg, savedPath) => `已将连续工具报错阈值设置为 ${next}（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyItem({
				id: "periodicReviewSteps",
				label: "周期复查步数",
				value: reviewSteps > 0 ? `${reviewSteps} 步` : "关闭",
				valueTone: reviewSteps > 0 ? "text" : "dim",
				hint: "连续工具执行每满步数复查一次模型（0 关 · 4~24）",
				run: () => {
					const next = Number(cycleString(String(reviewSteps), stepValues));
					applyConfigPatch(
						ctx,
						runtime,
						{ redecision: { periodicReviewSteps: next } },
						(_cfg, savedPath) => `已将周期复查步数设置为 ${next}（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyItem({
				id: "minSwitchBenefitConfidence",
				label: "切换收益最低置信度",
				value: String(config.redecision.minSwitchBenefitConfidence),
				valueTone: "text",
				allowSpace: false,
				hint: "已有健康模型时达到该置信度才执行切换（0~1）",
				run: async () => {
					const raw = await ctx.ui.input(
						"切换收益最低置信度（0~1）",
						String(config.redecision.minSwitchBenefitConfidence),
					);
					if (raw === undefined || !raw.trim()) return;
					const num = Number(raw.trim());
					if (!Number.isFinite(num) || num < 0 || num > 1) {
						sendCommandOutput(ctx, "切换收益最低置信度必须是 0~1 之间的数值。", "warning");
						return;
					}
					applyConfigPatch(
						ctx,
						runtime,
						{ redecision: { minSwitchBenefitConfidence: num } },
						(_cfg, savedPath) => `已将切换收益最低置信度设置为 ${num}（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyItem({
				id: "preferences",
				label: "编辑路由偏好说明",
				value: config.preferences ? "已设置" : "未设置",
				valueTone: config.preferences ? "success" : "dim",
				allowSpace: false,
				hint: config.preferences ? config.preferences.replace(/\s+/g, " ") : "附加给分类器的自然语言选路偏好说明",
				run: async () => {
					const edited = await ctx.ui.editor("路由偏好说明（留空保存表示清空）", config.preferences);
					if (edited === undefined) return;
					const nextPref = edited.trim();
					applyConfigPatch(
						ctx,
						runtime,
						{ preferences: nextPref },
						(_cfg, savedPath) =>
							nextPref
								? `已更新路由偏好说明（已保存至 ${savedPath}）`
								: `已清空路由偏好说明（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyItem({
				id: "fallbackChain",
				label: "编辑备用模型回退链",
				value: config.fallbackChain.length > 0 ? `${config.fallbackChain.length} 个` : "未设置",
				valueTone: config.fallbackChain.length > 0 ? "success" : "dim",
				allowSpace: false,
				hint:
					config.fallbackChain.length > 0
						? config.fallbackChain.map(shortModelLabel).join(" → ")
						: "分类器不可用或默认模型冷却时的备用物理模型顺序",
				run: async () => {
					const raw = await ctx.ui.input(
						"备用模型回退链（多个 provider/model 用逗号或空格分隔，留空表示清空）",
						config.fallbackChain.join(", "),
					);
					if (raw === undefined) return;
					const items = raw
						.split(/[,\s]+/)
						.map((s) => s.trim())
						.filter(Boolean);
					const invalid = items.find((item) => !parseModelKey(item));
					if (invalid) {
						sendCommandOutput(ctx, `模型标识格式无效（应为 provider/model）：${invalid}`, "warning");
						return;
					}
					applyConfigPatch(
						ctx,
						runtime,
						{ fallbackChain: items },
						(_cfg, savedPath) =>
							items.length > 0
								? `已更新备用模型回退链（共 ${items.length} 个，已保存至 ${savedPath}）`
								: `已清空备用模型回退链（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
		];

		// ── 分区 3：模型与分类器（固定 7 项）──
		const poolPreview = pool.allResolved
			.slice(0, 3)
			.map((c) => shortModelLabel(c.key))
			.join(", ");
		const poolHint = poolPreview
			? `${poolPreview}${pool.allResolved.length > 3 ? ` 等 ${pool.allResolved.length} 个` : ""}`
			: "当前无可用物理模型";

		const modelsAndClassifierItems: WorkspaceItem[] = [
			{
				id: "manageModels",
				label: "管理候选物理模型池",
				value: `${pool.allResolved.length} 个${pool.discoveredFromRegistry ? "(自动)" : ""}`,
				valueTone: "text",
				hint: poolHint,
				onActivate: async () => {
					await openModelsManager(ctx, runtime, scopeRef);
				},
			},
			{
				id: "importModels",
				label: "导入已认证物理模型",
				value: "导入 ›",
				valueTone: "muted",
				hint: pool.discoveredFromRegistry
					? `将当前自动发现的模型写入${scopeLabel(scopeRef.value)}`
					: `重新同步全部已认证物理模型至${scopeLabel(scopeRef.value)}`,
				onActivate: () => {
					importModels(ctx, runtime, scopeRef.value);
				},
			},
			{
				id: "defaultModel",
				label: "默认回退模型",
				value: config.defaultModel ? shortModelLabel(config.defaultModel) : "按优先级",
				valueTone: config.defaultModel ? "accent" : "dim",
				hint: config.defaultModel
					? `完整标识: ${config.defaultModel}`
					: "未指定时按最高优先级选取兜底模型",
				onActivate: async () => {
					await promptSelectDefaultModel(ctx, runtime, scopeRef.value);
				},
			},
			{
				id: "selectClassifier",
				label: "专用决策分类器",
				value: config.classifier.provider === "auto" ? "auto" : shortModelLabel(formatClassifierChoice(config)),
				valueTone: primaryClassifier ? "text" : "warning",
				hint: primaryClassifier
					? `当前生效: ${primaryClassifier}${cachedClassifiers.length > 1 ? ` (+${cachedClassifiers.length - 1} 备选)` : ""}`
					: "未检测到已配置凭据的专用分类器",
				onActivate: async () => {
					const current = formatClassifierChoice(config);
					const choices = Array.from(new Set(["auto", ...cachedClassifiers.map((c) => c.key)]));
					const labels = choices.map((c) => (c === current ? `${c}（当前）` : c));
					const picked = await ctx.ui.select("选择专用决策分类器", labels);
					if (!picked) return;
					const chosen = choices[labels.indexOf(picked)];
					if (!chosen || chosen === current) return;
					const patch = classifierChoiceToPatch(chosen);
					if (patch) {
						applyConfigPatch(
							ctx,
							runtime,
							patch,
							(cfg, savedPath) =>
								chosen === "auto"
									? `已将决策分类器切换为 auto 自动发现（已保存至 ${savedPath}）`
									: `已将决策分类器设置为 ${formatClassifierChoice(cfg)}（已保存至 ${savedPath}）`,
							scopeRef.value,
						);
						await refreshClassifiers();
					}
				},
			},
			{
				id: "customEndpoint",
				label: "配置自定义决策端点",
				value: customTarget ? "已配置" : "未配置",
				valueTone: customTarget ? "success" : "dim",
				hint: customTarget ? `${customTarget.baseUrl} (${customTarget.api})` : "配置兼容的自定义决策端点地址、协议与密钥变量",
				onActivate: async () => {
					await configureCustomEndpointInteractive(ctx, runtime, scopeRef.value);
					await refreshClassifiers();
				},
			},
			{
				id: "endpointActions",
				label: "导入或清除分类器端点",
				value: config.classifier.customEndpoint ? "导入/清除" : "导入 ›",
				valueTone: "muted",
				hint: config.classifier.customEndpoint ? "从全局 settings.json 导入或清除当前自定义端点" : "从 Pi 全局 settings.json 导入端点",
				onActivate: async () => {
					if (!config.classifier.customEndpoint) {
						importClassifierEndpoint(ctx, runtime, scopeRef.value);
						await refreshClassifiers();
						return;
					}
					const impOpt = "从全局 settings.json 导入端点";
					const clrOpt = "清除当前自定义决策端点";
					const picked = await ctx.ui.select("分类器端点操作", [impOpt, clrOpt]);
					if (picked === impOpt) {
						importClassifierEndpoint(ctx, runtime, scopeRef.value);
						await refreshClassifiers();
					} else if (picked === clrOpt) {
						clearCustomClassifierEndpoint(ctx, runtime, config, scopeRef.value);
						await refreshClassifiers();
					}
				},
			},
			{
				id: "classifierThresholds",
				label: "分类器超时与最低置信度",
				value: `${config.classifier.timeoutMs}ms / ${config.classifier.minConfidence}`,
				valueTone: "text",
				hint: "超时自动降级至备选分类器；低于置信度回退默认模型",
				onActivate: async () => {
					const tOpt = `修改超时时间（当前：${config.classifier.timeoutMs}ms）`;
					const cOpt = `修改最低置信度（当前：${config.classifier.minConfidence}）`;
					const picked = await ctx.ui.select("修改分类器参数", [tOpt, cOpt]);
					if (picked === tOpt) {
						await promptClassifierTimeout(ctx, runtime, scopeRef.value);
					} else if (picked === cOpt) {
						await promptClassifierMinConfidence(ctx, runtime, scopeRef.value);
					}
				},
			},
		];

		// ── 分区 4：健康与测试（固定 8 项）──
		const coolingSummary = coolingSnapshots
			.map((s) => `${shortModelLabel(s.key)} (${formatDurationSeconds(s.remainingCooldownMs)})`)
			.join(", ");

		const healthAndTestItems: WorkspaceItem[] = [
			{
				id: "dryRunTest",
				label: "执行干跑路由测试",
				value: lastTestResult ? "重测 ›" : "运行 ›",
				valueTone: "accent",
				hint: lastTestResult
					? lastTestResult.summaryLine
					: "输入任务描述测试选路与思考强度适配（不产生对话消息）",
				hintTone: lastTestResult ? (lastTestResult.level === "warning" ? "warning" : "success") : undefined,
				onActivate: async () => {
					await runPromptDryTest();
				},
			},
			{
				id: "resetHealth",
				label: "重置模型健康冷却",
				value: degradedSnapshots.length > 0 ? `${degradedSnapshots.length} 个异常` : "全部健康",
				valueTone: degradedSnapshots.length > 0 ? "warning" : "success",
				hint: coolingSummary ? `冷却中: ${coolingSummary}` : "所有候选模型运行健康，无冷却记录",
				hintTone: coolingSummary ? "warning" : undefined,
				onActivate: async () => {
					if (degradedSnapshots.length === 0) {
						healthTracker.reset();
						sendCommandOutput(ctx, "已重置全部模型健康状态。");
						return;
					}
					const allOpt = "重置全部模型健康状态";
					const singleOpts = degradedSnapshots.map((s) =>
						s.status === "cooldown"
							? `重置模型健康状态：${s.key}（冷却 ${formatDurationSeconds(s.remainingCooldownMs)}）`
							: `重置模型健康状态：${s.key}（历史失败 ${s.consecutiveFailures} 次）`,
					);
					const picked = await ctx.ui.select("选择要重置的模型", [...singleOpts, allOpt]);
					if (!picked) return;
					if (picked === allOpt) {
						healthTracker.reset();
						sendCommandOutput(ctx, "已重置全部模型健康状态。");
						return;
					}
					const target = degradedSnapshots[singleOpts.indexOf(picked)];
					if (target) {
						healthTracker.reset(target.key);
						sendCommandOutput(ctx, `已重置模型健康状态: ${target.key}`);
					}
				},
			},
			{
				id: "healthEnabled",
				label: "健康冷却追踪",
				value: boolText(config.health.enabled),
				valueTone: boolTone(config.health.enabled),
				hint: "记录限流、超时等上游故障并执行指数退避冷却",
				allowSpace: true,
				onActivate: () => {
					const next = !config.health.enabled;
					applyConfigPatch(
						ctx,
						runtime,
						{ health: { enabled: next } },
						(_cfg, savedPath) => `已${next ? "开启" : "关闭"}健康冷却追踪（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			},
			{
				id: "autoFailover",
				label: "故障自动转移",
				value: boolText(config.health.autoFailover),
				valueTone: boolTone(config.health.autoFailover),
				hint: "遇到可重试上游故障时自动切换至下一个健康备用模型",
				allowSpace: true,
				onActivate: () => {
					const next = !config.health.autoFailover;
					applyConfigPatch(
						ctx,
						runtime,
						{ health: { autoFailover: next } },
						(_cfg, savedPath) => `已${next ? "开启" : "关闭"}故障自动转移（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			},
			{
				id: "cooldownRange",
				label: "修改冷却时长范围",
				value: `${config.health.cooldownSeconds}s~${config.health.maxCooldownSeconds}s`,
				valueTone: "text",
				hint: "连续故障按指数退避从基础冷却增长至上限时长",
				onActivate: async () => {
					const baseOpt = `修改基础冷却时长（当前：${config.health.cooldownSeconds}s）`;
					const maxOpt = `修改最大冷却时长（当前：${config.health.maxCooldownSeconds}s）`;
					const picked = await ctx.ui.select("修改冷却时长", [baseOpt, maxOpt]);
					if (picked === baseOpt) {
						await promptCooldownSeconds(ctx, runtime, scopeRef.value);
					} else if (picked === maxOpt) {
						await promptMaxCooldownSeconds(ctx, runtime, scopeRef.value);
					}
				},
			},
			{
				id: "showStatusBar",
				label: "底部状态栏显示",
				value: boolText(config.ui.showStatusBar),
				valueTone: boolTone(config.ui.showStatusBar),
				hint: "在 Pi 底部状态栏显示当前派发的物理模型与思考深度",
				allowSpace: true,
				onActivate: () => {
					const next = !config.ui.showStatusBar;
					applyConfigPatch(
						ctx,
						runtime,
						{ ui: { showStatusBar: next } },
						(_cfg, savedPath) => `已${next ? "开启" : "关闭"}底部状态栏显示（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			},
			{
				id: "notifyOnSwitch",
				label: "切换模型通知",
				value: boolText(config.ui.notifyOnSwitch),
				valueTone: boolTone(config.ui.notifyOnSwitch),
				hint: "动态路由切换到不同物理模型时弹出提示通知",
				allowSpace: true,
				onActivate: () => {
					const next = !config.ui.notifyOnSwitch;
					applyConfigPatch(
						ctx,
						runtime,
						{ ui: { notifyOnSwitch: next } },
						(_cfg, savedPath) => `已${next ? "开启" : "关闭"}切换模型通知（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			},
			{
				id: "notifyOnFailover",
				label: "故障转移通知",
				value: boolText(config.ui.notifyOnFailover),
				valueTone: boolTone(config.ui.notifyOnFailover),
				hint: "模型触发故障冷却并自动转移时弹出告警通知",
				allowSpace: true,
				onActivate: () => {
					const next = !config.ui.notifyOnFailover;
					applyConfigPatch(
						ctx,
						runtime,
						{ ui: { notifyOnFailover: next } },
						(_cfg, savedPath) => `已${next ? "开启" : "关闭"}故障转移通知（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			},
		];

		return {
			title: "Pi-Fusion 路由控制中心",
			headerBadge: buildHeaderBadge(config, scopeRef.value),
			summarySegments,
			listRows: 10,
			sections: [
				{
					id: "overview",
					title: "概览与诊断",
					plainHeaderLines: statusLines,
					items: overviewItems,
				},
				{
					id: "policy",
					title: "路由策略",
					items: policyItems,
				},
				{
					id: "models_classifier",
					title: "模型与分类器",
					items: modelsAndClassifierItems,
				},
				{
					id: "health_test",
					title: "健康与测试",
					plainHeaderLines: healthReport.lines,
					items: healthAndTestItems,
				},
			],
		};
	});
}

// ───────────────────────── 命令注册与补全 ─────────────────────────

function completeSubcommand(
	prefix: string,
	command: string,
	items: readonly { value: string; description: string }[],
): { value: string; label: string; description: string }[] {
	const sub = prefix.slice(command.length + 1);
	return items
		.filter((item) => item.value.startsWith(sub))
		.map((item) => ({ value: `${command} ${item.value}`, label: `${command} ${item.value}`, description: item.description }));
}

/** 注册 /fusion 与 /router 斜杠命令 */
export function registerFusionCommands(pi: ExtensionAPI, runtime: FusionCommandRuntime): void {
	const commandDef = {
		description: "查看和配置 Pi-Fusion 多模型动态路由器",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trimStart().toLowerCase();
			if (trimmed.startsWith("mode ")) {
				const sub = trimmed.slice(5);
				return ["auto", "observe", "on", "off"]
					.filter((v) => v.startsWith(sub))
					.map((v) => ({ value: `mode ${v}`, label: `mode ${v}` }));
			}
			if (trimmed.startsWith("models ")) {
				return completeSubcommand(trimmed, "models", MODELS_SUBCOMMANDS);
			}
			if (trimmed.startsWith("classifier ")) {
				return completeSubcommand(trimmed, "classifier", CLASSIFIER_SUBCOMMANDS);
			}
			if (trimmed.startsWith("health ")) {
				return completeSubcommand(trimmed, "health", HEALTH_SUBCOMMANDS);
			}
			return SUBCOMMANDS.filter((item) => item.value.startsWith(trimmed.trim()));
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const trimmed = args.trim();
			const firstSpace = trimmed.indexOf(" ");
			const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
			const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

			if (!sub) {
				if (ctx.hasUI) {
					await openFusionHub(ctx, runtime);
				} else {
					await handleStatus(ctx, runtime);
				}
				return;
			}

			switch (sub) {
				case "config":
					if (ctx.hasUI) {
						await openSettingsFromRuntime(ctx, runtime);
					} else {
						await handleStatus(ctx, runtime);
					}
					return;
				case "status":
					await handleStatus(ctx, runtime);
					return;
				case "explain":
				case "last":
					handleExplain(ctx, runtime);
					return;
				case "models":
					await handleModels(ctx, runtime, rest);
					return;
				case "classifier":
					await handleClassifier(ctx, runtime, rest);
					return;
				case "health":
					await handleHealth(ctx, runtime, rest);
					return;
				case "mode": {
					const modeArg = rest.toLowerCase();
					if (modeArg === "on" || modeArg === "off") {
						const enabled = modeArg === "on";
						applyConfigPatch(ctx, runtime, { enabled }, (_cfg, savedPath) =>
							`已${enabled ? "启用" : "停用"} Pi-Fusion 动态路由（已保存至 ${savedPath}）`);
						return;
					}
					if (modeArg !== "auto" && modeArg !== "observe") {
						sendCommandOutput(ctx, "用法: /fusion mode <auto|observe|on|off>", "warning");
						return;
					}
					applyConfigPatch(ctx, runtime, { mode: modeArg }, (cfg, savedPath) =>
						`已切换运行模式为 ${cfg.mode}（已保存至 ${savedPath}）`);
					return;
				}
				case "enable":
				case "disable": {
					const enabled = sub === "enable";
					applyConfigPatch(ctx, runtime, { enabled }, (_cfg, savedPath) =>
						`已${enabled ? "启用" : "停用"} Pi-Fusion 动态路由（已保存至 ${savedPath}）`);
					return;
				}
				case "reload":
					reloadConfiguration(ctx, runtime);
					return;
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
