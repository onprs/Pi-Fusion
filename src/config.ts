import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	CONFIG_FILE_NAME,
	DEFAULT_CLASSIFIER_TIMEOUT_MS,
	DEFAULT_EFFORTS,
	DEFAULT_FUSION_ROUTER_CONFIG,
	DEFAULT_MIN_SWITCH_BENEFIT_CONFIDENCE,
	DEFAULT_MIN_SWITCH_CONFIDENCE,
	DEFAULT_VIRTUAL_THINKING_LEVELS,
	MAX_CLASSIFIER_TIMEOUT_MS,
	MAX_CONFIGURED_CANDIDATES,
	MIN_CLASSIFIER_TIMEOUT_MS,
} from "./constants.ts";
import type {
	CandidateModelProfile,
	ClassifierConfig,
	ClassifierCustomEndpointConfig,
	ClassifierRef,
	CostTier,
	FusionRouterConfig,
	FusionRouterMode,
	HealthConfig,
	LoadedConfigResult,
	PartialFusionRouterConfig,
	RedecisionConfig,
	SupportedClassifierApi,
	ThinkingSelectionMode,
	UIConfig,
	VirtualModelConfig,
} from "./types.ts";

const VALID_THINKING_LEVELS = new Set<string>(DEFAULT_VIRTUAL_THINKING_LEVELS);
const VALID_COST_TIERS = new Set<CostTier>(["budget", "balanced", "premium"]);
const VALID_CLASSIFIER_APIS = new Set<SupportedClassifierApi>([
	"typesafe-system-one",
	"cloudflare-workers-ai-system-one",
	"openai-decisions",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function normalizeThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	return VALID_THINKING_LEVELS.has(value) ? (value as ModelThinkingLevel) : undefined;
}

/** 构造模型唯一键 `provider/id` */
export function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/** 拆分 `provider/id` 键，支持模型 ID 中包含 `/`（如 OpenRouter 模型名） */
export function parseModelKey(key: string): { provider: string; id: string } | undefined {
	const trimmed = key.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slashIndex).trim();
	const id = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !id) return undefined;
	return { provider, id };
}

/** 获取全局配置目录（遵循 Pi 的 PI_CODING_AGENT_DIR 约定） */
export function getGlobalAgentDir(agentDir?: string): string {
	if (agentDir) return agentDir;
	const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
	return envDir || join(homedir(), ".pi", "agent");
}

/** 获取全局配置路径 */
export function getGlobalConfigPath(agentDir?: string): string {
	return join(getGlobalAgentDir(agentDir), CONFIG_FILE_NAME);
}

/** 获取项目级配置路径 */
export function getProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILE_NAME);
}

/** 深拷贝默认配置 */
export function createDefaultConfig(): FusionRouterConfig {
	return {
		version: 1,
		enabled: DEFAULT_FUSION_ROUTER_CONFIG.enabled,
		mode: DEFAULT_FUSION_ROUTER_CONFIG.mode,
		virtualModel: {
			...DEFAULT_FUSION_ROUTER_CONFIG.virtualModel,
			thinkingLevels: [...(DEFAULT_FUSION_ROUTER_CONFIG.virtualModel.thinkingLevels ?? DEFAULT_VIRTUAL_THINKING_LEVELS)],
		},
		classifier: {
			...DEFAULT_FUSION_ROUTER_CONFIG.classifier,
			fallbackChain: [],
		},
		models: [],
		fallbackChain: [],
		efforts: { ...DEFAULT_EFFORTS },
		thinkingMode: DEFAULT_FUSION_ROUTER_CONFIG.thinkingMode,
		redecision: { ...DEFAULT_FUSION_ROUTER_CONFIG.redecision },
		health: { ...DEFAULT_FUSION_ROUTER_CONFIG.health },
		preferences: DEFAULT_FUSION_ROUTER_CONFIG.preferences,
		ui: { ...DEFAULT_FUSION_ROUTER_CONFIG.ui },
	};
}

