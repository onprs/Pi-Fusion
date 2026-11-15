import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, ClassifierApi, ClassifierModel, ClassifierResult, Model } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { createDefaultConfig } from "../src/config.ts";
import { ModelHealthTracker } from "../src/health.ts";
import { routeRequest } from "../src/router.ts";
import type { FusionRouteState } from "../src/types.ts";

function makeChatModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://api.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...overrides,
	};
}

function makeClassifierModel(provider = "typesafe", id = "jev-latest"): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "typesafe-system-one",
		provider,
		baseUrl: "https://api.typesafe.ai/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
	};
}

function makeVirtualModel(): Model<Api> {
	return {
		id: "fusion",
		name: "Fusion Router",
		api: "pi-virtual" as Api,
		provider: "router",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

describe("router 核心路由引擎", () => {
	it("user 首次请求调用 Classifier 并写入路由状态", async () => {
		const sonnet = makeChatModel("anthropic", "claude-sonnet-4-5");
		const opus = makeChatModel("anthropic", "claude-opus-4-5");
		const haiku = makeChatModel("anthropic", "claude-haiku-4-5");
		const jev = makeClassifierModel();

		const cfg = createDefaultConfig();
		cfg.models = [
			{ provider: "anthropic", id: "claude-opus-4-5", enabled: true, priority: 95, costTier: "premium", specialty: "deep reasoning" },
			{ provider: "anthropic", id: "claude-sonnet-4-5", enabled: true, priority: 85, costTier: "balanced", specialty: "general coding" },
			{ provider: "anthropic", id: "claude-haiku-4-5", enabled: true, priority: 65, costTier: "budget", specialty: "fast lookup" },
		];

		let classifyCount = 0;
		const res = await routeRequest(
			{
				model: makeVirtualModel(),
				thinkingLevel: "medium",
				reason: "user",
				messages: [{ role: "user", content: "设计分布式锁架构", timestamp: 1 }],
			},
			{
				modelRegistry: {
					getAvailable: () => [sonnet, opus, haiku],
					find: (p, id) => [sonnet, opus, haiku].find((m) => m.provider === p && m.id === id),
					hasConfiguredAuth: () => true,
					findOfType: () => jev,
					getAvailableOfType: async () => [jev],
					classify: async (): Promise<ClassifierResult> => {
						classifyCount += 1;
						return {
							api: jev.api,
							provider: jev.provider,
							model: jev.id,
							answers: {
								model: { type: "choice", choice: "anthropic/claude-opus-4-5", probabilities: { "anthropic/claude-opus-4-5": 0.92 }, confidence: 0.92 },
								effort: { type: "choice", choice: "high", probabilities: { high: 0.9 }, confidence: 0.9 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
					},
				},
				config: cfg,
				healthTracker: new ModelHealthTracker(),
			},
		);

		assert.equal(classifyCount, 1);
		assert.equal(res.model.id, "claude-opus-4-5");
		assert.equal(res.thinkingLevel, "high");
		assert.equal(res.state?.selectedModel, "anthropic/claude-opus-4-5");
	});

	it("continuation 默认保持 Sticky 且原样复用 request.state 引用", async () => {
		const sonnet = makeChatModel("anthropic", "claude-sonnet-4-5");
		const opus = makeChatModel("anthropic", "claude-opus-4-5");
		const jev = makeClassifierModel();
		const cfg = createDefaultConfig();

		const initialState: FusionRouteState = {
			version: 1,
			selectedModel: "anthropic/claude-sonnet-4-5",
			thinkingLevel: "medium",
			taskSummary: "修复测试",
			decidedAtTurnStep: 0,
			continuationSteps: 0,
			consecutiveToolErrors: 0,
			attemptedModels: ["anthropic/claude-sonnet-4-5"],
			lastDecision: {
				model: "anthropic/claude-sonnet-4-5",
				thinkingLevel: "medium",
				reason: "init",
				trigger: "user_initial",
				timestamp: 1,
			},
		};

		let classifyCalled = false;
		const req: ModelRouteRequest<FusionRouteState> = {
			model: makeVirtualModel(),
			thinkingLevel: "medium",
			reason: "continuation",
			state: initialState,
			previous: { model: sonnet, thinkingLevel: "medium" },
			messages: [
				{ role: "user", content: "修复测试", timestamp: 1 },
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }], api: "openai-responses", provider: "anthropic", model: "claude-sonnet-4-5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
				{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
			],
		};

		const res = await routeRequest(req, {
			modelRegistry: {
				getAvailable: () => [sonnet, opus],
				find: (p, id) => [sonnet, opus].find((m) => m.provider === p && m.id === id),
				hasConfiguredAuth: () => true,
				findOfType: () => jev,
				getAvailableOfType: async () => [jev],
				classify: async () => {
					classifyCalled = true;
					throw new Error("should not be called");
				},
			},
			config: cfg,
			healthTracker: new ModelHealthTracker(),
		});

		assert.equal(classifyCalled, false);
		assert.equal(res.model.id, "claude-sonnet-4-5");
		assert.equal(res.state, initialState);
	});

	it("工具连续失败达到阈值时触发重决策并升级模型", async () => {
		const haiku = makeChatModel("anthropic", "claude-haiku-4-5");
		const opus = makeChatModel("anthropic", "claude-opus-4-5");
		const jev = makeClassifierModel();
		const cfg = createDefaultConfig();
		cfg.redecision.redecideOnConsecutiveToolErrors = 2;

		const initialState: FusionRouteState = {
			version: 1,
			selectedModel: "anthropic/claude-haiku-4-5",
			thinkingLevel: "low",
			taskSummary: "调试脚本",
			decidedAtTurnStep: 0,
			continuationSteps: 0,
			consecutiveToolErrors: 0,
			attemptedModels: ["anthropic/claude-haiku-4-5"],
			lastDecision: {
				model: "anthropic/claude-haiku-4-5",
				thinkingLevel: "low",
				reason: "init",
				trigger: "user_initial",
				timestamp: 1,
			},
		};

		const res = await routeRequest(
			{
				model: makeVirtualModel(),
				thinkingLevel: "medium",
				reason: "continuation",
				state: initialState,
				previous: { model: haiku, thinkingLevel: "low" },
				messages: [
					{ role: "user", content: "调试脚本", timestamp: 1 },
					{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], api: "openai-responses", provider: "anthropic", model: "claude-haiku-4-5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
					{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "error 1" }], isError: true, timestamp: 3 },
					{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "bash", arguments: {} }], api: "openai-responses", provider: "anthropic", model: "claude-haiku-4-5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 4 },
					{ role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "error 2" }], isError: true, timestamp: 5 },
				],
			},
			{
				modelRegistry: {
					getAvailable: () => [haiku, opus],
					find: (p, id) => [haiku, opus].find((m) => m.provider === p && m.id === id),
					hasConfiguredAuth: () => true,
					findOfType: () => jev,
					getAvailableOfType: async () => [jev],
					classify: async (): Promise<ClassifierResult> => ({
						api: jev.api,
						provider: jev.provider,
						model: jev.id,
						answers: {
							model: { type: "choice", choice: "anthropic/claude-opus-4-5", probabilities: { "anthropic/claude-opus-4-5": 0.9 }, confidence: 0.9 },
							effort: { type: "choice", choice: "high", probabilities: { high: 0.85 }, confidence: 0.85 },
							switch_benefit: { type: "choice", choice: "upgrade_quality", probabilities: { upgrade_quality: 0.88 }, confidence: 0.88 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				},
				config: cfg,
				healthTracker: new ModelHealthTracker(),
			},
		);

		assert.equal(res.model.id, "claude-opus-4-5");
		assert.equal(res.state?.lastDecision.trigger, "tool_error_escalation");
		assert.equal(res.state?.consecutiveToolErrors, 2);
	});

	it("retry 故障转移时自动触发冷却并切换至健康备用模型", async () => {
		const primary = makeChatModel("openai", "gpt-5");
		const backup = makeChatModel("anthropic", "claude-sonnet-4-5");
		const cfg = createDefaultConfig();
		cfg.fallbackChain = ["anthropic/claude-sonnet-4-5"];
		const tracker = new ModelHealthTracker();

		const res = await routeRequest(
			{
				model: makeVirtualModel(),
				thinkingLevel: "medium",
				reason: "retry",
				failed: {
					model: primary,
					thinkingLevel: "medium",
					message: {
						role: "assistant",
						content: [],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "error",
						errorMessage: "429 Too Many Requests",
						timestamp: 10,
					},
				},
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			},
			{
				modelRegistry: {
					getAvailable: () => [primary, backup],
					find: (p, id) => [primary, backup].find((m) => m.provider === p && m.id === id),
					hasConfiguredAuth: () => true,
					findOfType: () => undefined,
					getAvailableOfType: async () => [],
					classify: async () => {
						throw new Error("not used");
					},
				},
				config: cfg,
				healthTracker: tracker,
			},
		);

		assert.equal(res.model.id, "claude-sonnet-4-5");
		assert.equal(tracker.isAvailable("openai/gpt-5", cfg.health), false);
		assert.equal(res.state?.lastDecision.trigger, "failover");
	});

	it("observe 模式记录分类器推荐结果但实际派发默认模型", async () => {
		const defaultModel = makeChatModel("openai", "gpt-5");
		const strongModel = makeChatModel("anthropic", "claude-opus-4-5");
		const jev = makeClassifierModel();
		const cfg = createDefaultConfig();
		cfg.mode = "observe";
		cfg.defaultModel = "openai/gpt-5";

		const res = await routeRequest(
			{
				model: makeVirtualModel(),
				thinkingLevel: "medium",
				reason: "user",
				messages: [{ role: "user", content: "设计系统", timestamp: 1 }],
			},
			{
				modelRegistry: {
					getAvailable: () => [defaultModel, strongModel],
					find: (p, id) => [defaultModel, strongModel].find((m) => m.provider === p && m.id === id),
					hasConfiguredAuth: () => true,
					findOfType: () => jev,
					getAvailableOfType: async () => [jev],
					classify: async (): Promise<ClassifierResult> => ({
						api: jev.api,
						provider: jev.provider,
						model: jev.id,
						answers: {
							model: { type: "choice", choice: "anthropic/claude-opus-4-5", probabilities: { "anthropic/claude-opus-4-5": 0.95 }, confidence: 0.95 },
							effort: { type: "choice", choice: "high", probabilities: { high: 0.9 }, confidence: 0.9 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				},
				config: cfg,
				healthTracker: new ModelHealthTracker(),
			},
		);

		assert.equal(res.model.id, "gpt-5");
		assert.equal(res.state?.lastDecision.trigger, "observe");
		assert.equal(res.state?.lastDecision.recommendedModel, "anthropic/claude-opus-4-5");
	});

	it("新用户消息的 Benefit Gate 防抖：当 switch_benefit 为 hold 时保持当前模型保护缓存", async () => {
		const sonnet = makeChatModel("anthropic", "claude-sonnet-4-5");
		const opus = makeChatModel("anthropic", "claude-opus-4-5");
		const jev = makeClassifierModel();
		const cfg = createDefaultConfig();

		const prevState: FusionRouteState = {
			version: 1,
			selectedModel: "anthropic/claude-sonnet-4-5",
			thinkingLevel: "medium",
			taskSummary: "优化表单组件",
			decidedAtTurnStep: 0,
			continuationSteps: 0,
			consecutiveToolErrors: 0,
			attemptedModels: ["anthropic/claude-sonnet-4-5"],
			lastDecision: {
				model: "anthropic/claude-sonnet-4-5",
				thinkingLevel: "medium",
				reason: "init",
				trigger: "user_initial",
				timestamp: 1,
			},
		};

		let receivedSwitchQuestion = false;
		const res = await routeRequest(
			{
				model: makeVirtualModel(),
				thinkingLevel: "medium",
				reason: "user",
				state: prevState,
				previous: { model: sonnet, thinkingLevel: "medium" },
				messages: [
					{ role: "user", content: "优化表单组件", timestamp: 1 },
					{
						role: "user",
						content: "请再补充一个输入长度校验提示文案并运行测试",
						timestamp: 2,
					},
				],
			},
			{
				modelRegistry: {
					getAvailable: () => [sonnet, opus],
					find: (p, id) => [sonnet, opus].find((m) => m.provider === p && m.id === id),
					hasConfiguredAuth: () => true,
					findOfType: () => jev,
					getAvailableOfType: async () => [jev],
					classify: async (_model, context): Promise<ClassifierResult> => {
						receivedSwitchQuestion = "switch_benefit" in context.questions;
						return {
							api: jev.api,
							provider: jev.provider,
							model: jev.id,
							answers: {
								model: {
									type: "choice",
									choice: "anthropic/claude-opus-4-5",
									probabilities: { "anthropic/claude-opus-4-5": 0.72, "anthropic/claude-sonnet-4-5": 0.28 },
									confidence: 0.72,
								},
								effort: {
									type: "choice",
									choice: "medium",
									probabilities: { medium: 0.9 },
									confidence: 0.9,
								},
								switch_benefit: {
									type: "choice",
									choice: "hold",
									probabilities: { hold: 0.85, upgrade_quality: 0.15 },
									confidence: 0.85,
								},
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
					},
				},
				config: cfg,
				healthTracker: new ModelHealthTracker(),
			},
		);

		assert.equal(receivedSwitchQuestion, true);
		assert.equal(res.model.id, "claude-sonnet-4-5");
		assert.equal(res.state?.lastDecision.trigger, "sticky_hold");
	});

	it("direct 请求不调用 Classifier，不返回 state，并采用轻量思考强度", async () => {
		const mini = makeChatModel("openai", "gpt-4o-mini");
		const opus = makeChatModel("anthropic", "claude-opus-4-5");
		const jev = makeClassifierModel();
		const cfg = createDefaultConfig();

		let classifyCalled = false;
		const res = await routeRequest(
			{
				model: makeVirtualModel(),
				thinkingLevel: "xhigh",
				reason: "direct",
				messages: [{ role: "user", content: "生成会话压缩摘要", timestamp: 1 }],
			},
			{
				modelRegistry: {
					getAvailable: () => [opus, mini],
					find: (p, id) => [opus, mini].find((m) => m.provider === p && m.id === id),
					hasConfiguredAuth: () => true,
					findOfType: () => jev,
					getAvailableOfType: async () => [jev],
					classify: async () => {
						classifyCalled = true;
						throw new Error("direct request must not invoke classifier");
					},
				},
				config: cfg,
				healthTracker: new ModelHealthTracker(),
			},
		);

		assert.equal(classifyCalled, false);
		assert.equal(res.model.id, "gpt-4o-mini");
		assert.equal(res.thinkingLevel, "low");
		assert.equal(res.state, undefined);
	});
});
