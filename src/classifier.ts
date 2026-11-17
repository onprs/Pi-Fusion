import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierQuestion,
	ClassifierResult,
	Message,
	ModelsClassifierOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ClassifierLookupRegistry {
	findOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
	getAvailableOfType(type: "classifier"): Promise<readonly ClassifierModel<ClassifierApi>[]>;
}

export interface ClassifierRunnerRegistry {
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult>;
}
import { getGlobalAgentDir, modelKey } from "./config.ts";
import {
	AUTO_CLASSIFIER_PRECEDENCE,
	CLASSIFIER_API_KEY_ENV_FALLBACKS,
	CLASSIFIER_ID_ALIASES,
	DEFAULT_CUSTOM_CLASSIFIER_PROVIDER_ID,
	MAX_CLASSIFIER_CONTEXT_ITEMS,
	MAX_CLASSIFIER_ITEM_CHARS,
	MAX_CLASSIFIER_REQUEST_CHARS,
} from "./constants.ts";
import type {
	ClassifierConfig,
	ClassifierCustomEndpointConfig,
	ClassifierDecision,
	ClassifierInputSummary,
	DiscoveredClassifier,
	FusionRouterConfig,
	ResolvedCandidate,
	SupportedClassifierApi,
} from "./types.ts";

/** 只读读取本机 @bacnh85/pi-classifier 兼容设置（可选），不修改用户文件 */
export function readPiClassifierEndpointHints(agentDir?: string): {
	baseUrl?: string;
	model?: string;
} {
	const dir = getGlobalAgentDir(agentDir);
	const settingsPath = join(dir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		const classifier = raw.classifier;
		if (!classifier || typeof classifier !== "object" || Array.isArray(classifier)) return {};
		const rec = classifier as Record<string, unknown>;
		const router = raw.router && typeof raw.router === "object" && !Array.isArray(raw.router)
			? (raw.router as Record<string, unknown>)
			: undefined;

		const rawBaseUrl = typeof rec.baseUrl === "string" && rec.baseUrl.trim()
			? rec.baseUrl.trim()
			: typeof router?.baseUrl === "string" && router.baseUrl.trim()
				? router.baseUrl.trim()
				: undefined;

		return {
			baseUrl: rawBaseUrl ? rawBaseUrl.replace(/\/+$/, "") : undefined,
			model: typeof rec.model === "string" && rec.model.trim() ? rec.model.trim() : undefined,
		};
	} catch {
		return {};
	}
}

/** 自定义决策端点解析结果 */
export interface CustomClassifierTarget {
	providerId: string;
	modelId: string;
	baseUrl: string;
	api: SupportedClassifierApi;
}

/** 解析自定义决策端点的提供商、模型与地址；未配置或缺少地址时返回 undefined */
export function resolveCustomClassifierTarget(
	classifierConfig: ClassifierConfig,
	agentDir?: string,
): CustomClassifierTarget | undefined {
	const custom: ClassifierCustomEndpointConfig | undefined = classifierConfig.customEndpoint;
	if (!custom) return undefined;

	let baseUrl = custom.baseUrl?.trim();
	let modelId = classifierConfig.model?.trim() || "jev-latest";

	if (custom.importFromPiClassifier) {
		const hints = readPiClassifierEndpointHints(agentDir);
		if (!baseUrl && hints.baseUrl) baseUrl = hints.baseUrl;
		if ((!classifierConfig.model || classifierConfig.model === "jev-latest") && hints.model) {
			modelId = hints.model;
		}
	}

	if (!baseUrl) return undefined;
	return {
		providerId: custom.providerId?.trim() || DEFAULT_CUSTOM_CLASSIFIER_PROVIDER_ID,
		modelId,
		baseUrl: baseUrl.replace(/\/+$/, ""),
		api: custom.api ?? "typesafe-system-one",
	};
}

/** 解析自定义端点的密钥引用：优先使用配置的变量名，其次使用已设置的通用变量 */
export function resolveClassifierApiKeyReference(
	custom: ClassifierCustomEndpointConfig,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicit = custom.apiKeyEnv?.trim().replace(/^\$/, "");
	if (explicit) return `$${explicit}`;
	const present = CLASSIFIER_API_KEY_ENV_FALLBACKS.find((name) => env[name]?.trim());
	return `$${present ?? CLASSIFIER_API_KEY_ENV_FALLBACKS[0]}`;
}

