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
	formatClassifierChoice,
	type MenuPanelItem,
	openFusionSettingsPanel,
	openTabbedSplitWorkspace,
	selectMenuPanel,
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

function scopeLabel(scope: SaveScope): string {
	return scope === "project" ? "项目配置" : "全局配置";
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

/** 交互式决策分类器查看与管理菜单（双栏面板） */
async function openClassifierManager(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	options?: { scopeRef?: ScopeRef; exitOnSelectClassifier?: boolean },
): Promise<void> {
	const scopeRef: ScopeRef = options?.scopeRef ?? { value: defaultSaveScope(runtime) };
	for (;;) {
		const config = runtime.getLoadedConfig().config;
		const { text, chain } = await buildClassifierReport(ctx, config);
		const current = formatClassifierChoice(config);
		const classifierChoices = Array.from(new Set(["auto", ...chain.map((c) => c.key)]));
		const classifierLabels = classifierChoices.map((c) => (c === current ? `${c}（当前）` : c));

		const configureEndpointOption = "配置自定义决策端点";
		const importEndpointOption = "导入全局分类器端点设置";
		const clearEndpointOption = "清除自定义决策端点";
		const timeoutOption = `修改超时时间（当前：${config.classifier.timeoutMs}ms）`;
		const confidenceOption = `修改最低置信度（当前：${config.classifier.minConfidence}）`;
		const scopeOption = `保存位置：${scopeLabel(scopeRef.value)}`;

		const menuOptions = [
			...classifierLabels,
			configureEndpointOption,
			importEndpointOption,
			...(config.classifier.customEndpoint ? [clearEndpointOption] : []),
			timeoutOption,
			confidenceOption,
			scopeOption,
		];

		const picked = await selectMenuPanel(ctx, {
			title: "专用决策分类器管理",
			detailTitle: "分类器与端点详情",
			details: text,
			items: menuOptions,
		});
		if (!picked) return;

		if (picked === scopeOption) {
			scopeRef.value = scopeRef.value === "project" ? "global" : "project";
			continue;
		}
		if (picked === configureEndpointOption) {
			await configureCustomEndpointInteractive(ctx, runtime, scopeRef.value);
			continue;
		}
		if (picked === importEndpointOption) {
			importClassifierEndpoint(ctx, runtime, scopeRef.value);
			continue;
		}
		if (picked === clearEndpointOption) {
			clearCustomClassifierEndpoint(ctx, runtime, config, scopeRef.value);
			continue;
		}
		if (picked === timeoutOption) {
			await promptClassifierTimeout(ctx, runtime, scopeRef.value);
			continue;
		}
		if (picked === confidenceOption) {
			await promptClassifierMinConfidence(ctx, runtime, scopeRef.value);
			continue;
		}

		const idx = classifierLabels.indexOf(picked);
		const choice = idx >= 0 ? classifierChoices[idx] : undefined;
		if (!choice) continue;
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

function buildModelCardLines(
	entry: ManagedModelEntry,
	config: FusionRouterConfig,
	healthTracker: ModelHealthTracker,
): string[] {
	const p = entry.profile;
	const health = entry.available ? healthTracker.getSnapshot(entry.key, config.health) : undefined;
	const healthText = !entry.available
		? "未认证"
		: health?.status === "cooldown"
			? `冷却中（剩余 ${formatDurationSeconds(health.remainingCooldownMs)}）`
			: "健康";
	return [
		`显示名称：${p.label || p.id}`,
		`状态：${p.enabled ? "已启用" : "已停用"}   健康：${healthText}${config.defaultModel === entry.key ? "   [默认回退]" : ""}`,
		`成本档位：${p.costTier}   优先级：P${p.priority}   默认思考：${p.defaultThinking ?? "auto"}`,
		"",
		`擅长场景：`,
		p.specialty || "未设置",
		"",
		`不适用场景：`,
		p.avoid || "未设置",
	];
}

function buildModelsOverviewLines(
	ctx: ExtensionCommandContext,
	config: FusionRouterConfig,
	healthTracker: ModelHealthTracker,
): string[] {
	const { entries, discovered } = listManagedModels(ctx, config);
	if (entries.length === 0) return ["当前没有可用的已认证物理模型。"];
	const lines = [
		`来源：${discovered ? "自动发现（修改后保存为配置）" : "配置文件"}   共 ${entries.length} 个`,
		`默认回退模型：${config.defaultModel ?? "未设置（按优先级选取）"}`,
		"",
	];
	for (const entry of entries) {
		lines.push(`• ${formatModelLine(entry, config, healthTracker)}`);
	}
	return lines;
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

/** 交互式查看并编辑单个候选模型（双栏画像卡片） */
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
	const cardLines = buildModelCardLines(entry, config, runtime.getHealthTracker());

	const options = [
		p.enabled ? "停用该模型" : "启用该模型",
		isDefault ? "取消默认回退模型" : "设为默认回退模型",
		`优先级：${p.priority}`,
		`成本档位：${p.costTier}`,
		`默认思考强度：${p.defaultThinking ?? "auto"}`,
		`擅长场景：${p.specialty || "未设置"}`,
		`不适用场景：${p.avoid || "未设置"}`,
		`显示名称：${p.label || p.id}`,
	];
	const picked = await selectMenuPanel(ctx, {
		title: `模型画像详情：${key}`,
		detailTitle: key,
		details: cardLines.join("\n"),
		items: options,
	});
	if (!picked) return;

	switch (options.indexOf(picked)) {
		case 0:
			setModelEnabled(ctx, runtime, key, !p.enabled, scope);
			return;
		case 1:
			setDefaultModel(ctx, runtime, isDefault ? "clear" : key, scope);
			return;
		case 2: {
			const value = await ctx.ui.input("优先级（1~100）", String(p.priority));
			if (value === undefined || !value.trim()) return;
			setModelField(ctx, runtime, key, "priority", value, scope);
			return;
		}
		case 3: {
			const value = await ctx.ui.select("成本档位", [...COST_TIERS]);
			if (value) setModelField(ctx, runtime, key, "costTier", value, scope);
			return;
		}
		case 4: {
			const value = await ctx.ui.select("默认思考强度", ["auto", ...THINKING_LEVELS]);
			if (value) setModelField(ctx, runtime, key, "thinking", value, scope);
			return;
		}
		case 5: {
			const value = await ctx.ui.editor("擅长场景", p.specialty);
			if (value !== undefined) setModelField(ctx, runtime, key, "specialty", value, scope);
			return;
		}
		case 6: {
			const value = await ctx.ui.editor("不适用场景（留空表示清除）", p.avoid ?? "");
			if (value !== undefined) setModelField(ctx, runtime, key, "avoid", value.trim() ? value : "clear", scope);
			return;
		}
		case 7: {
			const value = await ctx.ui.input("显示名称", p.label ?? p.id);
			if (value !== undefined && value.trim()) setModelField(ctx, runtime, key, "label", value, scope);
			return;
		}
	}
}

/** 交互式候选模型管理菜单（左栏选模型，右栏实时展示该模型完整画像） */
async function openModelsManager(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scopeRef?: ScopeRef,
): Promise<void> {
	const activeScopeRef: ScopeRef = scopeRef ?? { value: defaultSaveScope(runtime) };
	let lastPicked: string | undefined;

	for (;;) {
		const config = runtime.getLoadedConfig().config;
		const { entries, discovered } = listManagedModels(ctx, config);
		const healthTracker = runtime.getHealthTracker();
		const overviewLines = buildModelsOverviewLines(ctx, config, healthTracker);

		const scopeOption = `保存位置：${scopeLabel(activeScopeRef.value)}`;
		const importOption = "导入全部已认证物理模型";

		const items: MenuPanelItem[] = [
			{
				value: scopeOption,
				label: scopeOption,
				detailTitle: "候选池概览",
				detailLines: overviewLines,
			},
			{
				value: importOption,
				label: importOption,
				detailTitle: "导入物理模型",
				detailLines: ["将当前所有已配置凭据的物理模型写入配置文件，便于逐个调整画像参数。", "", ...overviewLines],
			},
			...entries.map((entry): MenuPanelItem => {
				const line = formatModelLine(entry, config, healthTracker);
				return {
					value: line,
					label: line,
					detailTitle: `模型画像：${entry.key}`,
					detailLines: buildModelCardLines(entry, config, healthTracker),
				};
			}),
		];

		const defaultNote = config.defaultModel ? ` • 默认模型：${config.defaultModel}` : "";
		const summary = discovered
			? `自动发现 ${entries.length} 个模型，修改任意项后保存为配置${defaultNote}`
			: `共 ${entries.length} 个配置模型${defaultNote}`;

		const picked = await selectMenuPanel(ctx, {
			title: "候选物理模型池管理",
			detailTitle: "候选池概览",
			details: summary,
			items,
			initialValue: lastPicked,
		});
		if (!picked) return;
		lastPicked = picked;

		if (picked === scopeOption) {
			activeScopeRef.value = activeScopeRef.value === "project" ? "global" : "project";
			continue;
		}
		if (picked === importOption) {
			importModels(ctx, runtime, activeScopeRef.value);
			continue;
		}
		const modelOptions = entries.map((entry) => formatModelLine(entry, config, healthTracker));
		const entry = entries[modelOptions.indexOf(picked)];
		if (entry) await editManagedModel(ctx, runtime, entry.key, activeScopeRef.value);
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

/** 交互式模型健康与冷却管理菜单（双栏） */
async function openHealthManager(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	scopeRef?: ScopeRef,
): Promise<void> {
	const activeScopeRef: ScopeRef = scopeRef ?? { value: defaultSaveScope(runtime) };
	const tracker = runtime.getHealthTracker();

	for (;;) {
		const config = runtime.getLoadedConfig().config;
		const { text, snapshots } = buildHealthReport(ctx, runtime);
		const degraded = snapshots.filter((s) => s.status !== "healthy");
		const resetModelOptions = degraded.map((s) =>
			s.status === "cooldown"
				? `重置模型健康状态：${s.key}（冷却 ${formatDurationSeconds(s.remainingCooldownMs)}）`
				: `重置模型健康状态：${s.key}（历史失败 ${s.consecutiveFailures} 次）`,
		);
		const resetAllOption = "重置全部模型健康状态";
		const toggleHealthOption = `健康冷却追踪：${boolText(config.health.enabled)}`;
		const toggleFailoverOption = `故障自动转移：${boolText(config.health.autoFailover)}`;
		const cooldownOption = `修改基础冷却时长（当前：${config.health.cooldownSeconds}s）`;
		const maxCooldownOption = `修改最大冷却时长（当前：${config.health.maxCooldownSeconds}s）`;
		const scopeOption = `保存位置：${scopeLabel(activeScopeRef.value)}`;

		const picked = await selectMenuPanel(ctx, {
			title: "模型健康与冷却管理",
			detailTitle: "模型健康快照",
			details: text,
			items: [
				...resetModelOptions,
				resetAllOption,
				toggleHealthOption,
				toggleFailoverOption,
				cooldownOption,
				maxCooldownOption,
				scopeOption,
			],
		});
		if (!picked) return;

		if (picked === scopeOption) {
			activeScopeRef.value = activeScopeRef.value === "project" ? "global" : "project";
			continue;
		}
		if (picked === resetAllOption) {
			tracker.reset();
			sendCommandOutput(ctx, "已重置全部模型健康状态。");
			continue;
		}
		if (picked === toggleHealthOption) {
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
		if (picked === toggleFailoverOption) {
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
		if (picked === cooldownOption) {
			await promptCooldownSeconds(ctx, runtime, activeScopeRef.value);
			continue;
		}
		if (picked === maxCooldownOption) {
			await promptMaxCooldownSeconds(ctx, runtime, activeScopeRef.value);
			continue;
		}

		const resetIdx = resetModelOptions.indexOf(picked);
		const target = resetIdx >= 0 ? degraded[resetIdx] : undefined;
		if (target) {
			tracker.reset(target.key);
			sendCommandOutput(ctx, `已重置模型健康状态: ${target.key}`);
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

async function executeDryRunTest(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	promptText: string,
): Promise<{ text: string; lines: string[]; level: "info" | "warning" }> {
	const config = runtime.getLoadedConfig().config;
	const pool = buildCandidatePool({
		modelRegistry: ctx.modelRegistry,
		config,
		healthTracker: runtime.getHealthTracker(),
	});

	if (pool.forDecision.length === 0) {
		const msg = "没有可用于测试的候选模型。";
		return { text: msg, lines: [msg], level: "warning" };
	}

	const classifiers = await resolveClassifierChain(ctx.modelRegistry, config.classifier);
	if (classifiers.length === 0) {
		const msg = "未检测到可用的专用分类器模型。";
		return { text: msg, lines: [msg], level: "warning" };
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
		return { text: msg, lines: [msg], level: "warning" };
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
	return { text: lines.join("\n"), lines, level: "info" };
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
 * 打开 /fusion 横向分区双栏路由控制中心：
 * 分为「概览与诊断」「路由策略」「模型与分类器」「健康与测试」4 个横向标签页，
 * 左栏放置紧凑操作与配置项，右栏实时展示当前分区/选中项的完整状态与配置详情。
 */
async function openFusionHub(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): Promise<void> {
	const scopeRef: ScopeRef = { value: defaultSaveScope(runtime) };
	let cachedClassifiers: DiscoveredClassifier[] = [];
	let lastTestLines: string[] | undefined;

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
		lastTestLines = res.lines;
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
		const modelsLines = buildModelsOverviewLines(ctx, config, healthTracker);
		const classifierLines = buildClassifierLinesFromChain(config, cachedClassifiers);
		const healthReport = buildHealthReport(ctx, runtime);
		const degradedSnapshots = healthReport.snapshots.filter((s) => s.status !== "healthy");
		const coolingCount = degradedSnapshots.filter((s) => s.status === "cooldown").length;

		const stateSummary = state ? `${state.selectedModel} • ${state.thinkingLevel}` : "尚未路由";
		const classifierSummary = cachedClassifiers[0]?.key ?? "未检测到分类器";
		const availableCount = pool.allResolved.length - coolingCount;

		const policySummaryLines = [
			`思考强度模式：${config.thinkingMode}`,
			`工具循环粘性保持：${boolText(config.redecision.stickyDuringToolLoop)}`,
			`新消息重新决策：${boolText(config.redecision.redecideOnTaskShift)}`,
			`思考签名保护：${boolText(config.redecision.protectThinkingSignature)}`,
			`连续工具报错阈值：${config.redecision.redecideOnConsecutiveToolErrors}`,
			`周期复查步数：${config.redecision.periodicReviewSteps}`,
			`切换收益最低置信度：${config.redecision.minSwitchBenefitConfidence}`,
			`备用模型回退链：${config.fallbackChain.length > 0 ? config.fallbackChain.join(" → ") : "未设置"}`,
			"",
			`路由偏好说明：`,
			config.preferences || "未设置",
		];

		const errValues = Array.from(
			new Set(["0", "1", "2", "3", "4", "5", String(config.redecision.redecideOnConsecutiveToolErrors)]),
		);
		const stepValues = Array.from(
			new Set(["0", "4", "8", "12", "16", "24", String(config.redecision.periodicReviewSteps)]),
		);

		// ── 分区 1：概览与诊断 ──
		const overviewItems: WorkspaceItem[] = [
			{
				id: "enabled",
				label: "路由器总开关",
				value: boolText(config.enabled),
				allowSpace: true,
				detailTitle: "路由状态概览",
				detailLines: statusLines,
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
				allowSpace: true,
				detailTitle: "路由状态概览",
				detailLines: statusLines,
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
				value: state ? state.lastDecision.trigger : "暂无记录",
				detailTitle: "最近决策诊断",
				detailLines: explainLines,
				onActivate: async () => {
					const testOpt = "执行干跑路由测试";
					const backOpt = "返回控制中心";
					const picked = await selectMenuPanel(ctx, {
						title: "最近一次路由决策详情",
						detailTitle: "决策诊断",
						details: explainLines.join("\n"),
						items: [testOpt, backOpt],
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
				detailTitle: "配置文件状态",
				detailLines: statusLines,
				onActivate: async () => {
					reloadConfiguration(ctx, runtime);
					await refreshClassifiers();
				},
			},
			{
				id: "saveScope",
				label: "配置保存位置",
				value: scopeLabel(scopeRef.value),
				allowSpace: true,
				detailTitle: "配置保存层级",
				detailLines: [
					`当前写入目标：${scopeLabel(scopeRef.value)}`,
					`全局配置路径：${loaded.globalPath}${loaded.globalExists ? " [存在]" : " [未创建]"}`,
					`项目配置路径：${loaded.projectPath}${loaded.projectExists ? " [存在]" : " [未创建]"}`,
				],
				onActivate: () => {
					scopeRef.value = scopeRef.value === "project" ? "global" : "project";
				},
			},
		];

		// ── 分区 2：路由策略 ──
		const makePolicyToggle = (params: {
			id: string;
			label: string;
			value: string;
			desc: string;
			allowSpace?: boolean;
			run: () => void | Promise<void>;
		}): WorkspaceItem => ({
			id: params.id,
			label: params.label,
			value: params.value,
			allowSpace: params.allowSpace ?? true,
			detailTitle: params.label,
			detailLines: [params.desc, "", "── 当前策略总览 ──", ...policySummaryLines],
			onActivate: async () => {
				await params.run();
			},
		});

		const policyItems: WorkspaceItem[] = [
			makePolicyToggle({
				id: "thinkingMode",
				label: "思考强度模式",
				value: config.thinkingMode,
				desc: "auto 由分类器决定；passthrough 透传当前选择；profile-default 使用模型默认档位。",
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
			makePolicyToggle({
				id: "stickyDuringToolLoop",
				label: "工具循环粘性保持",
				value: boolText(config.redecision.stickyDuringToolLoop),
				desc: "工具调用返回后优先保持当前模型，保护上下文缓存。",
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
			makePolicyToggle({
				id: "redecideOnTaskShift",
				label: "新消息重新决策",
				value: boolText(config.redecision.redecideOnTaskShift),
				desc: "收到新用户消息时重新评估模型；关闭后保持当前会话模型。",
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
			makePolicyToggle({
				id: "protectThinkingSignature",
				label: "思考签名保护",
				value: boolText(config.redecision.protectThinkingSignature),
				desc: "当前轮次已产生思考内容时避免切换模型，保留完整推理上下文。",
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
			makePolicyToggle({
				id: "redecideOnConsecutiveToolErrors",
				label: "连续工具报错阈值",
				value: String(config.redecision.redecideOnConsecutiveToolErrors),
				desc: "连续多少次工具报错后触发重新选路（0 表示关闭）。",
				run: () => {
					const next = Number(cycleString(String(config.redecision.redecideOnConsecutiveToolErrors), errValues));
					applyConfigPatch(
						ctx,
						runtime,
						{ redecision: { redecideOnConsecutiveToolErrors: next } },
						(_cfg, savedPath) => `已将连续工具报错阈值设置为 ${next}（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyToggle({
				id: "periodicReviewSteps",
				label: "周期复查步数",
				value: String(config.redecision.periodicReviewSteps),
				desc: "工具循环每执行多少步重新评估一次模型（0 表示关闭）。",
				run: () => {
					const next = Number(cycleString(String(config.redecision.periodicReviewSteps), stepValues));
					applyConfigPatch(
						ctx,
						runtime,
						{ redecision: { periodicReviewSteps: next } },
						(_cfg, savedPath) => `已将周期复查步数设置为 ${next}（已保存至 ${savedPath}）`,
						scopeRef.value,
					);
				},
			}),
			makePolicyToggle({
				id: "minSwitchBenefitConfidence",
				label: "切换收益最低置信度",
				value: String(config.redecision.minSwitchBenefitConfidence),
				allowSpace: false,
				desc: "会话已有健康模型时，切换收益评估达到该置信度（0~1）才执行切换。",
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
			makePolicyToggle({
				id: "preferences",
				label: "编辑路由偏好说明",
				value: config.preferences ? "已设置" : "未设置",
				allowSpace: false,
				desc: "向决策分类器补充自定义选路偏好说明（留空保存可清空）。",
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
			makePolicyToggle({
				id: "fallbackChain",
				label: "编辑备用模型回退链",
				value: config.fallbackChain.length > 0 ? `${config.fallbackChain.length} 个` : "未设置",
				allowSpace: false,
				desc: "分类器不可用或默认模型冷却时，按顺序尝试的备用物理模型链。",
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

		// ── 分区 3：模型与分类器 ──
		const customTarget = resolveCustomClassifierTarget(config.classifier);
		const modelsAndClassifierItems: WorkspaceItem[] = [
			{
				id: "manageModels",
				label: "管理候选物理模型池",
				value: `${pool.allResolved.length} 个${pool.discoveredFromRegistry ? "(自动)" : ""}`,
				detailTitle: "候选物理模型池",
				detailLines: modelsLines,
				onActivate: async () => {
					await openModelsManager(ctx, runtime, scopeRef);
				},
			},
			{
				id: "importModels",
				label: "导入已认证物理模型",
				value: "回车导入",
				detailTitle: "导入物理模型",
				detailLines: modelsLines,
				onActivate: () => {
					importModels(ctx, runtime, scopeRef.value);
				},
			},
			{
				id: "defaultModel",
				label: "默认回退模型",
				value: config.defaultModel ? (parseModelKey(config.defaultModel)?.id ?? config.defaultModel) : "按优先级",
				detailTitle: "候选物理模型池",
				detailLines: modelsLines,
				onActivate: async () => {
					await promptSelectDefaultModel(ctx, runtime, scopeRef.value);
				},
			},
			{
				id: "selectClassifier",
				label: "专用决策分类器",
				value: formatClassifierChoice(config),
				detailTitle: "决策分类器与可用链",
				detailLines: classifierLines,
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
				detailTitle: "自定义决策端点",
				detailLines: classifierLines,
				onActivate: async () => {
					await configureCustomEndpointInteractive(ctx, runtime, scopeRef.value);
					await refreshClassifiers();
				},
			},
			{
				id: "endpointActions",
				label: "导入或清除分类器端点",
				value: config.classifier.customEndpoint ? "导入/清除" : "从全局导入",
				detailTitle: "分类器端点操作",
				detailLines: classifierLines,
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
				detailTitle: "分类器参数",
				detailLines: classifierLines,
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

		// ── 分区 4：健康与界面 ──
		const healthAndUiLines = [
			...healthReport.lines,
			"",
			"── 界面通知设置 ──",
			`底部状态栏显示：${boolText(config.ui.showStatusBar)}`,
			`切换模型通知：${boolText(config.ui.notifyOnSwitch)}`,
			`故障转移通知：${boolText(config.ui.notifyOnFailover)}`,
		];

		const dryRunDetailLines = lastTestLines
			? [...lastTestLines, "", "── 候选池状态 ──", ...healthReport.lines.slice(0, 6)]
			: [
					"按 Enter 输入任意任务描述，测试当前分类器选路与思考强度映射结果（不产生对话消息）。",
					`默认测试示例：${DEFAULT_TEST_PROMPT}`,
					"",
					"── 当前分类器与候选池 ──",
					`主分类器：${classifierSummary}`,
					`可用候选模型：${availableCount}/${pool.allResolved.length} 个`,
				];

		const healthAndTestItems: WorkspaceItem[] = [
			{
				id: "dryRunTest",
				label: "执行干跑路由测试",
				value: lastTestLines ? "查看/重测" : "回车测试",
				detailTitle: "干跑路由测试",
				detailLines: dryRunDetailLines,
				onActivate: async () => {
					await runPromptDryTest();
				},
			},
			{
				id: "resetHealth",
				label: "重置模型健康冷却",
				value: degradedSnapshots.length > 0 ? `${degradedSnapshots.length} 个异常` : "全部健康",
				detailTitle: "模型健康与冷却",
				detailLines: healthAndUiLines,
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
				allowSpace: true,
				detailTitle: "模型健康与冷却",
				detailLines: healthAndUiLines,
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
				allowSpace: true,
				detailTitle: "模型健康与冷却",
				detailLines: healthAndUiLines,
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
				detailTitle: "退避冷却时长",
				detailLines: healthAndUiLines,
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
				allowSpace: true,
				detailTitle: "界面通知与状态栏",
				detailLines: healthAndUiLines,
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
				allowSpace: true,
				detailTitle: "界面通知与状态栏",
				detailLines: healthAndUiLines,
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
				allowSpace: true,
				detailTitle: "界面通知与状态栏",
				detailLines: healthAndUiLines,
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
			headerRight: `[${config.enabled ? `已启用 • ${config.mode}` : "已停用"}]  保存：${scopeLabel(scopeRef.value)}`,
			bannerLines: [
				`当前路由：${stateSummary}  │  分类器：${classifierSummary}  │  候选池：${availableCount}/${pool.allResolved.length} 可用`,
			],
			sections: [
				{
					id: "overview",
					title: "概览与诊断",
					detailTitle: "路由状态概览",
					detailLines: statusLines,
					items: overviewItems,
				},
				{
					id: "policy",
					title: "路由策略",
					detailTitle: "当前策略总览",
					detailLines: policySummaryLines,
					items: policyItems,
				},
				{
					id: "models_classifier",
					title: "模型与分类器",
					detailTitle: "候选池与分类器",
					detailLines: modelsLines,
					items: modelsAndClassifierItems,
				},
				{
					id: "health_test",
					title: "健康与测试",
					detailTitle: "模型健康与界面",
					detailLines: healthAndUiLines,
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