/** 解析字符串或对象形式的旧版模型配置项 */
function parseLegacyModelSpec(
	entry: unknown,
	defaultCostTier: CostTier,
	defaultPriority: number,
	defaultSpecialty: string,
	defaultThinking?: ModelThinkingLevel,
): CandidateModelProfile | undefined {
	if (typeof entry === "string") {
		const parsed = parseModelKey(entry);
		if (!parsed) return undefined;
		return {
			provider: parsed.provider,
			id: parsed.id,
			enabled: true,
			priority: defaultPriority,
			costTier: defaultCostTier,
			specialty: defaultSpecialty,
			defaultThinking,
		};
	}
	if (!isPlainObject(entry)) return undefined;

	let provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
	let id = typeof entry.id === "string" ? entry.id.trim() : "";
	if ((!provider || !id) && typeof entry.model === "string") {
		const parsed = parseModelKey(entry.model);
		if (parsed) {
			provider = parsed.provider;
			id = parsed.id;
		}
	}
	if (!provider || !id) return undefined;

	const tier = typeof entry.costTier === "string" && VALID_COST_TIERS.has(entry.costTier as CostTier)
		? (entry.costTier as CostTier)
		: defaultCostTier;
	return {
		provider,
		id,
		label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : undefined,
		enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
		priority: clampNumber(entry.priority, defaultPriority, 1, 100),
		costTier: tier,
		specialty: typeof entry.specialty === "string" && entry.specialty.trim()
			? entry.specialty.trim()
			: defaultSpecialty,
		avoid: typeof entry.avoid === "string" && entry.avoid.trim() ? entry.avoid.trim() : undefined,
		defaultThinking: normalizeThinkingLevel(entry.defaultThinking ?? entry.thinkingLevel) ?? defaultThinking,
	};
}

/**
 * 自动迁移旧版配置格式：
 * 1. yeliu84/pi-model-router: { models: { high, medium, low }, classifier, fallbackOrder, ... }
 * 2. precision-router 风格: { tiers: { high, medium, low }, ... }
 */
export function migrateLegacyConfig(raw: unknown): {
	patch: PartialFusionRouterConfig;
	migratedFrom?: string;
	warnings: string[];
} {
	const warnings: string[] = [];
	if (!isPlainObject(raw)) {
		return { patch: {}, warnings };
	}

	// 检测旧版三档对象 models: { high, medium, low } 或 tiers: { high, medium, low }
	const tierContainer = isPlainObject(raw.models)
		? raw.models
		: isPlainObject(raw.tiers)
			? raw.tiers
			: undefined;

	if (!tierContainer) {
		return {
			patch: raw as PartialFusionRouterConfig,
			warnings,
		};
	}

	const convertedModels: CandidateModelProfile[] = [];
	const tierDefs: Array<{
		key: string;
		costTier: CostTier;
		priority: number;
		specialty: string;
		thinking?: ModelThinkingLevel;
	}> = [
		{
			key: "high",
			costTier: "premium",
			priority: 90,
			specialty: "Complex architecture, deep reasoning, hard debugging, and multi-file refactoring",
			thinking: "high",
		},
		{
			key: "medium",
			costTier: "balanced",
			priority: 75,
			specialty: "Standard software engineering, feature implementation, and bug fixes",
			thinking: "medium",
		},
		{
			key: "low",
			costTier: "budget",
			priority: 55,
			specialty: "Fast lookups, simple edits, summarization, and routine tasks",
			thinking: "low",
		},
	];

	for (const tier of tierDefs) {
		const candidate = tierContainer[tier.key];
		if (!candidate) continue;
		const parsed = parseLegacyModelSpec(candidate, tier.costTier, tier.priority, tier.specialty, tier.thinking);
		if (parsed) {
			convertedModels.push(parsed);
		} else {
			warnings.push(`旧版配置中的 ${tier.key} 模型格式无效，已跳过`);
		}
	}

	// 若同时存在自定义 extra/candidates 数组，一并保留
	if (Array.isArray(raw.candidates)) {
		for (const item of raw.candidates) {
			const parsed = parseLegacyModelSpec(item, "balanced", 60, "");
			if (parsed) convertedModels.push(parsed);
		}
	}

	const patch: PartialFusionRouterConfig = {
		...(raw as PartialFusionRouterConfig),
		version: 1,
		models: convertedModels,
	};

	if (Array.isArray(raw.fallbackOrder) && !Array.isArray(raw.fallbackChain)) {
		patch.fallbackChain = raw.fallbackOrder.filter((v): v is string => typeof v === "string");
	}

	const sourceName = isPlainObject(raw.tiers) ? "legacy-tiers" : "legacy-3-tier-models";
	return {
		patch,
		migratedFrom: sourceName,
		warnings,
	};
}

