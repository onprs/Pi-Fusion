import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	Model,
	ModelThinkingLevel,
} from "@earendil-works/pi-ai";

/** 路由器版本号 */
export const FUSION_ROUTER_CONFIG_VERSION = 1 as const;

/** 工作模式：auto 自动派发决策模型，observe 仅记录决策但派发默认模型 */
export type FusionRouterMode = "auto" | "observe";

/** Thinking 强度决策模式 */
export type ThinkingSelectionMode = "auto" | "passthrough" | "profile-default";

/** 候选模型成本层级 */
export type CostTier = "budget" | "balanced" | "premium";

/** 默认推理强度标签 */
export type EffortLabel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | (string & {});

/** 支持的专用决策模型 API 协议 */
export type SupportedClassifierApi =
	| "typesafe-system-one"
	| "cloudflare-workers-ai-system-one"
	| "openai-decisions";

/** 虚拟模型目录配置 */
export interface VirtualModelConfig {
	provider: string;
	id: string;
	name: string;
	thinkingLevels?: ModelThinkingLevel[];
	contextWindow?: number;
	maxTokens?: number;
}

/** 候选物理模型画像配置 */
export interface CandidateModelProfile {
	provider: string;
	id: string;
	label?: string;
	enabled: boolean;
	/** 优先级：数值越大优先级越高（范围 1~100，默认 50） */
	priority: number;
	costTier: CostTier;
	/** 擅长场景描述；为空时自动回退到内置家族画像启发式描述 */
	specialty: string;
	/** 不适用场景描述 */
	avoid?: string;
	defaultThinking?: ModelThinkingLevel;
	/** 将分类器决策的强度标签映射为该物理模型的具体 ThinkingLevel */
	effortMap?: Partial<Record<EffortLabel, ModelThinkingLevel>>;
	/** 可选手动覆盖上下文窗口上限 */
	contextWindow?: number;
	/** 可选手动覆盖最大输出上限 */
	maxTokens?: number;
}

/** 自定义专用决策端点配置 */
export interface ClassifierCustomEndpointConfig {
	providerId?: string;
	baseUrl?: string;
	api?: SupportedClassifierApi;
	apiKeyEnv?: string;
	/** 是否只读复用本机 @bacnh85/pi-classifier 配置的端点信息 */
	importFromPiClassifier?: boolean;
}

/** 备用分类器引用 */
export interface ClassifierRef {
	provider: string;
	model: string;
}

/** 专用决策模型配置 */
export interface ClassifierConfig {
	provider: string;
	model: string;
	customEndpoint?: ClassifierCustomEndpointConfig;
	timeoutMs: number;
	minConfidence: number;
	fallbackChain: ClassifierRef[];
}

/** 智能重决策与 Sticky Routing 配置 */
export interface RedecisionConfig {
	stickyDuringToolLoop: boolean;
	redecideOnConsecutiveToolErrors: number;
	periodicReviewSteps: number;
	redecideOnTaskShift: boolean;
	minSwitchBenefitConfidence: number;
	protectThinkingSignature: boolean;
}

/** 模型健康管理配置 */
export interface HealthConfig {
	enabled: boolean;
	autoFailover: boolean;
	cooldownSeconds: number;
	maxCooldownSeconds: number;
}

/** UI 展示配置 */
export interface UIConfig {
	showStatusBar: boolean;
	notifyOnSwitch: boolean;
	notifyOnFailover: boolean;
}

/** Pi-Fusion 完整配置结构 */
export interface FusionRouterConfig {
	version: 1;
	enabled: boolean;
	mode: FusionRouterMode;
	virtualModel: VirtualModelConfig;
	classifier: ClassifierConfig;
	models: CandidateModelProfile[];
	defaultModel?: string;
	fallbackChain: string[];
	efforts: Record<string, string>;
	thinkingMode: ThinkingSelectionMode;
	redecision: RedecisionConfig;
	health: HealthConfig;
	preferences: string;
	ui: UIConfig;
}

