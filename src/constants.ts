import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CostTier, FusionRouterConfig } from "./types.ts";

/** 配置文件名称 */
export const CONFIG_FILE_NAME = "fusion-router.json";

/** 状态栏注册 Key */
export const STATUS_BAR_KEY = "fusion-router";

/** 虚拟模型默认支持的思考档位 */
export const DEFAULT_VIRTUAL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** 默认候选模型推理强度说明 */
export const DEFAULT_EFFORTS: Readonly<Record<string, string>> = {
	off: "Simple lookup, formatting, short direct answer, or trivial mechanical step with no reasoning needed",
	low: "Straightforward single-file edit, routine command, or clear bug fix",
	medium: "Standard feature implementation, multi-step debugging, or moderate refactoring",
	high: "Complex architectural design, cross-module changes, subtle race condition, or deep analysis",
	xhigh: "Extremely hard research, intricate root-cause analysis, or high-stakes verification",
};

/** 候选池与分类器限制常量 */
export const MAX_CONFIGURED_CANDIDATES = 32;
export const MAX_DECISION_CANDIDATES = 12;
export const MAX_AUTO_DISCOVERED_CANDIDATES = 12;
export const MAX_CLASSIFIER_REQUEST_CHARS = 2000;
export const MAX_CLASSIFIER_CONTEXT_ITEMS = 6;
export const MAX_CLASSIFIER_ITEM_CHARS = 320;
export const DEFAULT_MIN_SWITCH_CONFIDENCE = 0.35;
export const DEFAULT_MIN_SWITCH_BENEFIT_CONFIDENCE = 0.55;
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 2500;
export const MIN_CLASSIFIER_TIMEOUT_MS = 500;
export const MAX_CLASSIFIER_TIMEOUT_MS = 15000;

/** 健康冷却防抖窗口（毫秒） */
export const HEALTH_DEBOUNCE_MS = 1500;

/** 自定义决策端点未指定密钥变量时依次尝试的环境变量 */
export const CLASSIFIER_API_KEY_ENV_FALLBACKS: readonly string[] = ["CLASSIFIER_API_KEY", "TYPESAFE_API_KEY"];

/** 自定义决策端点默认注册的提供商 ID */
export const DEFAULT_CUSTOM_CLASSIFIER_PROVIDER_ID = "fusion-classifier";

/** 内置自动发现专用分类器优先级列表 */
export const AUTO_CLASSIFIER_PRECEDENCE: readonly string[] = [
	"typesafe/jev-latest",
	"cloudflare-workers-ai/typesafe/jev",
	"cloudflare-workers-ai/typesafe/jev-1.14.0",
	"cloudflare-workers-ai/@cf/cloudflare/clef",
	"cloudflare-workers-ai/@cf/cloudflare/clef-omni",
	"cloudflare-workers-ai/@cf/cloudflare/clef-flash",
	"opencode/jev-1.13",
	"opencode/jev-1.13-free",
	"openrouter/~typesafe/jev-latest",
	"openrouter/typesafe/jev-1.14",
	"openrouter/typesafe/jev-1.13",
	"openrouter/cloudflare/clef",
];

/** 兼容旧版配置中的简写分类器别名 */
export const CLASSIFIER_ID_ALIASES: Readonly<Record<string, { provider: string; model: string }>> = {
	"azure-foundry/decision-1": { provider: "openai", model: "gpt-6-luna" },
	"cloudflare-workers-ai/@cf/typesafe/jev": { provider: "cloudflare-workers-ai", model: "typesafe/jev" },
	"cloudflare-workers-ai/@cf/typesafe/clef": { provider: "cloudflare-workers-ai", model: "@cf/cloudflare/clef" },
	"openrouter/typesafe/jev": { provider: "openrouter", model: "typesafe/jev-1.14" },
};

