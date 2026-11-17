import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { modelKey, parseModelKey } from "./config.ts";
import {
	BUILTIN_FAMILY_HEURISTICS,
	MAX_AUTO_DISCOVERED_CANDIDATES,
	MAX_DECISION_CANDIDATES,
} from "./constants.ts";
import type { ModelHealthTracker } from "./health.ts";
import type {
	CandidateModelProfile,
	CandidatePoolSnapshot,
	CostTier,
	FusionRouterConfig,
	ResolvedCandidate,
} from "./types.ts";

/** 根据模型名称与 ID 匹配内置家族画像 */
export function inferFamilyProfile(model: Pick<Model<Api>, "provider" | "id" | "name">): {
	costTier: CostTier;
	priority: number;
	specialty: string;
	avoid?: string;
} {
	const haystack = `${model.provider}/${model.id} ${model.name}`;
	for (const rule of BUILTIN_FAMILY_HEURISTICS) {
		if (rule.pattern.test(haystack)) {
			return {
				costTier: rule.costTier,
				priority: rule.priority,
				specialty: rule.specialty,
				avoid: rule.avoid,
			};
		}
	}
	return {
		costTier: "balanced",
		priority: 50,
		specialty: "General purpose software engineering and text generation",
	};
}

/** 补全候选模型画像（若用户未填 specialty 则应用内置家族启发式描述） */
export function enrichCandidateProfile(
	profile: CandidateModelProfile,
	physicalModel: Pick<Model<Api>, "provider" | "id" | "name">,
): CandidateModelProfile {
	if (profile.specialty.trim()) return profile;
	const inferred = inferFamilyProfile(physicalModel);
	return {
		...profile,
		specialty: inferred.specialty,
		avoid: profile.avoid ?? inferred.avoid,
	};
}

/** 判断模型是否为 Pi 虚拟模型 */
export function isVirtualCatalogModel(model: Pick<Model<Api>, "api">): boolean {
	return model.api === "pi-virtual";
}

/** 从 ModelRegistry 自动发现可用物理模型并生成默认候选池 */
export function discoverCandidatesFromRegistry(
	availablePhysicalModels: readonly Model<Api>[],
	maxCount = MAX_AUTO_DISCOVERED_CANDIDATES,
): CandidateModelProfile[] {
	const physicalOnly = availablePhysicalModels.filter((m) => !isVirtualCatalogModel(m));
	const synthesized = physicalOnly.map((m): CandidateModelProfile => {
		const inferred = inferFamilyProfile(m);
		return {
			provider: m.provider,
			id: m.id,
			label: m.name || m.id,
			enabled: true,
			priority: inferred.priority,
			costTier: inferred.costTier,
			specialty: inferred.specialty,
			avoid: inferred.avoid,
		};
	});

	if (synthesized.length <= maxCount) return synthesized;
	return selectBalancedTopProfiles(synthesized, maxCount);
}

/** 从较多候选画像中按 costTier 多样性与优先级选取代表性子集 */
function selectBalancedTopProfiles(profiles: CandidateModelProfile[], limit: number): CandidateModelProfile[] {
	const byTier: Record<CostTier, CandidateModelProfile[]> = {
		premium: [],
		balanced: [],
		budget: [],
	};
	for (const p of profiles) {
		byTier[p.costTier].push(p);
	}
	for (const tier of ["premium", "balanced", "budget"] as const) {
		byTier[tier].sort((a, b) => b.priority - a.priority);
	}

	const picked: CandidateModelProfile[] = [];
	const seen = new Set<string>();
	const tiers: CostTier[] = ["premium", "balanced", "budget"];

	// 轮转从各个 costTier 中挑选高优先级模型，保证多档位代表性
	let progressed = true;
	while (picked.length < limit && progressed) {
		progressed = false;
		for (const tier of tiers) {
			if (picked.length >= limit) break;
			const next = byTier[tier].shift();
			if (!next) continue;
			progressed = true;
			const key = modelKey(next.provider, next.id);
			if (!seen.has(key)) {
				seen.add(key);
				picked.push(next);
			}
		}
	}
	return picked;
}

