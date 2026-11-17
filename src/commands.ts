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
import { resolveThinkingLevel } from "./effort.ts";
import type { ModelHealthTracker } from "./health.ts";
import type {
	CandidateModelPatch,
	CandidateModelProfile,
	CostTier,
	FusionRouteState,
	FusionRouterConfig,
	LoadedConfigResult,
	PartialFusionRouterConfig,
	SupportedClassifierApi,
} from "./types.ts";
import { classifierChoiceToPatch, formatClassifierChoice, openFusionSettingsPanel, updateRouterStatusBar } from "./ui.ts";

type SaveScope = "global" | "project";

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
	{ value: "config", label: "config", description: "打开交互式路由设置面板" },
	{ value: "models", label: "models", description: "管理候选物理模型池" },
	{ value: "classifier", label: "classifier", description: "查看或切换专用决策分类器" },
	{ value: "health", label: "health", description: "查看或重置模型健康冷却状态" },
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

const PROFILE_FIELDS = ["priority", "costTier", "thinking", "specialty", "avoid", "label"] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

const COST_TIERS: readonly CostTier[] = ["budget", "balanced", "premium"];
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CLASSIFIER_APIS: readonly SupportedClassifierApi[] = [
	"typesafe-system-one",
	"cloudflare-workers-ai-system-one",
	"openai-decisions",
];

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

function scopeLabel(scope: SaveScope): string {
	return scope === "project" ? "项目配置" : "全局配置";
}

