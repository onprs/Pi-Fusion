import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type {
	ClassifierDecision,
	FusionRouteState,
	FusionRouterConfig,
} from "./types.ts";

/** 统计自上次用户消息之后已经历的 Assistant 响应轮数 */
export function countTurnAssistantSteps(request: ModelRouteRequest<FusionRouteState>): number {
	const messages = request.messages;
	const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
	let steps = 0;
	for (let i = lastUserIdx + 1; i < messages.length; i++) {
		if (messages[i]?.role === "assistant") steps += 1;
	}
	return steps;
}

/** 统计自上次用户消息之后连续失败的工具结果次数 */
export function countTrailingToolErrors(request: ModelRouteRequest<FusionRouteState>): number {
	const messages = request.messages;
	const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
	const tail = messages.slice(lastUserIdx + 1);
	let errors = 0;
	for (let i = tail.length - 1; i >= 0; i--) {
		const msg = tail[i];
		if (!msg) continue;
		if (msg.role === "toolResult") {
			if (msg.isError) errors += 1;
			else break;
		} else if (msg.role === "assistant") {
			// 只跨过紧邻的 toolCall assistant 消息，遇到更早轮次则停止
			continue;
		} else {
			break;
		}
	}
	return errors;
}

/** 判断最新用户消息是否相较上一轮任务摘要发生了实质性任务变化 */
export function hasCompletedUserTaskShiftSignal(request: ModelRouteRequest<FusionRouteState>): boolean {
	if (!request.state?.taskSummary) return false;
	const lastUserIdx = request.messages.findLastIndex((m) => m.role === "user");
	if (lastUserIdx < 0) return false;
	const msg = request.messages[lastUserIdx];
	if (!msg) return false;
	let currentText = "";
	if (typeof msg.content === "string") currentText = msg.content;
	else if (Array.isArray(msg.content)) {
		currentText = msg.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join(" ");
	}
	const normalizedCurrent = currentText.trim().slice(0, 120);
	const prev = request.state.taskSummary.trim().slice(0, 120);
	if (!normalizedCurrent || !prev) return false;
	// 短追问（例如 "继续"、"ok"、"try again"）不视为明显任务切换
	if (normalizedCurrent.length < 18) return false;
	return normalizedCurrent !== prev;
}

/** 从消息中提取末尾用户文本摘要 */
export function extractCurrentTaskSummary(request: ModelRouteRequest<FusionRouteState>): string | undefined {
	for (let i = request.messages.length - 1; i >= 0; i--) {
		const m = request.messages[i];
		if (!m || m.role !== "user") continue;
		const text = typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
				: "";
		const trimmed = text.trim();
		if (trimmed) return trimmed.slice(0, 200);
	}
	return undefined;
}

/** 检查当前轮次历史消息里模型是否已输出过带 thinking block 的响应 */
export function hasActiveThinkingSignature(request: ModelRouteRequest<FusionRouteState>): boolean {
	const lastUserIdx = request.messages.findLastIndex((m) => m.role === "user");
	const turnMessages = request.messages.slice(Math.max(0, lastUserIdx + 1));
	for (const m of turnMessages) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			if (m.content.some((b) => b.type === "thinking")) return true;
		}
	}
	return false;
}

/** 评估 continuation 步是否满足重决策条件（错误阈值、周期复查、Thinking Signature 保护） */
export function evaluateContinuationPolicy(params: {
	request: ModelRouteRequest<FusionRouteState>;
	config: FusionRouterConfig;
	turnAssistantSteps: number;
	trailingErrors: number;
	prevState?: FusionRouteState;
}): {
	shouldRedecide: boolean;
	errorTriggered: boolean;
	periodicTriggered: boolean;
	signatureLocked: boolean;
	triggerReason: "tool_error_escalation" | "periodic_review";
} {
	const { request, config, turnAssistantSteps, trailingErrors, prevState } = params;
	const stepsSinceDecision = Math.max(0, turnAssistantSteps - (prevState?.decidedAtTurnStep ?? 0));

	const errorThreshold = config.redecision.redecideOnConsecutiveToolErrors;
	const errorTriggered = errorThreshold > 0
		&& trailingErrors >= errorThreshold
		&& trailingErrors > (prevState?.consecutiveToolErrors ?? 0);

	const periodicThreshold = config.redecision.periodicReviewSteps;
	const periodicTriggered = periodicThreshold > 0 && stepsSinceDecision >= periodicThreshold;

	const shouldTryRedecide = !config.redecision.stickyDuringToolLoop || errorTriggered || periodicTriggered;
	const signatureLocked = config.redecision.protectThinkingSignature
		&& hasActiveThinkingSignature(request)
		&& !errorTriggered;

	return {
		shouldRedecide: shouldTryRedecide && !signatureLocked,
		errorTriggered,
		periodicTriggered,
		signatureLocked,
		triggerReason: errorTriggered ? "tool_error_escalation" : "periodic_review",
	};
}

/** 评估分类器决策是否通过模型置信度门槛与切换收益门控（Benefit Gate） */
export function evaluateSwitchBenefitGate(params: {
	decision: ClassifierDecision;
	currentModelKey?: string;
	isFirstDecision: boolean;
	currentIsHealthyAndSafe: boolean;
	minConfidence: number;
	minSwitchBenefitConfidence: number;
}): {
	meetsConfidence: boolean;
	switchAllowed: boolean;
} {
	const {
		decision,
		currentModelKey,
		isFirstDecision,
		currentIsHealthyAndSafe,
		minConfidence,
		minSwitchBenefitConfidence,
	} = params;

	const meetsConfidence = decision.selectedModelConfidence >= minConfidence;
	const switchAllowed =
		isFirstDecision
		|| !currentIsHealthyAndSafe
		|| !currentModelKey
		|| decision.selectedModelKey === currentModelKey
		|| !decision.switchBenefit
		|| ((decision.switchBenefit === "upgrade_quality" || decision.switchBenefit === "optimize_speed_cost")
			&& (decision.switchBenefitConfidence ?? decision.selectedModelConfidence) >= minSwitchBenefitConfidence);

	return {
		meetsConfidence,
		switchAllowed,
	};
}
