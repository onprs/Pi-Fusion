import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampToSupportedThinkingLevel, resolveThinkingLevel } from "../src/effort.ts";

function makeThinkingModel(overrides: Partial<Model<Api>> = {}): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
	return {
		reasoning: true,
		thinkingLevelMap: undefined,
		...overrides,
	};
}

describe("effort Thinking 强度映射与 Clamp", () => {
	it("非推理模型强制返回 off", () => {
		const nonReasoning = makeThinkingModel({ reasoning: false });
		assert.equal(clampToSupportedThinkingLevel(nonReasoning, "high"), "off");
		assert.equal(
			resolveThinkingLevel({
				physicalModel: nonReasoning,
				requestedThinkingLevel: "xhigh",
				classifierEffortLabel: "high",
				thinkingMode: "auto",
			}),
			"off",
		);
	});

	it("不支持 xhigh 或 minimal 时自动就近适配", () => {
		const model = makeThinkingModel({
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null },
		});
		assert.equal(clampToSupportedThinkingLevel(model, "xhigh"), "high");
		assert.equal(clampToSupportedThinkingLevel(model, "minimal"), "low");
	});

	it("支持 passthrough、profile-default 与 effortMap 映射", () => {
		const model = makeThinkingModel({
			reasoning: true,
			thinkingLevelMap: { off: "off", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		});

		assert.equal(
			resolveThinkingLevel({
				physicalModel: model,
				requestedThinkingLevel: "low",
				classifierEffortLabel: "high",
				thinkingMode: "passthrough",
			}),
			"low",
		);

		assert.equal(
			resolveThinkingLevel({
				physicalModel: model,
				profile: {
					provider: "p",
					id: "m",
					enabled: true,
					priority: 80,
					costTier: "balanced",
					specialty: "test",
					defaultThinking: "medium",
					effortMap: { high: "xhigh" },
				},
				requestedThinkingLevel: "medium",
				classifierEffortLabel: "high",
				thinkingMode: "profile-default",
			}),
			"medium",
		);

		assert.equal(
			resolveThinkingLevel({
				physicalModel: model,
				profile: {
					provider: "p",
					id: "m",
					enabled: true,
					priority: 80,
					costTier: "balanced",
					specialty: "test",
					effortMap: { high: "xhigh" },
				},
				requestedThinkingLevel: "medium",
				classifierEffortLabel: "high",
				thinkingMode: "auto",
			}),
			"xhigh",
		);

		// 用户显式关闭思考时尊重 off
		assert.equal(
			resolveThinkingLevel({
				physicalModel: model,
				requestedThinkingLevel: "off",
				classifierEffortLabel: "high",
				thinkingMode: "auto",
			}),
			"off",
		);
	});
});
