import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildCandidatePool, estimateUsedTokensFromMessages } from "../src/catalog.ts";
import { createDefaultConfig } from "../src/config.ts";
import { ModelHealthTracker } from "../src/health.ts";

function makeModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
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

describe("catalog 候选模型池与容量守卫", () => {
	it("自动排除虚拟模型与未认证模型，并在大池场景收敛到最多 12 个模型", () => {
		const models: Model<Api>[] = [
			makeModel("router", "fusion", { api: "pi-virtual" as Api }),
		];
		for (let i = 0; i < 16; i++) {
			const tierTag = i % 3 === 0 ? "opus" : i % 3 === 1 ? "sonnet" : "haiku";
			models.push(makeModel("anthropic", `claude-${tierTag}-${i}`));
		}
		const unauthed = makeModel("openai", "gpt-5-no-auth");

		const registry = {
			getAvailable: () => models,
			find: (p: string, id: string) => [...models, unauthed].find((m) => m.provider === p && m.id === id),
			hasConfiguredAuth: (m: Model<Api>) => m.id !== "gpt-5-no-auth",
		};

		const cfg = createDefaultConfig();
		const tracker = new ModelHealthTracker();
		const pool = buildCandidatePool({
			modelRegistry: registry,
			config: cfg,
			healthTracker: tracker,
			currentModelKey: "anthropic/claude-sonnet-1",
		});

		assert.equal(pool.discoveredFromRegistry, true);
		assert.equal(pool.allResolved.some((c) => c.key === "router/fusion"), false);
		assert.equal(pool.allResolved.some((c) => c.key === "openai/gpt-5-no-auth"), false);
		assert.equal(pool.forDecision.length <= 12, true);
	});

	it("已用 Token 超过上限时排除小窗口模型，全部超限时触发防死锁兜底", () => {
		const small = makeModel("provider-a", "small-32k", { contextWindow: 32_000, maxTokens: 4_096 });
		const large = makeModel("provider-b", "large-200k", { contextWindow: 200_000, maxTokens: 16_384 });
		const registry = {
			getAvailable: () => [small, large],
			find: (p: string, id: string) => [small, large].find((m) => m.provider === p && m.id === id),
			hasConfiguredAuth: () => true,
		};

		const cfg = createDefaultConfig();
		cfg.models = [
			{ provider: "provider-a", id: "small-32k", enabled: true, priority: 90, costTier: "budget", specialty: "fast" },
			{ provider: "provider-b", id: "large-200k", enabled: true, priority: 70, costTier: "balanced", specialty: "long" },
		];
		const tracker = new ModelHealthTracker();

		// 30_000 + 4_096 + 2_048 > 32_000 -> small 被排除
		const pool1 = buildCandidatePool({
			modelRegistry: registry,
			config: cfg,
			healthTracker: tracker,
			usedTokens: 30_000,
		});
		assert.deepEqual(pool1.excludedByContext, ["provider-a/small-32k"]);
		assert.deepEqual(pool1.contextSafe.map((c) => c.key), ["provider-b/large-200k"]);

		// 全部超限时保留全量健康列表交给 Compaction
		const pool2 = buildCandidatePool({
			modelRegistry: registry,
			config: cfg,
			healthTracker: tracker,
			usedTokens: 250_000,
		});
		assert.equal(pool2.contextSafe.length, 2);
	});

	it("能够从历史 assistant usage 估算当前上下文 Token", () => {
		const tokens = estimateUsedTokensFromMessages([
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				usage: {
					input: 1000,
					output: 200,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1200,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		]);
		assert.equal(tokens, 1200);
	});
});
