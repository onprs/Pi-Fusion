import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyModelFailure, ModelHealthTracker } from "../src/health.ts";
import type { HealthConfig } from "../src/types.ts";

const POLICY: HealthConfig = {
	enabled: true,
	autoFailover: true,
	cooldownSeconds: 90,
	maxCooldownSeconds: 900,
};

describe("health 模型健康管理", () => {
	it("能够准确分类故障且排除用户取消与上下文溢出", () => {
		assert.equal(classifyModelFailure("error", "429 Too Many Requests").category, "rate_limit");
		assert.equal(classifyModelFailure("error", "503 Service Unavailable").category, "unavailable");
		assert.equal(classifyModelFailure("error", "Request timed out ETIMEDOUT").category, "timeout");
		assert.equal(classifyModelFailure("error", "401 Invalid API Key").category, "auth");

		const aborted = classifyModelFailure("aborted", "Request was aborted");
		assert.equal(aborted.category, "aborted");
		assert.equal(aborted.shouldCooldown, false);

		const overflow = classifyModelFailure("error", "context_length_exceeded: too many tokens");
		assert.equal(overflow.category, "context_overflow");
		assert.equal(overflow.shouldCooldown, false);
	});

	it("未知错误仅在 Pi 判定为可重试的上游故障时冷却", () => {
		const transient = classifyModelFailure("error", "Provider returned error");
		assert.equal(transient.category, "unknown");
		assert.equal(transient.shouldCooldown, true);
		assert.equal(transient.shouldFailover, true);

		const deterministic = classifyModelFailure("error", "Invalid tool schema: missing required property");
		assert.equal(deterministic.category, "unknown");
		assert.equal(deterministic.shouldCooldown, false);
		assert.equal(deterministic.shouldFailover, false);

		const tracker = new ModelHealthTracker();
		const result = tracker.reportFailure("openai/gpt-5", "error", "Invalid tool schema", POLICY);
		assert.equal(result.recorded, false);
		assert.equal(tracker.isAvailable("openai/gpt-5", POLICY), true);
	});

	it("支持 1500ms 防抖去重与指数退避冷却", () => {
		let now = 1_000_000;
		const tracker = new ModelHealthTracker(() => now);
		const key = "openai/gpt-5";

		// 第 1 次 429 触发 90s 冷却
		const r1 = tracker.reportFailure(key, "error", "429 rate limit", POLICY);
		assert.equal(r1.recorded, true);
		assert.equal(tracker.isAvailable(key, POLICY), false);
		assert.equal(tracker.getSnapshot(key, POLICY).remainingCooldownMs, 90_000);

		// 500ms 内重复上报同类型错误应被去重
		now += 500;
		const rDup = tracker.reportFailure(key, "error", "429 rate limit", POLICY);
		assert.equal(rDup.recorded, false);
		assert.equal(tracker.getSnapshot(key, POLICY).consecutiveFailures, 1);

		// 冷却过期后再次失败应指数退避为 180s
		now += 95_000;
		assert.equal(tracker.getSnapshot(key, POLICY).status, "ready_to_retry");
		const r2 = tracker.reportFailure(key, "error", "429 rate limit", POLICY);
		assert.equal(r2.recorded, true);
		assert.equal(tracker.getSnapshot(key, POLICY).consecutiveFailures, 2);
		assert.equal(tracker.getSnapshot(key, POLICY).remainingCooldownMs, 180_000);

		// auth 错误直接采用上限冷却 900s
		now += 200_000;
		const rAuth = tracker.reportFailure("anthropic/claude", "error", "401 unauthorized", POLICY);
		assert.equal(rAuth.recorded, true);
		assert.equal(tracker.getSnapshot("anthropic/claude", POLICY).remainingCooldownMs, 900_000);

		// 成功响应立即解除冷却并清零计数
		tracker.reportSuccess(key);
		assert.equal(tracker.getSnapshot(key, POLICY).status, "healthy");
		assert.equal(tracker.getSnapshot(key, POLICY).consecutiveFailures, 0);
	});
});
