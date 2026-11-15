import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, ClassifierApi, ClassifierModel, ClassifierResult, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
} from "@earendil-works/pi-coding-agent";
import fusionExtension from "../src/index.ts";
import type { FusionRouteState } from "../src/types.ts";

function makeChatModel(provider: string, id: string): Model<Api> {
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
	};
}

function makeClassifierModel(): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id: "jev-latest",
		name: "Jev",
		api: "typesafe-system-one",
		provider: "typesafe",
		baseUrl: "https://api.typesafe.ai/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
	};
}

describe("index 扩展集成与命令冒烟测试", () => {
	it("完整注册虚拟模型、事件钩子与 /fusion 斜杠命令", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fusion-ext-"));
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		mkdirSync(join(root, "project", ".pi"), { recursive: true });

		try {
			writeFileSync(
				join(root, "project", ".pi", "fusion-router.json"),
				JSON.stringify({
					mode: "auto",
					models: [
						{ provider: "anthropic", id: "claude-opus-4-5", priority: 95, costTier: "premium", specialty: "hard architecture" },
						{ provider: "openai", id: "gpt-4o-mini", priority: 60, costTier: "budget", specialty: "quick edits" },
					],
				}),
				"utf8",
			);

			let registeredVirtual: ExtensionVirtualModel<FusionRouteState> | undefined;
			const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
			const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();

			const mockPi = {
				registerVirtualModel(def: ExtensionVirtualModel<FusionRouteState>) {
					registeredVirtual = def;
				},
				unregisterVirtualModel() {},
				registerProvider() {},
				unregisterProvider() {},
				on(event: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
					const list = handlers.get(event) ?? [];
					list.push(fn);
					handlers.set(event, list);
					return () => {};
				},
				registerCommand(name: string, opts: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
					commands.set(name, opts);
				},
			} as unknown as ExtensionAPI;

			fusionExtension(mockPi);

			assert.ok(registeredVirtual);
			assert.equal(registeredVirtual.provider, "router");
			assert.equal(registeredVirtual.id, "fusion");
			assert.deepEqual(registeredVirtual.input, ["text", "image"]);
			assert.ok(commands.has("fusion"));
			assert.ok(commands.has("router"));

			const opus = makeChatModel("anthropic", "claude-opus-4-5");
			const mini = makeChatModel("openai", "gpt-4o-mini");
			const jev = makeClassifierModel();
			const notifications: string[] = [];
			const statusUpdates: Array<string | undefined> = [];

			const mockCtx = {
				cwd: join(root, "project"),
				hasUI: true,
				model: { provider: "router", id: "fusion", api: "pi-virtual", reasoning: true },
				ui: {
					notify: (msg: string) => notifications.push(msg),
					setStatus: (_key: string, text: string | undefined) => statusUpdates.push(text),
					theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
				},
				sessionManager: {
					getBranch: () => [
						{
							type: "custom",
							customType: VIRTUAL_MODEL_STATE_ENTRY,
							data: {
								provider: "router",
								modelId: "fusion",
								state: {
									version: 1,
									selectedModel: "openai/gpt-4o-mini",
									thinkingLevel: "low",
									decidedAtTurnStep: 0,
									continuationSteps: 0,
									consecutiveToolErrors: 0,
									attemptedModels: ["openai/gpt-4o-mini"],
									lastDecision: {
										model: "openai/gpt-4o-mini",
										thinkingLevel: "low",
										reason: "restored",
										trigger: "user_initial",
										timestamp: 1,
									},
								},
							},
						},
					],
				},
				modelRegistry: {
					getAvailable: () => [opus, mini],
					find: (p: string, id: string) => [opus, mini].find((m) => m.provider === p && m.id === id),
					hasConfiguredAuth: () => true,
					findOfType: () => jev,
					getAvailableOfType: async () => [jev],
					classify: async (): Promise<ClassifierResult> => ({
						api: jev.api,
						provider: jev.provider,
						model: jev.id,
						answers: {
							model: { type: "choice", choice: "anthropic/claude-opus-4-5", probabilities: { "anthropic/claude-opus-4-5": 0.9 }, confidence: 0.9 },
							effort: { type: "choice", choice: "high", probabilities: { high: 0.9 }, confidence: 0.9 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				},
			} as unknown as ExtensionContext;

			// 触发 session_start，验证项目配置加载与分支状态恢复
			for (const fn of handlers.get("session_start") ?? []) {
				await fn({}, mockCtx);
			}
			assert.equal(statusUpdates.at(-1), "Fusion: openai/gpt-4o-mini (low)");

			// 执行 /fusion status 与 /fusion test
			const fusionCmd = commands.get("fusion")!;
			await fusionCmd.handler("status", mockCtx as ExtensionCommandContext);
			await fusionCmd.handler("test 设计调度系统", mockCtx as ExtensionCommandContext);
			assert.equal(notifications.some((n) => n.includes("Pi-Fusion 路由状态")), true);
			assert.equal(notifications.some((n) => n.includes("推荐模型: anthropic/claude-opus-4-5")), true);

			// 模拟 message_end 失败后 /fusion health 显示冷却，随后 /fusion health reset 清除
			for (const fn of handlers.get("message_end") ?? []) {
				await fn(
					{
						message: {
							role: "assistant",
							provider: "openai",
							model: "gpt-4o-mini",
							stopReason: "error",
							errorMessage: "429 rate limit",
						},
					},
					mockCtx,
				);
			}
			await fusionCmd.handler("health", mockCtx as ExtensionCommandContext);
			assert.equal(notifications.some((n) => n.includes("冷却中")), true);

			await fusionCmd.handler("health reset", mockCtx as ExtensionCommandContext);
			assert.equal(notifications.some((n) => n.includes("已重置全部模型健康状态")), true);

			// 验证 /router 同义命令、explain、classifier、mode off/on
			const routerCmd = commands.get("router")!;
			await routerCmd.handler("explain", mockCtx as ExtensionCommandContext);
			assert.equal(notifications.some((n) => n.includes("最近一次路由决策详情")), true);

			await routerCmd.handler("classifier", mockCtx as ExtensionCommandContext);
			assert.equal(notifications.some((n) => n.includes("可用分类器链")), true);

			await routerCmd.handler("mode off", mockCtx as ExtensionCommandContext);
			assert.equal(statusUpdates.at(-1), "Fusion: 已停用");

			await routerCmd.handler("mode on", mockCtx as ExtensionCommandContext);
			assert.equal(statusUpdates.at(-1), "Fusion: openai/gpt-4o-mini (low)");

			// 验证 session_shutdown 清理状态栏
			for (const fn of handlers.get("session_shutdown") ?? []) {
				await fn({}, mockCtx);
			}
			assert.equal(statusUpdates.at(-1), undefined);
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