function normalizeCandidateProfile(raw: unknown, index: number, warnings: string[]): CandidateModelProfile | undefined {
	if (!isPlainObject(raw)) {
		warnings.push(`models[${index}] 不是对象，已忽略`);
		return undefined;
	}
	let provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
	let id = typeof raw.id === "string" ? raw.id.trim() : "";
	if ((!provider || !id) && typeof raw.key === "string") {
		const parsed = parseModelKey(raw.key);
		if (parsed) {
			provider = parsed.provider;
			id = parsed.id;
		}
	}
	if (!provider || !id) {
		warnings.push(`models[${index}] 缺少有效的 provider 或 id，已忽略`);
		return undefined;
	}

	const costTier: CostTier = typeof raw.costTier === "string" && VALID_COST_TIERS.has(raw.costTier as CostTier)
		? (raw.costTier as CostTier)
		: "balanced";
	if (raw.costTier !== undefined && !VALID_COST_TIERS.has(raw.costTier as CostTier)) {
		warnings.push(`models[${index}] 的 costTier "${String(raw.costTier)}" 无效，已回退为 balanced`);
	}

	const rawPriority = raw.priority;
	const priority = clampNumber(rawPriority, 50, 1, 100);
	if (rawPriority !== undefined && (typeof rawPriority !== "number" || !Number.isFinite(rawPriority) || rawPriority < 1 || rawPriority > 100)) {
		warnings.push(`models[${index}] 的 priority 越界或无效，已钳位至 ${priority}`);
	}

	let effortMap: Partial<Record<string, ModelThinkingLevel>> | undefined;
	if (isPlainObject(raw.effortMap)) {
		effortMap = {};
		for (const [effortKey, targetLevel] of Object.entries(raw.effortMap)) {
			const normalizedLevel = normalizeThinkingLevel(targetLevel);
			if (normalizedLevel) {
				effortMap[effortKey] = normalizedLevel;
			} else {
				warnings.push(`models[${index}].effortMap.${effortKey} 值无效，已忽略`);
			}
		}
		if (Object.keys(effortMap).length === 0) effortMap = undefined;
	}

	const defaultThinking = normalizeThinkingLevel(raw.defaultThinking);
	if (raw.defaultThinking !== undefined && !defaultThinking) {
		warnings.push(`models[${index}].defaultThinking "${String(raw.defaultThinking)}" 无效，已忽略`);
	}

	const contextWindow = typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0
		? Math.floor(raw.contextWindow)
		: undefined;
	const maxTokens = typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0
		? Math.floor(raw.maxTokens)
		: undefined;

	return {
		provider,
		id,
		label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined,
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
		priority,
		costTier,
		specialty: typeof raw.specialty === "string" ? raw.specialty.trim() : "",
		avoid: typeof raw.avoid === "string" && raw.avoid.trim() ? raw.avoid.trim() : undefined,
		defaultThinking,
		effortMap,
		contextWindow,
		maxTokens,
	};
}

const PROFILE_OVERRIDE_FIELDS = [
	"label",
	"enabled",
	"priority",
	"costTier",
	"specialty",
	"avoid",
	"defaultThinking",
	"effortMap",
	"contextWindow",
	"maxTokens",
] as const satisfies readonly (keyof CandidateModelProfile)[];

/** 按 provider/id 合并候选模型：已存在的模型只覆盖补丁中显式提供的字段 */
function mergeCandidateArrays(
	base: CandidateModelProfile[],
	override: unknown[],
	warnings: string[],
): CandidateModelProfile[] {
	const merged = new Map<string, CandidateModelProfile>();
	for (const item of base) {
		merged.set(modelKey(item.provider, item.id), { ...item });
	}
	const seenOverride = new Set<string>();
	for (let i = 0; i < override.length; i++) {
		const rawEntry = override[i];
		const normalized = normalizeCandidateProfile(rawEntry, i, warnings);
		if (!normalized) continue;
		const key = modelKey(normalized.provider, normalized.id);
		if (seenOverride.has(key)) {
			warnings.push(`候选模型 "${key}" 重复定义，已保留后者`);
		}
		seenOverride.add(key);
		const existing = merged.get(key);
		if (existing && isPlainObject(rawEntry)) {
			const combined: CandidateModelProfile = { ...existing };
			const target = combined as unknown as Record<string, unknown>;
			for (const field of PROFILE_OVERRIDE_FIELDS) {
				if (Object.hasOwn(rawEntry, field)) target[field] = normalized[field];
			}
			merged.set(key, combined);
		} else {
			merged.set(key, normalized);
		}
	}
	const result = Array.from(merged.values());
	if (result.length > MAX_CONFIGURED_CANDIDATES) {
		warnings.push(`候选模型数量超过上限 ${MAX_CONFIGURED_CANDIDATES}，已截断多余条目`);
		return result.slice(0, MAX_CONFIGURED_CANDIDATES);
	}
	return result;
}