/** 完整默认配置 */
export const DEFAULT_FUSION_ROUTER_CONFIG: FusionRouterConfig = {
	version: 1,
	enabled: true,
	mode: "auto",
	virtualModel: {
		provider: "router",
		id: "fusion",
		name: "Fusion Router",
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	classifier: {
		provider: "auto",
		model: "jev-latest",
		timeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
		minConfidence: DEFAULT_MIN_SWITCH_CONFIDENCE,
		fallbackChain: [],
	},
	models: [],
	fallbackChain: [],
	efforts: { ...DEFAULT_EFFORTS },
	thinkingMode: "auto",
	redecision: {
		stickyDuringToolLoop: true,
		redecideOnConsecutiveToolErrors: 2,
		periodicReviewSteps: 8,
		redecideOnTaskShift: true,
		minSwitchBenefitConfidence: DEFAULT_MIN_SWITCH_BENEFIT_CONFIDENCE,
		protectThinkingSignature: true,
	},
	health: {
		enabled: true,
		autoFailover: true,
		cooldownSeconds: 90,
		maxCooldownSeconds: 900,
	},
	preferences: "",
	ui: {
		showStatusBar: true,
		notifyOnSwitch: false,
		notifyOnFailover: true,
	},
};

/** 家族启发式画像条目 */
export interface FamilyHeuristic {
	pattern: RegExp;
	costTier: CostTier;
	priority: number;
	specialty: string;
	avoid?: string;
}

/** 内置主流模型家族启发式画像字典（仅作为用户未显式填写 specialty 时的零配置兜底） */
export const BUILTIN_FAMILY_HEURISTICS: readonly FamilyHeuristic[] = [
	{
		pattern: /claude[-_.]?(opus|4\.?5[-_.]?opus|4[-_.]?opus)/i,
		costTier: "premium",
		priority: 95,
		specialty: "Deep architectural design, subtle debugging, complex multi-file reasoning, and critical code review",
		avoid: "Trivial one-line edits or simple formatting",
	},
	{
		pattern: /claude[-_.]?(sonnet)/i,
		costTier: "balanced",
		priority: 85,
		specialty: "Balanced software engineering, multi-step coding, tool orchestration, and careful refactoring",
	},
	{
		pattern: /claude[-_.]?(haiku)/i,
		costTier: "budget",
		priority: 65,
		specialty: "Fast Q&A, file lookup, simple edits, summarization, and lightweight tool steps",
		avoid: "Deep architectural design or subtle concurrency debugging",
	},
	{
		pattern: /(gpt-5(\.\d+)?-pro|gpt-6(\.\d+)?-astra|o1-pro|o3-pro)/i,
		costTier: "premium",
		priority: 96,
		specialty: "Hardest algorithmic problems, deep verification, and high-stakes system reasoning",
		avoid: "Routine lookups or fast iterative file edits",
	},
	{
		pattern: /(gpt-5(\.\d+)?-sol|gpt-6(\.\d+)?-sol|gpt-5(\.\d+)?-codex|o3\b|o4-mini)/i,
		costTier: "premium",
		priority: 90,
		specialty: "Complex engineering, cross-cutting code changes, root-cause debugging, and precise code generation",
	},
	{
		pattern: /(gpt-5(\.\d+)?-terra|gpt-6(\.\d+)?-terra|gpt-5(\.\d+)?\b|gpt-4\.1\b|gpt-4o\b)/i,
		costTier: "balanced",
		priority: 80,
		specialty: "General feature development, bug fixes, code review, and day-to-day coding tasks",
	},
	{
		pattern: /(gpt-5(\.\d+)?-luna|gpt-6(\.\d+)?-luna|gpt-5(\.\d+)?-mini|gpt-5(\.\d+)?-nano|gpt-4\.1-mini|gpt-4\.1-nano|gpt-4o-mini)/i,
		costTier: "budget",
		priority: 68,
		specialty: "Fast implementation steps, routine edits, tests execution follow-ups, and concise answers",
		avoid: "Ambiguous architectural planning",
	},
	{
		pattern: /gemini[-_.]?[\d.]*[-_.]?pro/i,
		costTier: "balanced",
		priority: 82,
		specialty: "Large-context analysis, multimodal inspection, planning, and structured code reasoning",
	},
	{
		pattern: /gemini[-_.]?[\d.]*[-_.]?(flash|lite)/i,
		costTier: "budget",
		priority: 66,
		specialty: "High-speed summaries, quick searches, simple edits, and low-latency tasks",
		avoid: "Deep multi-module refactoring",
	},
	{
		pattern: /deepseek[-_.]?(r1|reasoner|pro)/i,
		costTier: "balanced",
		priority: 82,
		specialty: "Step-by-step analytical reasoning, algorithm design, and complex bug diagnosis",
	},
	{
		pattern: /deepseek[-_.]?(v\d|chat|flash)/i,
		costTier: "budget",
		priority: 72,
		specialty: "Cost-effective coding, general implementation, explanations, and quick iterations",
	},
	{
		pattern: /(kimi|moonshot)/i,
		costTier: "balanced",
		priority: 75,
		specialty: "Long-context repository understanding, coding implementation, and documentation",
	},
	{
		pattern: /(minimax|glm|qwen)/i,
		costTier: "balanced",
		priority: 72,
		specialty: "General coding, Chinese and English instruction following, and iterative edits",
	},
];

/** 故障识别正则模式 */
export const FAILURE_PATTERNS = {
	aborted: /\b(aborted|abort|cancelled|canceled)\b|request was aborted/i,
	contextOverflow:
		/context[_\s-]?length[_\s-]?exceeded|maximum context length|too many tokens|prompt is too long|context window exceeded|exceeds the context/i,
	auth: /\b(401|403)\b|invalid[_\s-]?api[_\s-]?key|unauthorized|forbidden|authentication failed|invalid x-api-key|expired token/i,
	missing: /\b404\b|model[_\s-]?not[_\s-]?found|does not exist|unknown model/i,
	rateLimit: /\b429\b|rate[_\s-]?limit|too many requests|quota exceeded|resource[_\s-]?exhausted/i,
	timeout: /\b408\b|etimedout|timed?\s*out|deadline exceeded|request timeout/i,
	network: /econnreset|econnrefused|enotfound|ehostunreach|eai_again|fetch failed|socket hang up|network error/i,
	parameter: /\b(400|422)\b|invalid[_\s-]?param|unsupported parameter|unrecognized request argument|invalid_request_error/i,
	unavailable: /\b(500|502|503|504|520|521|522|523|524)\b|service unavailable|bad gateway|overloaded|capacity|internal server error/i,
} as const;
