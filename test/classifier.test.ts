import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, Model } from "@earendil-works/pi-ai";
import {
	buildClassifierContext,
	buildClassifierInputSummary,
	readPiClassifierEndpointHints,
	resolveClassifierApiKeyReference,
	resolveClassifierChain,
	resolveCustomClassifierTarget,
	runClassifierDecision,
} from "../src/classifier.ts";
import { createDefaultConfig } from "../src/config.ts";
import type { ResolvedCandidate } from "../src/types.ts";

function makeClassifier(provider: string, id: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "typesafe-system-one",
		provider,
		baseUrl: "https://api.example.com/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
	};
}

function makeCandidate(provider: string, id: string, priority: number): ResolvedCandidate {
	const model: Model<Api> = {
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
	};
	return {
		key: `${provider}/${id}`,
		profile: {
			provider,
			id,
			enabled: true,
			priority,
			costTier: "balanced",
			specialty: `${id} specialty`,
		},
		model,
		contextWindow: 200_000,
		maxTokens: 16_384,
	};
}

describe("classifier 决策器封装", () => {
	it("构建紧凑摘要与任意数量候选模型的结构化提问", () => {
		const summary = buildClassifierInputSummary({
			messages: [
				{ role: "user", content: "old message", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "old reply" }], api: "openai-responses", provider: "openai", model: "gpt-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
				{ role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "command failed" }], isError: true, timestamp: 3 },
				{ role: "user", content: "请修复并发竞争问题", timestamp: 4 },
			],
			turnStepCount: 3,
			consecutiveToolErrors: 1,
			currentModelKey: "openai/gpt-5",
			currentThinkingLevel: "medium",
		});

		assert.equal(summary.currentRequest, "请修复并发竞争问题");
		assert.equal(summary.recentContext.length, 3);
		assert.equal(summary.recentContext[2]?.isError, true);

		// 支持 5 个任意候选模型，不局限为 3 档
		const candidates = [
			makeCandidate("a", "m1", 90),
			makeCandidate("a", "m2", 80),
			makeCandidate("b", "m3", 70),
			makeCandidate("b", "m4", 60),
			makeCandidate("c", "m5", 50),
		];
		const ctx = buildClassifierContext({
			summary,
			candidates,
			efforts: { low: "simple", medium: "normal", high: "complex" },
			preferences: "Prefer accuracy",
			includeSwitchBenefit: true,
		});

		const modelQ = ctx.questions.model;
		assert.equal(modelQ?.type, "choice");
		if (modelQ?.type === "choice") {
			assert.equal(Object.keys(modelQ.criteria).length, 5);
			assert.ok("c/m5" in modelQ.criteria);
		}
		assert.ok("switch_benefit" in ctx.questions);
	});

	it("按配置优先级、别名与内置序解析可用分类器链", async () => {
		const jev = makeClassifier("typesafe", "jev-latest");
		const clef = makeClassifier("cloudflare-workers-ai", "@cf/cloudflare/clef");
		const gpt6Luna = makeClassifier("openai", "gpt-6-luna");

		const registry = {
			getAvailableOfType: async () => [clef, jev, gpt6Luna] as const,
			findOfType: (_t: "classifier", p: string, id: string) =>
				[clef, jev, gpt6Luna].find((m) => m.provider === p && m.id === id),
		};

		const cfg = createDefaultConfig();
		// 测试旧版别名自动映射：azure-foundry/decision-1 -> openai/gpt-6-luna
		cfg.classifier.provider = "azure-foundry";
		cfg.classifier.model = "decision-1";
		const chain = await resolveClassifierChain(registry, cfg.classifier);
		assert.equal(chain[0]?.key, "openai/gpt-6-luna");
		assert.equal(chain[1]?.key, "typesafe/jev-latest");
		assert.equal(chain[2]?.key, "cloudflare-workers-ai/@cf/cloudflare/clef");
	});

	it("主分类器超时或异常时自动沿备用链降级且永不抛异常", async () => {
		const primary = makeClassifier("typesafe", "jev-latest");
		const backup = makeClassifier("cloudflare-workers-ai", "@cf/cloudflare/clef");

		const decision = await runClassifierDecision({
			modelRegistry: {
				classify: async (model, _context, options): Promise<ClassifierResult> => {
					if (model.id === "jev-latest") {
						return new Promise((resolve) => {
							options?.signal?.addEventListener("abort", () => {
								resolve({
									api: model.api,
									provider: model.provider,
									model: model.id,
									answers: {},
									stopReason: "aborted",
									timestamp: Date.now(),
								});
							});
						});
					}
					return {
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: {
							model: { type: "choice", choice: "anthropic/claude-sonnet-4-5", probabilities: { "anthropic/claude-sonnet-4-5": 0.88 }, confidence: 0.88 },
							effort: { type: "choice", choice: "high", probabilities: { high: 0.8 }, confidence: 0.8 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
				},
			},
			classifiers: [
				{ key: "typesafe/jev-latest", model: primary, source: "builtin" },
				{ key: "cloudflare-workers-ai/@cf/cloudflare/clef", model: backup, source: "builtin" },
			],
			context: {
				state: {},
				questions: {
					model: {
						type: "choice",
						instructions: "pick model",
						criteria: {
							"anthropic/claude-sonnet-4-5": "sonnet",
							"anthropic/claude-opus-4-5": "opus",
						},
					},
					effort: {
						type: "choice",
						instructions: "pick effort",
						criteria: { low: "low", medium: "medium", high: "high" },
					},
				},
			} as ClassifierContext,
			timeoutMs: 30,
		});

		assert.ok(decision);
		assert.equal(decision.classifierModelKey, "cloudflare-workers-ai/@cf/cloudflare/clef");
		assert.equal(decision.selectedModelKey, "anthropic/claude-sonnet-4-5");
		assert.equal(decision.effortLabel, "high");
	});

	it("分类器返回未声明的选项或越界置信度时自动拒绝并尝试备用链", async () => {
		const primary = makeClassifier("typesafe", "jev-latest");
		const backup = makeClassifier("cloudflare-workers-ai", "@cf/cloudflare/clef");

		const decision = await runClassifierDecision({
			modelRegistry: {
				classify: async (model): Promise<ClassifierResult> => {
					if (model.id === "jev-latest") {
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: {
								model: {
									type: "choice",
									choice: "unknown/hallucinated-model",
									probabilities: { "unknown/hallucinated-model": 0.9 },
									confidence: 0.9,
								},
							},
							stopReason: "stop",
							timestamp: Date.now(),
						};
					}
					return {
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: {
							model: {
								type: "choice",
								choice: "anthropic/claude-sonnet-4-5",
								probabilities: { "anthropic/claude-sonnet-4-5": 0.91 },
								confidence: 0.91,
							},
							effort: {
								type: "choice",
								choice: "medium",
								probabilities: { medium: 0.85 },
								confidence: 0.85,
							},
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
				},
			},
			classifiers: [
				{ key: "typesafe/jev-latest", model: primary, source: "builtin" },
				{ key: "cloudflare-workers-ai/@cf/cloudflare/clef", model: backup, source: "builtin" },
			],
			context: {
				state: {},
				questions: {
					model: {
						type: "choice",
						instructions: "pick model",
						criteria: { "anthropic/claude-sonnet-4-5": "sonnet" },
					},
					effort: {
						type: "choice",
						instructions: "pick effort",
						criteria: { medium: "medium" },
					},
				},
			} as ClassifierContext,
			timeoutMs: 100,
		});

		assert.ok(decision);
		assert.equal(decision.classifierModelKey, "cloudflare-workers-ai/@cf/cloudflare/clef");
		assert.equal(decision.selectedModelKey, "anthropic/claude-sonnet-4-5");
	});

	it("只读解析 pi-classifier 配置提示不触碰外部目录", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fusion-hint-"));
		try {
			mkdirSync(root, { recursive: true });
			writeFileSync(
				join(root, "settings.json"),
				JSON.stringify({
					classifier: {
						baseUrl: "https://classifier.example.com/v1/",
						model: "jev/jev-latest",
					},
				}),
				"utf8",
			);
			const hints = readPiClassifierEndpointHints(root);
			assert.equal(hints.baseUrl, "https://classifier.example.com/v1");
			assert.equal(hints.model, "jev/jev-latest");

			// 导入端点使用 pi-classifier 的模型，并在分类器链中优先于内置分类器
			const cfg = createDefaultConfig();
			cfg.classifier.customEndpoint = { importFromPiClassifier: true };
			const target = resolveCustomClassifierTarget(cfg.classifier, root);
			assert.deepEqual(target, {
				providerId: "fusion-classifier",
				modelId: "jev/jev-latest",
				baseUrl: "https://classifier.example.com/v1",
				api: "typesafe-system-one",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("自定义端点在分类器链中优先，并按配置与环境变量解析密钥引用", async () => {
		const jev = makeClassifier("typesafe", "jev-latest");
		const custom = makeClassifier("fusion-classifier", "jev-custom");
		const registry = {
			getAvailableOfType: async () => [jev, custom] as const,
			findOfType: (_t: "classifier", p: string, id: string) =>
				[jev, custom].find((m) => m.provider === p && m.id === id),
		};
		const cfg = createDefaultConfig();
		cfg.classifier.model = "jev-custom";
		cfg.classifier.customEndpoint = { baseUrl: "https://classifier.example.com/v1/" };

		const autoChain = await resolveClassifierChain(registry, cfg.classifier);
		assert.equal(autoChain[0]?.key, "fusion-classifier/jev-custom");
		assert.equal(autoChain[0]?.source, "custom");

		cfg.classifier.provider = "custom";
		const customChain = await resolveClassifierChain(registry, cfg.classifier);
		assert.equal(customChain[0]?.key, "fusion-classifier/jev-custom");

		assert.equal(resolveClassifierApiKeyReference({ apiKeyEnv: "$MY_KEY" }, {}), "$MY_KEY");
		assert.equal(resolveClassifierApiKeyReference({}, { TYPESAFE_API_KEY: "x" }), "$TYPESAFE_API_KEY");
		assert.equal(
			resolveClassifierApiKeyReference({}, { CLASSIFIER_API_KEY: "a", TYPESAFE_API_KEY: "b" }),
			"$CLASSIFIER_API_KEY",
		);
		assert.equal(resolveClassifierApiKeyReference({}, {}), "$CLASSIFIER_API_KEY");
	});
});