/** 校验并合并局部配置到基础配置 */
export function mergeAndValidateConfig(
	base: FusionRouterConfig,
	rawOverride: unknown,
	warnings: string[] = [],
): { config: FusionRouterConfig; migratedFrom?: string } {
	const { patch, migratedFrom, warnings: migrateWarnings } = migrateLegacyConfig(rawOverride);
	warnings.push(...migrateWarnings);

	if (!isPlainObject(patch)) {
		warnings.push("配置根节点不是有效对象，已使用默认配置");
		return { config: base, migratedFrom };
	}

	const next: FusionRouterConfig = {
		...base,
		virtualModel: { ...base.virtualModel },
		classifier: {
			...base.classifier,
			customEndpoint: base.classifier.customEndpoint ? { ...base.classifier.customEndpoint } : undefined,
			fallbackChain: [...base.classifier.fallbackChain],
		},
		models: base.models.map((m) => ({ ...m, effortMap: m.effortMap ? { ...m.effortMap } : undefined })),
		fallbackChain: [...base.fallbackChain],
		efforts: { ...base.efforts },
		redecision: { ...base.redecision },
		health: { ...base.health },
		ui: { ...base.ui },
	};

	if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
	if (patch.mode === "auto" || patch.mode === "observe") {
		next.mode = patch.mode;
	} else if (patch.mode !== undefined) {
		warnings.push(`无效的 mode "${String(patch.mode)}"，已保留 "${next.mode}"`);
	}

	if (isPlainObject(patch.virtualModel)) {
		const vm = patch.virtualModel as Partial<VirtualModelConfig>;
		if (typeof vm.provider === "string" && vm.provider.trim()) next.virtualModel.provider = vm.provider.trim();
		if (typeof vm.id === "string" && vm.id.trim()) next.virtualModel.id = vm.id.trim();
		if (typeof vm.name === "string" && vm.name.trim()) next.virtualModel.name = vm.name.trim();
		if (Array.isArray(vm.thinkingLevels)) {
			const levels = vm.thinkingLevels
				.map((v) => normalizeThinkingLevel(v))
				.filter((v): v is ModelThinkingLevel => v !== undefined);
			if (levels.length > 0) next.virtualModel.thinkingLevels = Array.from(new Set(levels));
		}
		if (typeof vm.contextWindow === "number" && Number.isFinite(vm.contextWindow) && vm.contextWindow > 0) {
			next.virtualModel.contextWindow = Math.floor(vm.contextWindow);
		}
		if (typeof vm.maxTokens === "number" && Number.isFinite(vm.maxTokens) && vm.maxTokens > 0) {
			next.virtualModel.maxTokens = Math.floor(vm.maxTokens);
		}
	}

	if (isPlainObject(patch.classifier)) {
		const cl = patch.classifier as Record<string, unknown>;
		if (typeof cl.provider === "string" && cl.provider.trim()) next.classifier.provider = cl.provider.trim();
		if (typeof cl.model === "string" && cl.model.trim()) next.classifier.model = cl.model.trim();
		if (cl.timeoutMs !== undefined) {
			const clamped = Math.round(
				clampNumber(cl.timeoutMs, DEFAULT_CLASSIFIER_TIMEOUT_MS, MIN_CLASSIFIER_TIMEOUT_MS, MAX_CLASSIFIER_TIMEOUT_MS),
			);
			if (clamped !== cl.timeoutMs) {
				warnings.push(`classifier.timeoutMs 越界或无效，已调整为 ${clamped}ms`);
			}
			next.classifier.timeoutMs = clamped;
		}
		if (cl.minConfidence !== undefined) {
			const clamped = clampNumber(cl.minConfidence, DEFAULT_MIN_SWITCH_CONFIDENCE, 0, 1);
			if (clamped !== cl.minConfidence) {
				warnings.push(`classifier.minConfidence 越界，已调整为 ${clamped}`);
			}
			next.classifier.minConfidence = clamped;
		}
		if (cl.customEndpoint === null) {
			next.classifier.customEndpoint = undefined;
		} else if (isPlainObject(cl.customEndpoint)) {
			const ep = cl.customEndpoint as Record<string, unknown>;
			const endpoint: ClassifierCustomEndpointConfig = {
				...(next.classifier.customEndpoint ?? {}),
			};
			if (typeof ep.providerId === "string" && ep.providerId.trim()) endpoint.providerId = ep.providerId.trim();
			if (typeof ep.baseUrl === "string") endpoint.baseUrl = ep.baseUrl.trim();
			if (typeof ep.api === "string" && VALID_CLASSIFIER_APIS.has(ep.api as SupportedClassifierApi)) {
				endpoint.api = ep.api as SupportedClassifierApi;
			} else if (ep.api !== undefined) {
				warnings.push(`classifier.customEndpoint.api "${String(ep.api)}" 无效，已忽略`);
			}
			if (typeof ep.apiKeyEnv === "string" && ep.apiKeyEnv.trim()) endpoint.apiKeyEnv = ep.apiKeyEnv.trim();
			if (typeof ep.importFromPiClassifier === "boolean") {
				endpoint.importFromPiClassifier = ep.importFromPiClassifier;
			}
			next.classifier.customEndpoint = endpoint;
		}
		const fallbackRaw = Array.isArray(cl.fallbackChain)
			? cl.fallbackChain
			: Array.isArray(cl.FallbackChain)
				? cl.FallbackChain
				: undefined;
		if (fallbackRaw) {
			const chain: ClassifierRef[] = [];
			for (const entry of fallbackRaw) {
				if (isPlainObject(entry) && typeof entry.provider === "string" && typeof entry.model === "string") {
					const p = entry.provider.trim();
					const m = entry.model.trim();
					if (p && m) chain.push({ provider: p, model: m });
				} else if (typeof entry === "string") {
					const parsed = parseModelKey(entry);
					if (parsed) chain.push({ provider: parsed.provider, model: parsed.id });
				}
			}
			next.classifier.fallbackChain = chain;
		}
	}

	if (Array.isArray(patch.models)) {
		next.models = mergeCandidateArrays(next.models, patch.models, warnings);
	}

	if (typeof patch.defaultModel === "string") {
		const trimmed = patch.defaultModel.trim();
		if (trimmed === "") {
			next.defaultModel = undefined;
		} else if (parseModelKey(trimmed)) {
			next.defaultModel = trimmed;
		} else {
			warnings.push(`defaultModel "${trimmed}" 格式无效，应为 provider/id`);
		}
	}

	if (Array.isArray(patch.fallbackChain)) {
		next.fallbackChain = patch.fallbackChain
			.map((v) => (typeof v === "string" ? v.trim() : ""))
			.filter((v) => Boolean(parseModelKey(v)));
	}

	if (isPlainObject(patch.efforts)) {
		const validEfforts: Record<string, string> = {};
		for (const [k, v] of Object.entries(patch.efforts)) {
			if (k.trim() && typeof v === "string" && v.trim()) {
				validEfforts[k.trim()] = v.trim();
			}
		}
		if (Object.keys(validEfforts).length > 0) {
			next.efforts = validEfforts;
		}
	}

	if (patch.thinkingMode === "auto" || patch.thinkingMode === "passthrough" || patch.thinkingMode === "profile-default") {
		next.thinkingMode = patch.thinkingMode;
	} else if (patch.thinkingMode !== undefined) {
		warnings.push(`无效的 thinkingMode "${String(patch.thinkingMode)}"，已保留 "${next.thinkingMode}"`);
	}

	if (isPlainObject(patch.redecision)) {
		const rd = patch.redecision as Partial<RedecisionConfig>;
		if (typeof rd.stickyDuringToolLoop === "boolean") next.redecision.stickyDuringToolLoop = rd.stickyDuringToolLoop;
		if (rd.redecideOnConsecutiveToolErrors !== undefined) {
			next.redecision.redecideOnConsecutiveToolErrors = Math.floor(
				clampNumber(rd.redecideOnConsecutiveToolErrors, base.redecision.redecideOnConsecutiveToolErrors, 0, 20),
			);
		}
		if (rd.periodicReviewSteps !== undefined) {
			next.redecision.periodicReviewSteps = Math.floor(
				clampNumber(rd.periodicReviewSteps, base.redecision.periodicReviewSteps, 0, 100),
			);
		}
		if (typeof rd.redecideOnTaskShift === "boolean") next.redecision.redecideOnTaskShift = rd.redecideOnTaskShift;
		if (rd.minSwitchBenefitConfidence !== undefined) {
			next.redecision.minSwitchBenefitConfidence = clampNumber(
				rd.minSwitchBenefitConfidence,
				DEFAULT_MIN_SWITCH_BENEFIT_CONFIDENCE,
				0,
				1,
			);
		}
		if (typeof rd.protectThinkingSignature === "boolean") {
			next.redecision.protectThinkingSignature = rd.protectThinkingSignature;
		}
	}

	if (isPlainObject(patch.health)) {
		const h = patch.health as Partial<HealthConfig>;
		if (typeof h.enabled === "boolean") next.health.enabled = h.enabled;
		if (typeof h.autoFailover === "boolean") next.health.autoFailover = h.autoFailover;
		if (h.cooldownSeconds !== undefined) {
			next.health.cooldownSeconds = Math.floor(clampNumber(h.cooldownSeconds, base.health.cooldownSeconds, 5, 3600));
		}
		if (h.maxCooldownSeconds !== undefined) {
			next.health.maxCooldownSeconds = Math.floor(
				clampNumber(h.maxCooldownSeconds, base.health.maxCooldownSeconds, next.health.cooldownSeconds, 86400),
			);
		}
		if (next.health.maxCooldownSeconds < next.health.cooldownSeconds) {
			next.health.maxCooldownSeconds = next.health.cooldownSeconds;
		}
	}

	if (typeof patch.preferences === "string") {
		next.preferences = patch.preferences.trim();
	}

	if (isPlainObject(patch.ui)) {
		const u = patch.ui as Partial<UIConfig>;
		if (typeof u.showStatusBar === "boolean") next.ui.showStatusBar = u.showStatusBar;
		if (typeof u.notifyOnSwitch === "boolean") next.ui.notifyOnSwitch = u.notifyOnSwitch;
		if (typeof u.notifyOnFailover === "boolean") next.ui.notifyOnFailover = u.notifyOnFailover;
	}

	return { config: next, migratedFrom };
}