/** 根据自定义端点配置注册专用的 Classifier Provider（仅在用户显式配置 customEndpoint 时调用） */
export function registerCustomClassifierEndpoint(
	pi: Pick<ExtensionAPI, "registerProvider">,
	config: FusionRouterConfig,
	agentDir?: string,
): { providerId: string; modelId: string } | undefined {
	const custom = config.classifier.customEndpoint;
	const target = resolveCustomClassifierTarget(config.classifier, agentDir);
	if (!custom || !target) return undefined;

	const { providerId, modelId, baseUrl, api } = target;
	pi.registerProvider(providerId, {
		name: "Fusion Classifier Endpoint",
		baseUrl,
		apiKey: resolveClassifierApiKeyReference(custom),
		authHeader: true,
		models: [
			{
				type: "classifier",
				id: modelId,
				name: `Classifier (${modelId})`,
				api,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64_000,
			},
		],
	});

	return { providerId, modelId };
}

function resolveClassifierLookup(
	provider: string,
	model: string,
): { provider: string; model: string } {
	const key = `${provider}/${model}`;
	const alias = CLASSIFIER_ID_ALIASES[key];
	if (alias) return alias;
	return { provider, model };
}

/** 按配置优先级与内置兜底序解析可用专用分类器列表 */
export async function resolveClassifierChain(
	modelRegistry: ClassifierLookupRegistry,
	classifierConfig: ClassifierConfig,
	agentDir?: string,
): Promise<DiscoveredClassifier[]> {
	const available = await modelRegistry.getAvailableOfType("classifier");
	const availableMap = new Map<string, ClassifierModel<ClassifierApi>>();
	for (const model of available) {
		availableMap.set(modelKey(model.provider, model.id), model);
	}

	const ordered: DiscoveredClassifier[] = [];
	const seen = new Set<string>();
	const pushIfAvailable = (
		provider: string,
		modelId: string,
		source: DiscoveredClassifier["source"],
	): void => {
		const resolved = resolveClassifierLookup(provider, modelId);
		const key = modelKey(resolved.provider, resolved.model);
		if (seen.has(key)) return;
		const matched = availableMap.get(key);
		if (matched) {
			seen.add(key);
			ordered.push({ key, model: matched, source });
			return;
		}
		// 兼容已配置 customEndpoint 但环境变量名刚注册的情况
		const found = modelRegistry.findOfType("classifier", resolved.provider, resolved.model);
		if (found && availableMap.has(modelKey(found.provider, found.id))) {
			seen.add(key);
			ordered.push({ key, model: found, source });
		}
	};

	// 1. 自定义端点与显式配置的主分类器
	const customTarget = resolveCustomClassifierTarget(classifierConfig, agentDir);
	const configuredProvider = classifierConfig.provider;
	if (
		customTarget
		&& (configuredProvider === "auto" || configuredProvider === "custom" || configuredProvider === customTarget.providerId)
	) {
		pushIfAvailable(customTarget.providerId, customTarget.modelId, "custom");
	}
	if (configuredProvider !== "auto" && configuredProvider !== "custom") {
		pushIfAvailable(configuredProvider, classifierConfig.model, "registry");
	}

	// 2. 配置的备用分类器链
	for (const ref of classifierConfig.fallbackChain) {
		pushIfAvailable(ref.provider, ref.model, "registry");
	}

	// 3. 内置优先列表自动发现
	for (const fullKey of AUTO_CLASSIFIER_PRECEDENCE) {
		const slashIdx = fullKey.indexOf("/");
		if (slashIdx <= 0) continue;
		const p = fullKey.slice(0, slashIdx);
		const m = fullKey.slice(slashIdx + 1);
		pushIfAvailable(p, m, "builtin");
	}

	// 4. 其余任意可用 classifier 模型
	for (const model of available) {
		const key = modelKey(model.provider, model.id);
		if (!seen.has(key)) {
			seen.add(key);
			ordered.push({ key, model, source: "registry" });
		}
	}

	return ordered;
}