function defaultSaveScope(runtime: FusionCommandRuntime): SaveScope {
	return runtime.getLoadedConfig().projectExists ? "project" : "global";
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

async function handleStatus(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): Promise<void> {
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
	const classifiers = await resolveClassifierChain(ctx.modelRegistry, config.classifier);
	const cooling = healthTracker
		.listSnapshots(pool.allResolved.map((c) => c.key), config.health)
		.filter((s) => s.status === "cooldown");

	const lines = [
		`Pi-Fusion 路由状态`,
		`开关: ${config.enabled ? "已启用" : "已停用"} | 模式: ${config.mode}`,
		`虚拟模型: ${config.virtualModel.provider}/${config.virtualModel.id}`,
		`决策分类器: ${classifiers.length > 0 ? classifiers[0]!.key : "未检测到可用分类器"} (备选 ${Math.max(0, classifiers.length - 1)} 个)`,
		`候选物理池: 共 ${pool.allResolved.length} 个 (可用 ${pool.allResolved.length - cooling.length} 个${pool.discoveredFromRegistry ? "，自动发现" : ""})`,
	];
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

// ───────────────────────── 决策分类器 ─────────────────────────

async function listClassifiers(ctx: ExtensionCommandContext, config: FusionRouterConfig): Promise<void> {
	const chain = await resolveClassifierChain(ctx.modelRegistry, config.classifier);
	const lines = [
		`决策分类器配置: ${formatClassifierChoice(config)} (超时 ${config.classifier.timeoutMs}ms，最低置信度 ${config.classifier.minConfidence})`,
	];
	const custom = resolveCustomClassifierTarget(config.classifier);
	if (custom) {
		lines.push(`自定义端点: ${custom.baseUrl} (${custom.api}，模型 ${custom.modelId})`);
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
	sendCommandOutput(ctx, lines.join("\n"));
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
		const custom = resolveCustomClassifierTarget(config.classifier);
		const provider = config.classifier.provider;
		const resetProvider = provider === "custom" || (custom !== undefined && provider === custom.providerId);
		applyConfigPatch(
			ctx,
			runtime,
			{ classifier: { customEndpoint: null, ...(resetProvider ? { provider: "auto" } : {}) } },
			(_cfg, savedPath) => `已清除自定义决策端点（已保存至 ${savedPath}）`,
		);
		return;
	}

	let baseUrl: string;
	try {
		const url = new URL(first);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
		baseUrl = first.replace(/\/+$/, "");
	} catch {
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

async function handleClassifier(
	ctx: ExtensionCommandContext,
	runtime: FusionCommandRuntime,
	restArgs: string,
): Promise<void> {
	const config = runtime.getLoadedConfig().config;
	const tokens = restArgs.trim().split(/\s+/).filter(Boolean);
	const sub = tokens[0]?.toLowerCase();

	if (!sub) {
		if (!ctx.hasUI) {
			await listClassifiers(ctx, config);
			return;
		}
		const chain = await resolveClassifierChain(ctx.modelRegistry, config.classifier);
		const current = formatClassifierChoice(config);
		const choices = Array.from(new Set(["auto", ...chain.map((c) => c.key)]));
		const options = choices.map((choice) => (choice === current ? `${choice}（当前）` : choice));
		const picked = await ctx.ui.select("选择专用决策分类器", options);
		if (!picked) return;
		const choice = choices[options.indexOf(picked)];
		if (!choice || choice === current) return;
		const patch = classifierChoiceToPatch(choice);
		if (!patch) return;
		applyConfigPatch(ctx, runtime, patch, (cfg, savedPath) =>
			`已将决策分类器设置为 ${formatClassifierChoice(cfg)}（已保存至 ${savedPath}）`,
		);
		return;
	}

	switch (sub) {
		case "list":
			await listClassifiers(ctx, config);
			return;
		case "import": {
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
			);
			return;
		}
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

/** 交互式编辑单个候选模型 */
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

	const options = [
		p.enabled ? "停用该模型" : "启用该模型",
		isDefault ? "取消默认回退模型" : "设为默认回退模型",
		`优先级：${p.priority}`,
		`成本档位：${p.costTier}`,
		`默认思考强度：${p.defaultThinking ?? "auto"}`,
		`擅长场景：${p.specialty || "未设置"}`,
		`不适用场景：${p.avoid || "未设置"}`,
	];
	const picked = await ctx.ui.select(`模型 ${key}`, options);
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
	}
}

/** 交互式候选模型管理菜单 */
async function openModelsManager(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime): Promise<void> {
	let scope = defaultSaveScope(runtime);
	for (;;) {
		const config = runtime.getLoadedConfig().config;
		const { entries, discovered } = listManagedModels(ctx, config);
		const healthTracker = runtime.getHealthTracker();
		const scopeOption = `保存位置：${scopeLabel(scope)}`;
		const importOption = "导入全部已认证物理模型";
		const modelOptions = entries.map((entry) => formatModelLine(entry, config, healthTracker));
		const title = discovered
			? `候选模型管理（自动发现 ${entries.length} 个，修改后保存为配置）`
			: `候选模型管理（${entries.length} 个）`;

		const picked = await ctx.ui.select(title, [scopeOption, importOption, ...modelOptions]);
		if (!picked) return;
		if (picked === scopeOption) {
			scope = scope === "project" ? "global" : "project";
			continue;
		}
		if (picked === importOption) {
			importModels(ctx, runtime, scope);
			continue;
		}
		const entry = entries[modelOptions.indexOf(picked)];
		if (entry) await editManagedModel(ctx, runtime, entry.key, scope);
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

// ───────────────────────── 健康与测试 ─────────────────────────

function handleHealth(ctx: ExtensionCommandContext, runtime: FusionCommandRuntime, restArgs: string): void {
	const config = runtime.getLoadedConfig().config;
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
	const config = runtime.getLoadedConfig().config;
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
				return [{ value: "health reset", label: "health reset", description: "清除冷却记录" }];
			}
			return SUBCOMMANDS.filter((item) => item.value.startsWith(trimmed.trim()));
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
						getAvailableClassifiers: async () => {
							const chain = await resolveClassifierChain(
								ctx.modelRegistry,
								runtime.getLoadedConfig().config.classifier,
							);
							return chain.map((c) => c.key);
						},
						getSaveScope: () => defaultSaveScope(runtime),
						getLastState: () => runtime.getLastState(),
						onApplyPatch: (patch, scope) => runtime.updateAndSaveConfig(patch, scope).config,
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
					await handleModels(ctx, runtime, rest);
					return;
				case "classifier":
					await handleClassifier(ctx, runtime, rest);
					return;
				case "health":
					handleHealth(ctx, runtime, rest);
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