function readJsonFileSafe(filePath: string, warnings: string[]): { exists: boolean; data?: unknown } {
	if (!existsSync(filePath)) return { exists: false };
	try {
		const content = readFileSync(filePath, "utf8");
		if (!content.trim()) return { exists: true, data: {} };
		return { exists: true, data: JSON.parse(content) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`读取配置文件失败 (${filePath}): ${message}`);
		return { exists: true, data: undefined };
	}
}

/**
 * 加载并合并配置：默认配置 < 全局配置 < 项目配置
 */
export function loadFusionRouterConfig(options?: {
	cwd?: string;
	agentDir?: string;
}): LoadedConfigResult {
	const cwd = options?.cwd ?? process.cwd();
	const globalPath = getGlobalConfigPath(options?.agentDir);
	const projectPath = getProjectConfigPath(cwd);
	const warnings: string[] = [];

	let config = createDefaultConfig();
	let migratedFrom: string | undefined;

	const globalFile = readJsonFileSafe(globalPath, warnings);
	if (globalFile.exists && globalFile.data !== undefined) {
		const res = mergeAndValidateConfig(config, globalFile.data, warnings);
		config = res.config;
		if (res.migratedFrom) migratedFrom = res.migratedFrom;
	}

	const projectFile = readJsonFileSafe(projectPath, warnings);
	if (projectFile.exists && projectFile.data !== undefined) {
		const res = mergeAndValidateConfig(config, projectFile.data, warnings);
		config = res.config;
		if (res.migratedFrom) migratedFrom = res.migratedFrom;
	}

	return {
		config,
		globalPath,
		projectPath,
		globalExists: globalFile.exists,
		projectExists: projectFile.exists,
		warnings,
		migratedFrom,
	};
}