function truncateText(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function extractMessageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** 构造紧凑、脱敏的分类器决策摘要（不发送系统提示词与大段工具输出） */
export function buildClassifierInputSummary(params: {
	messages: readonly Message[];
	turnStepCount: number;
	consecutiveToolErrors: number;
	currentModelKey?: string;
	currentThinkingLevel?: ClassifierInputSummary["sessionMetrics"]["currentThinkingLevel"];
}): ClassifierInputSummary {
	const { messages, turnStepCount, consecutiveToolErrors, currentModelKey, currentThinkingLevel } = params;

	let lastUserIndex = -1;
	let lastUserText = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && msg.role === "user") {
			lastUserIndex = i;
			lastUserText = extractMessageText(msg);
			break;
		}
	}

	const recentContext: ClassifierInputSummary["recentContext"] = [];
	for (let i = messages.length - 1; i >= 0 && recentContext.length < MAX_CLASSIFIER_CONTEXT_ITEMS; i--) {
		if (i === lastUserIndex) continue;
		const msg = messages[i];
		if (!msg) continue;

		if (msg.role === "toolResult") {
			const text = extractMessageText(msg);
			recentContext.unshift({
				role: "toolResult",
				toolName: msg.toolName,
				isError: msg.isError,
				summary: truncateText(text || (msg.isError ? "tool error" : "ok"), MAX_CLASSIFIER_ITEM_CHARS),
			});
			continue;
		}

		if (msg.role === "assistant") {
			const toolCalls = Array.isArray(msg.content)
				? msg.content.filter((b) => b.type === "toolCall").map((b) => b.name)
				: [];
			const text = extractMessageText(msg);
			const summaryParts: string[] = [];
			if (toolCalls.length > 0) summaryParts.push(`tools:[${toolCalls.join(",")}]`);
			if (text) summaryParts.push(text);
			recentContext.unshift({
				role: "assistant",
				summary: truncateText(summaryParts.join(" ") || msg.stopReason, MAX_CLASSIFIER_ITEM_CHARS),
			});
			continue;
		}

		if (msg.role === "user") {
			recentContext.unshift({
				role: "user",
				summary: truncateText(extractMessageText(msg), MAX_CLASSIFIER_ITEM_CHARS),
			});
		}
	}

	return {
		currentRequest: truncateText(lastUserText, MAX_CLASSIFIER_REQUEST_CHARS),
		recentContext,
		sessionMetrics: {
			turnStepCount,
			consecutiveToolErrors,
			currentModelKey,
			currentThinkingLevel,
		},
	};
}

/** 构造提交给 Classifier 的结构化 state 与 questions */
export function buildClassifierContext(params: {
	summary: ClassifierInputSummary;
	candidates: readonly ResolvedCandidate[];
	efforts: Readonly<Record<string, string>>;
	preferences: string;
	includeSwitchBenefit: boolean;
}): ClassifierContext {
	const { summary, candidates, efforts, preferences, includeSwitchBenefit } = params;

	const candidateCriteria: Record<string, string> = {};
	for (const c of candidates) {
		const tags = [
			`tier=${c.profile.costTier}`,
			`priority=${c.profile.priority}`,
			`ctx=${Math.round(c.contextWindow / 1000)}k`,
		].join(", ");
		const avoidPart = c.profile.avoid ? ` Avoid when: ${c.profile.avoid}.` : "";
		candidateCriteria[c.key] = `${c.profile.specialty} (${tags}).${avoidPart}`;
	}

	const effortCriteria: Record<string, string> = { ...efforts };
	if (Object.keys(effortCriteria).length === 0) {
		effortCriteria.low = "Simple direct task";
		effortCriteria.medium = "Standard multi-step task";
		effortCriteria.high = "Complex reasoning task";
	}

	const questions: Record<string, ClassifierQuestion> = {
		model: {
			type: "choice",
			instructions: "Select the single best model from the available candidates to handle `currentRequest` given `recentContext`, `sessionMetrics`, and `preferences`.",
			criteria: candidateCriteria,
		},
		effort: {
			type: "choice",
			instructions: "Select the appropriate reasoning effort level for this request.",
			criteria: effortCriteria,
		},
	};

	if (includeSwitchBenefit) {
		questions.switch_benefit = {
			type: "choice",
			instructions: "Should the router keep the current model (`hold`) to preserve prompt cache, upgrade to a stronger model (`upgrade_quality`), or switch to a faster/cheaper model (`optimize_speed_cost`)?",
			criteria: {
				hold: "Current model is performing adequately or switching would break prompt cache unnecessarily",
				upgrade_quality: "Current model is failing, stuck in tool errors, or task complexity requires a stronger model",
				optimize_speed_cost: "Task shifted to trivial follow-up work where a fast budget model clearly saves time/cost",
			},
		};
	}

	return {
		state: {
			currentRequest: summary.currentRequest,
			recentContext: summary.recentContext,
			sessionMetrics: summary.sessionMetrics,
			preferences: preferences || "Balance quality, speed, and cost appropriately.",
		},
		questions,
	};
}

function isValidProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isValidProbabilitiesMap(probabilities: unknown): boolean {
	if (probabilities === undefined) return true;
	if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return false;
	const values = Object.values(probabilities as Record<string, unknown>);
	if (values.length === 0) return true;
	let sum = 0;
	for (const val of values) {
		if (!isValidProbability(val)) return false;
		sum += val;
	}
	return sum >= 0.8 && sum <= 1.2;
}

function isValidChoiceAnswer(
	answer: unknown,
	allowedKeys: ReadonlySet<string>,
): answer is {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
} {
	if (!answer || typeof answer !== "object" || Array.isArray(answer)) return false;
	const rec = answer as Record<string, unknown>;
	if (rec.type !== "choice") return false;
	if (typeof rec.choice !== "string" || !allowedKeys.has(rec.choice)) return false;
	if (!isValidProbability(rec.confidence)) return false;
	if (!isValidProbabilitiesMap(rec.probabilities)) return false;
	return true;
}

/** 带超时的 Classifier 调用，永不向外抛异常 */
export async function runClassifierDecision(params: {
	modelRegistry: ClassifierRunnerRegistry;
	classifiers: readonly DiscoveredClassifier[];
	context: ClassifierContext;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<ClassifierDecision | undefined> {
	const { modelRegistry, classifiers, context, timeoutMs, signal } = params;
	if (classifiers.length === 0) return undefined;

	const modelQuestion = context.questions.model;
	const effortQuestion = context.questions.effort;
	const switchQuestion = context.questions.switch_benefit;

	const allowedModelKeys = new Set<string>(
		modelQuestion?.type === "choice" ? Object.keys(modelQuestion.criteria) : [],
	);
	const allowedEffortKeys = new Set<string>(
		effortQuestion?.type === "choice" ? Object.keys(effortQuestion.criteria) : [],
	);
	const allowedSwitchKeys = new Set<string>(
		switchQuestion?.type === "choice"
			? Object.keys(switchQuestion.criteria)
			: ["hold", "upgrade_quality", "optimize_speed_cost"],
	);

	for (const candidate of classifiers) {
		if (signal?.aborted) return undefined;
		const controller = new AbortController();
		let timedOut = false;
		const onAbort = (): void => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);

		const start = Date.now();
		try {
			const result: ClassifierResult = await modelRegistry.classify(candidate.model, context, {
				signal: controller.signal,
			});
			const latencyMs = Date.now() - start;
			if (result.stopReason !== "stop" || timedOut) {
				continue;
			}

			const modelAnswer = result.answers?.model;
			if (!isValidChoiceAnswer(modelAnswer, allowedModelKeys)) {
				continue;
			}

			const effortAnswer = result.answers?.effort;
			const validEffort = isValidChoiceAnswer(effortAnswer, allowedEffortKeys) ? effortAnswer : undefined;

			const switchAnswer = result.answers?.switch_benefit;
			const validSwitch = isValidChoiceAnswer(switchAnswer, allowedSwitchKeys) ? switchAnswer : undefined;

			return {
				selectedModelKey: modelAnswer.choice,
				selectedModelConfidence: modelAnswer.confidence,
				effortLabel: validEffort ? validEffort.choice : "medium",
				effortConfidence: validEffort ? validEffort.confidence : 0,
				switchBenefit:
					validSwitch &&
					(validSwitch.choice === "hold" ||
						validSwitch.choice === "upgrade_quality" ||
						validSwitch.choice === "optimize_speed_cost")
						? validSwitch.choice
						: undefined,
				switchBenefitConfidence: validSwitch ? validSwitch.confidence : undefined,
				classifierModelKey: candidate.key,
				latencyMs,
			};
		} catch {
			// 单个分类器异常时顺延尝试链上的下一个分类器
			continue;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	return undefined;
}