/** 从会话消息末尾估算已用上下文 Token 数 */
export function estimateUsedTokensFromMessages(messages: readonly Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant" && msg.usage) {
			const usage = msg.usage;
			if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
				return usage.totalTokens;
			}
			const summed = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
			if (summed > 0) return summed;
		}
	}

	// 若尚未收到 assistant usage，按字符数粗略估算（约 4 字符 / token）
	let totalChars = 0;
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			totalChars += msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text") totalChars += block.text.length;
				else if (block.type === "thinking") totalChars += block.thinking.length;
			}
		}
	}
	return Math.ceil(totalChars / 4);
}

/** 判断候选模型是否能够安全容纳当前上下文 */
export function fitsContextWindow(
	usedTokens: number | undefined,
	contextWindow: number,
	maxTokens: number,
): boolean {
	if (!usedTokens || usedTokens <= 0 || contextWindow <= 0) return true;
	const reserve = maxTokens > 0 ? maxTokens : 4096;
	const headroom = Math.max(2048, Math.ceil(contextWindow * 0.05));
	return usedTokens + reserve + headroom <= contextWindow;
}

/** 大候选池预过滤：保证决策池不超过 maxDecisionCandidates（默认 12 个） */
export function prefilterDecisionCandidates(
	candidates: readonly ResolvedCandidate[],
	currentModelKey?: string,
	maxCount = MAX_DECISION_CANDIDATES,
): ResolvedCandidate[] {
	if (candidates.length <= maxCount) return [...candidates];

	const picked: ResolvedCandidate[] = [];
	const seen = new Set<string>();

	if (currentModelKey) {
		const current = candidates.find((c) => c.key === currentModelKey);
		if (current) {
			picked.push(current);
			seen.add(current.key);
		}
	}

	const remaining = candidates.filter((c) => !seen.has(c.key));
	const byTier: Record<CostTier, ResolvedCandidate[]> = {
		premium: [],
		balanced: [],
		budget: [],
	};
	for (const c of remaining) {
		byTier[c.profile.costTier].push(c);
	}
	for (const tier of ["premium", "balanced", "budget"] as const) {
		byTier[tier].sort((a, b) => b.profile.priority - a.profile.priority);
	}

	const tiers: CostTier[] = ["premium", "balanced", "budget"];
	let progressed = true;
	while (picked.length < maxCount && progressed) {
		progressed = false;
		for (const tier of tiers) {
			if (picked.length >= maxCount) break;
			const next = byTier[tier].shift();
			if (!next) continue;
			progressed = true;
			if (!seen.has(next.key)) {
				seen.add(next.key);
				picked.push(next);
			}
		}
	}

	return picked;
}

