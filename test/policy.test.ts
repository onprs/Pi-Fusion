import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { createDefaultConfig } from "../src/config.ts";
import {
	countTrailingToolErrors,
	countTurnAssistantSteps,
	evaluateContinuationPolicy,
	evaluateSwitchBenefitGate,
	extractCurrentTaskSummary,
	hasActiveThinkingSignature,
	hasCompletedUserTaskShiftSignal,
} from "../src/policy.ts";
import type { FusionRouteState } from "../src/types.ts";

const VIRTUAL_MODEL: Model<Api> = {
	id: "fusion",
	name: "Fusion",
	api: "pi-virtual",
	provider: "router",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

function makeAssistantMessage(withThinking = false) {
	return {
		role: "assistant" as const,
		content: withThinking
			? [
					{ type: "thinking" as const, thinking: "deep reasoning..." },
					{ type: "text" as const, text: "done" },
				]
			: [{ type: "text" as const, text: "ok" }],
		api: "openai-responses" as const,
		provider: "openai",
		model: "gpt-5",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: Date.now(),
	};
}

describe("policy 路由策略与门控评估", () => {
	it("准确统计当前轮次 Assistant 步数与尾部连续工具错误数", () => {
		const req: ModelRouteRequest<FusionRouteState> = {
			model: VIRTUAL_MODEL,
			thinkingLevel: "medium",
			reason: "continuation",
			messages: [
				{ role: "user", content: "修复构建报错", timestamp: 1 },
				makeAssistantMessage(false),
				{
					role: "toolResult",
					toolCallId: "t0",
					toolName: "read",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: 2,
				},
				makeAssistantMessage(false),
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "bash",
					content: [{ type: "text", text: "err 1" }],
					isError: true,
					timestamp: 3,
				},
				makeAssistantMessage(false),
				{
					role: "toolResult",
					toolCallId: "t2",
					toolName: "bash",
					content: [{ type: "text", text: "err 2" }],
					isError: true,
					timestamp: 4,
				},
			],
		};

		assert.equal(countTurnAssistantSteps(req), 3);
		assert.equal(countTrailingToolErrors(req), 2);
		assert.equal(extractCurrentTaskSummary(req), "修复构建报错");
	});

	it("Thinking Signature 保护在周期复查时阻止跨模型切换，但在连续工具报错达到阈值时放行", () => {
		const config = createDefaultConfig();
		config.redecision.periodicReviewSteps = 2;
		config.redecision.redecideOnConsecutiveToolErrors = 2;
		config.redecision.protectThinkingSignature = true;

		const reqWithThinking: ModelRouteRequest<FusionRouteState> = {
			model: VIRTUAL_MODEL,
			thinkingLevel: "high",
			reason: "continuation",
			messages: [
				{ role: "user", content: "实现核心解析器", timestamp: 1 },
				makeAssistantMessage(true),
				makeAssistantMessage(false),
			],
		};

		assert.equal(hasActiveThinkingSignature(reqWithThinking), true);

		// 周期复查到达步数（2 步），但存在 thinking 块且无连续工具错误 -> 锁定不重决策
		const evalPeriodic = evaluateContinuationPolicy({
			request: reqWithThinking,
			config,
			turnAssistantSteps: 2,
			trailingErrors: 0,
		});
		assert.equal(evalPeriodic.periodicTriggered, true);
		assert.equal(evalPeriodic.signatureLocked, true);
		assert.equal(evalPeriodic.shouldRedecide, false);

		// 连续工具错误达到 2 次 -> 突破签名锁定触发重决策
		const evalError = evaluateContinuationPolicy({
			request: reqWithThinking,
			config,
			turnAssistantSteps: 2,
			trailingErrors: 2,
		});
		assert.equal(evalError.errorTriggered, true);
		assert.equal(evalError.signatureLocked, false);
		assert.equal(evalError.shouldRedecide, true);
		assert.equal(evalError.triggerReason, "tool_error_escalation");
	});

	it("evaluateSwitchBenefitGate 正确拦截 hold 或低置信度切换请求", () => {
		const holdEval = evaluateSwitchBenefitGate({
			decision: {
				selectedModelKey: "anthropic/claude-opus-4-5",
				selectedModelConfidence: 0.9,
				effortLabel: "high",
				effortConfidence: 0.9,
				switchBenefit: "hold",
				switchBenefitConfidence: 0.85,
				classifierModelKey: "typesafe/jev-latest",
				latencyMs: 25,
			},
			currentModelKey: "openai/gpt-5",
			isFirstDecision: false,
			currentIsHealthyAndSafe: true,
			minConfidence: 0.45,
			minSwitchBenefitConfidence: 0.55,
		});
		assert.equal(holdEval.meetsConfidence, true);
		assert.equal(holdEval.switchAllowed, false);

		const upgradeEval = evaluateSwitchBenefitGate({
			decision: {
				selectedModelKey: "anthropic/claude-opus-4-5",
				selectedModelConfidence: 0.9,
				effortLabel: "high",
				effortConfidence: 0.9,
				switchBenefit: "upgrade_quality",
				switchBenefitConfidence: 0.8,
				classifierModelKey: "typesafe/jev-latest",
				latencyMs: 25,
			},
			currentModelKey: "openai/gpt-5",
			isFirstDecision: false,
			currentIsHealthyAndSafe: true,
			minConfidence: 0.45,
			minSwitchBenefitConfidence: 0.55,
		});
		assert.equal(upgradeEval.meetsConfidence, true);
		assert.equal(upgradeEval.switchAllowed, true);
	});

	it("识别长指令任务切换信号并忽略短追问", () => {
		const prevState: FusionRouteState = {
			version: 1,
			selectedModel: "openai/gpt-5",
			thinkingLevel: "medium",
			taskSummary: "帮我编写数据库迁移脚本并检查索引性能",
			decidedAtTurnStep: 0,
			continuationSteps: 0,
			consecutiveToolErrors: 0,
			attemptedModels: ["openai/gpt-5"],
			lastDecision: {
				model: "openai/gpt-5",
				thinkingLevel: "medium",
				reason: "init",
				trigger: "user_initial",
				timestamp: 1,
			},
		};

		const shortFollowUp: ModelRouteRequest<FusionRouteState> = {
			model: VIRTUAL_MODEL,
			thinkingLevel: "medium",
			reason: "user",
			state: prevState,
			messages: [{ role: "user", content: "继续执行", timestamp: 2 }],
		};
		assert.equal(hasCompletedUserTaskShiftSignal(shortFollowUp), false);

		const shiftedTask: ModelRouteRequest<FusionRouteState> = {
			model: VIRTUAL_MODEL,
			thinkingLevel: "medium",
			reason: "user",
			state: prevState,
			messages: [{ role: "user", content: "现在请把前端 React 组件重构为响应式布局并补齐样式", timestamp: 3 }],
		};
		assert.equal(hasCompletedUserTaskShiftSignal(shiftedTask), true);
	});
});