/**
 * 原子写入 JSON 文件（先写临时文件再 rename，保证跨平台与崩溃安全）
 */
function writeJsonFileAtomic(targetPath: string, data: unknown): void {
	mkdirSync(dirname(targetPath), { recursive: true });
	const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
	const serialized = `${JSON.stringify(data, null, 2)}\n`;
	try {
		writeFileSync(tempPath, serialized, "utf8");
		renameSync(tempPath, targetPath);
	} catch (error) {
		try {
			if (existsSync(tempPath)) rmSync(tempPath, { force: true });
		} catch {
			// 忽略临时文件清理异常
		}
		throw error;
	}
}

function resolveScopePath(options?: { scope?: "global" | "project"; cwd?: string; agentDir?: string }): string {
	return (options?.scope ?? "global") === "project"
		? getProjectConfigPath(options?.cwd ?? process.cwd())
		: getGlobalConfigPath(options?.agentDir);
}

/**
 * 将完整配置原子写入指定层级文件（覆盖该文件全部内容）
 */
export function saveFusionRouterConfig(
	config: FusionRouterConfig,
	options?: {
		scope?: "global" | "project";
		cwd?: string;
		agentDir?: string;
	},
): string {
	const targetPath = resolveScopePath(options);
	writeJsonFileAtomic(targetPath, config);
	return targetPath;
}