/** 解析并过滤候选模型池 */
export function buildCandidatePool(params: {
	modelRegistry: Pick<ModelRegistry, "find" | "getAvailable" | "hasConfiguredAuth">;
	config: FusionRouterConfig;
	healthTracker: ModelHealthTracker;
	usedTokens?: number;
	currentModelKey?: string;
}): CandidatePoolSnapshot {
	const { modelRegistry, config, healthTracker, usedTokens, currentModelKey } = params;
	const availableModels = modelRegistry.getAvailable().filter((m) => !isVirtualCatalogModel(m));
	const availableMap = new Map<string, Model<Api>>();
	for (const m of availableModels) {
		availableMap.set(modelKey(m.provider, m.id), m);
	}

	let discoveredFromRegistry = false;
	let profiles: CandidateModelProfile[];
	if (config.models.length > 0) {
		profiles = config.models.filter((p) => p.enabled);
	} else {
		discoveredFromRegistry = true;
		profiles = discoverCandidatesFromRegistry(availableModels);
	}

	const allResolved: ResolvedCandidate[] = [];
	for (const rawProfile of profiles) {
		const key = modelKey(rawProfile.provider, rawProfile.id);
		const found = availableMap.get(key) ?? modelRegistry.find(rawProfile.provider, rawProfile.id);
		if (!found || isVirtualCatalogModel(found)) continue;
		// 二次核实认证状态，避免没有凭据的物理模型进入候选池
		if (!availableMap.has(key) && !modelRegistry.hasConfiguredAuth(found)) continue;

		const enriched = enrichCandidateProfile(rawProfile, found);
		allResolved.push({
			key,
			profile: enriched,
			model: found,
			contextWindow: enriched.contextWindow ?? found.contextWindow,
			maxTokens: enriched.maxTokens ?? found.maxTokens,
		});
	}

	allResolved.sort((a, b) => b.profile.priority - a.profile.priority);

	const healthy: ResolvedCandidate[] = [];
	const excludedByHealth: string[] = [];
	for (const candidate of allResolved) {
		if (healthTracker.isAvailable(candidate.key, config.health)) {
			healthy.push(candidate);
		} else {
			excludedByHealth.push(candidate.key);
		}
	}

	// 若所有模型均处于冷却期，则保留全量已解析模型兜底，避免彻底无法发送请求
	const effectiveHealthy = healthy.length > 0 ? healthy : allResolved;

	const contextSafe: ResolvedCandidate[] = [];
	const excludedByContext: string[] = [];
	for (const candidate of effectiveHealthy) {
		if (fitsContextWindow(usedTokens, candidate.contextWindow, candidate.maxTokens)) {
			contextSafe.push(candidate);
		} else {
			excludedByContext.push(candidate.key);
		}
	}

	// 防死锁兜底：若所有健康模型都超出上下文限制，保留原健康列表交给 Pi 原生 Compaction 处理
	const effectiveContextSafe = contextSafe.length > 0 ? contextSafe : effectiveHealthy;
	const forDecision = prefilterDecisionCandidates(effectiveContextSafe, currentModelKey);

	return {
		allResolved,
		healthy: effectiveHealthy,
		contextSafe: effectiveContextSafe,
		forDecision,
		excludedByHealth,
		excludedByContext,
		discoveredFromRegistry,
	};
}

/** 从候选池选取默认或回退模型 */
export function pickDefaultOrFallbackCandidate(
	candidates: readonly ResolvedCandidate[],
	config: FusionRouterConfig,
	excludeKeys?: ReadonlySet<string>,
): ResolvedCandidate | undefined {
	const available = excludeKeys
		? candidates.filter((c) => !excludeKeys.has(c.key))
		: [...candidates];
	if (available.length === 0) return undefined;

	if (config.defaultModel) {
		const parsed = parseModelKey(config.defaultModel);
		const normalizedKey = parsed ? modelKey(parsed.provider, parsed.id) : config.defaultModel;
		const matched = available.find((c) => c.key === normalizedKey);
		if (matched) return matched;
	}

	for (const fallbackKey of config.fallbackChain) {
		const parsed = parseModelKey(fallbackKey);
		const normalizedKey = parsed ? modelKey(parsed.provider, parsed.id) : fallbackKey;
		const matched = available.find((c) => c.key === normalizedKey);
		if (matched) return matched;
	}

	const sorted = [...available].sort((a, b) => b.profile.priority - a.profile.priority);
	return sorted[0];
}

/** 为 Agent 循环外 direct 请求（如 Compaction 摘要）选择轻量或当前可用模型 */
export function pickDirectCandidate(
	candidates: readonly ResolvedCandidate[],
	currentModelKey: string | undefined,
	config: FusionRouterConfig,
): ResolvedCandidate | undefined {
	if (candidates.length === 0) return undefined;
	if (currentModelKey) {
		const current = candidates.find((c) => c.key === currentModelKey);
		if (current) return current;
	}

	const budgetOrBalanced = candidates
		.filter((c) => c.profile.costTier === "budget" || c.profile.costTier === "balanced")
		.sort((a, b) => b.profile.priority - a.profile.priority);
	if (budgetOrBalanced.length > 0) return budgetOrBalanced[0];

	return pickDefaultOrFallbackCandidate(candidates, config);
}