/** 允许局部覆盖的深度配置补丁 */
export type PartialFusionRouterConfig = {
	version?: number;
	enabled?: boolean;
	mode?: FusionRouterMode;
	virtualModel?: Partial<VirtualModelConfig>;
	classifier?: Partial<Omit<ClassifierConfig, "customEndpoint" | "fallbackChain">> & {
		customEndpoint?: Partial<ClassifierCustomEndpointConfig>;
		fallbackChain?: ClassifierRef[];
	};
	models?: CandidateModelProfile[];
	defaultModel?: string;
	fallbackChain?: string[];
	efforts?: Record<string, string>;
	thinkingMode?: ThinkingSelectionMode;
	redecision?: Partial<RedecisionConfig>;
	health?: Partial<HealthConfig>;
	preferences?: string;
	ui?: Partial<UIConfig>;
};

/** 路由触发原因 */
export type RouteTrigger =
	| "user_initial"
	| "user_redecide"
	| "sticky_hold"
	| "tool_error_escalation"
	| "periodic_review"
	| "failover"
	| "direct"
	| "fallback"
	| "observe"
	| "disabled";

/** 最近一次决策记录（纯 JSON 可序列化） */
export interface RouteDecisionRecord {
	model: string;
	thinkingLevel: ModelThinkingLevel;
	reason: string;
	trigger: RouteTrigger;
	classifierModel?: string;
	recommendedModel?: string;
	confidence?: number;
	switchBenefit?: string;
	switchBenefitConfidence?: number;
	latencyMs?: number;
	timestamp: number;
}

/** 持久化在会话分支上的路由状态（必须纯 JSON 可序列化） */
export interface FusionRouteState {
	version: 1;
	selectedModel: string;
	thinkingLevel: ModelThinkingLevel;
	taskSummary?: string;
	decidedAtTurnStep: number;
	continuationSteps: number;
	consecutiveToolErrors: number;
	attemptedModels: string[];
	lastDecision: RouteDecisionRecord;
}

/** 运行时解析后的候选模型项 */
export interface ResolvedCandidate {
	key: string;
	profile: CandidateModelProfile;
	model: Model<Api>;
	contextWindow: number;
	maxTokens: number;
}

/** 候选模型过滤统计 */
export interface CandidatePoolSnapshot {
	allResolved: ResolvedCandidate[];
	healthy: ResolvedCandidate[];
	contextSafe: ResolvedCandidate[];
	forDecision: ResolvedCandidate[];
	excludedByHealth: string[];
	excludedByContext: string[];
	discoveredFromRegistry: boolean;
}

/** 模型故障类别 */
export type FailureCategory =
	| "rate_limit"
	| "unavailable"
	| "timeout"
	| "network"
	| "auth"
	| "missing"
	| "parameter"
	| "context_overflow"
	| "aborted"
	| "unknown";

/** 模型健康状态快照 */
export interface ModelHealthSnapshot {
	key: string;
	status: "healthy" | "cooldown" | "ready_to_retry";
	consecutiveFailures: number;
	lastFailureAt?: number;
	cooldownUntil?: number;
	remainingCooldownMs: number;
	lastCategory?: FailureCategory;
	lastSummary?: string;
}

/** 分类器决策输入摘要 */
export interface ClassifierInputSummary {
	currentRequest: string;
	recentContext: Array<{
		role: string;
		summary: string;
		toolName?: string;
		isError?: boolean;
	}>;
	sessionMetrics: {
		turnStepCount: number;
		consecutiveToolErrors: number;
		currentModelKey?: string;
		currentThinkingLevel?: ModelThinkingLevel;
	};
}

/** 分类器决策输出 */
export interface ClassifierDecision {
	selectedModelKey: string;
	selectedModelConfidence: number;
	effortLabel: string;
	effortConfidence: number;
	switchBenefit?: "hold" | "upgrade_quality" | "optimize_speed_cost";
	switchBenefitConfidence?: number;
	classifierModelKey: string;
	latencyMs: number;
}

/** 分类器可用条目 */
export interface DiscoveredClassifier {
	key: string;
	model: ClassifierModel<ClassifierApi>;
	source: "custom" | "builtin" | "registry";
}

/** 完整配置加载结果（含来源与校验诊断） */
export interface LoadedConfigResult {
	config: FusionRouterConfig;
	globalPath: string;
	projectPath: string;
	globalExists: boolean;
	projectExists: boolean;
	warnings: string[];
	migratedFrom?: string;
}