function rawModelKey(entry: Record<string, unknown>): string | undefined {
	const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (provider && id) return modelKey(provider, id);
	if (typeof entry.key === "string") {
		const parsed = parseModelKey(entry.key);
		if (parsed) return modelKey(parsed.provider, parsed.id);
	}
	return undefined;
}

function mergeRawModels(existing: unknown, patchModels: readonly unknown[]): unknown[] {
	const list: unknown[] = Array.isArray(existing)
		? existing.map((entry) => (isPlainObject(entry) ? { ...entry } : entry))
		: [];
	for (const item of patchModels) {
		if (!isPlainObject(item)) continue;
		const key = rawModelKey(item);
		if (!key) continue;
		const index = list.findIndex((entry) => isPlainObject(entry) && rawModelKey(entry) === key);
		if (index >= 0) {
			list[index] = mergeRawLayer(list[index] as Record<string, unknown>, item);
		} else {
			list.push(structuredClone(item));
		}
	}
	return list;
}

/** 将补丁深度合并到单层原始配置：对象递归合并，models 按 provider/id 合并，其余数组与标量整体替换 */
function mergeRawLayer(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...target };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (key === "models" && Array.isArray(value)) {
			result.models = mergeRawModels(result.models, value);
		} else if (isPlainObject(value) && isPlainObject(result[key])) {
			result[key] = mergeRawLayer(result[key] as Record<string, unknown>, value);
		} else {
			result[key] = structuredClone(value);
		}
	}
	return result;
}

/** 读取单层配置文件的原始对象；旧版三档格式会先转换为当前格式 */
function readConfigLayer(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	const content = readFileSync(filePath, "utf8");
	if (!content.trim()) return {};
	let data: unknown;
	try {
		data = JSON.parse(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`配置文件不是有效的 JSON，请先修复后再保存 (${filePath}): ${message}`);
	}
	if (!isPlainObject(data)) {
		throw new Error(`配置文件根节点不是对象，请先修复后再保存 (${filePath})`);
	}
	const { patch, migratedFrom } = migrateLegacyConfig(data);
	return migratedFrom ? (patch as Record<string, unknown>) : data;
}

/**
 * 仅将补丁合并写入指定层级的配置文件，保留该文件原有内容，不写入其他层级的合并结果
 */
export function saveConfigPatchToLayer(
	patch: PartialFusionRouterConfig,
	options?: {
		scope?: "global" | "project";
		cwd?: string;
		agentDir?: string;
	},
): string {
	const targetPath = resolveScopePath(options);
	const layer = readConfigLayer(targetPath);
	const next = mergeRawLayer(layer, patch as Record<string, unknown>);
	if (next.version === undefined) next.version = 1;
	writeJsonFileAtomic(targetPath, next);
	return targetPath;
}
