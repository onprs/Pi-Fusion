import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface Harness {
	root: string;
	globalPath: string;
	projectPath: string;
	commands: Map<string, { handler: CommandHandler }>;
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>;
	registeredVirtual: () => ExtensionVirtualModel<FusionRouteState> | undefined;
	registeredProviders: string[];
	unregisteredProviders: string[];
	notifications: string[];
	statusUpdates: Array<string | undefined>;
	selectAnswers: Array<string | undefined | ((options: string[]) => string | undefined)>;
	inputAnswers: Array<string | undefined>;
	ctx: ExtensionCommandContext;
	run: (args: string) => Promise<void>;
	startSession: () => Promise<void>;
	readJson: (path: string) => Record<string, unknown>;
}

const restoredState: FusionRouteState = {
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
};

function createHarness(root: string, options?: { withBranchState?: boolean }): Harness {
	const globalDir = join(root, "agent");
	const projectDir = join(root, "project");
	const globalPath = join(globalDir, "fusion-router.json");
	const projectPath = join(projectDir, ".pi", "fusion-router.json");

	let registeredVirtual: ExtensionVirtualModel<FusionRouteState> | undefined;
	const handlers: Harness["handlers"] = new Map();
	const commands: Harness["commands"] = new Map();
	const registeredProviders: string[] = [];
	const unregisteredProviders: string[] = [];
	const notifications: string[] = [];
	const statusUpdates: Array<string | undefined> = [];
	const selectAnswers: Harness["selectAnswers"] = [];
	const inputAnswers: Harness["inputAnswers"] = [];

	const mockPi = {
		registerVirtualModel(def: ExtensionVirtualModel<FusionRouteState>) {
			registeredVirtual = def;
		},
		unregisterVirtualModel() {},
		registerProvider(id: string) {
			registeredProviders.push(id);
		},
		unregisterProvider(id: string) {
			unregisteredProviders.push(id);
		},
		on(event: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			const list = handlers.get(event) ?? [];
			list.push(fn);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, opts: { handler: CommandHandler }) {
			commands.set(name, opts);
		},
	} as unknown as ExtensionAPI;

	fusionExtension(mockPi);

	const opus = makeChatModel("anthropic", "claude-opus-4-5");
	const mini = makeChatModel("openai", "gpt-4o-mini");
	const jev = makeClassifierModel();

	const ctx = {
		cwd: projectDir,
		hasUI: true,
		model: { provider: "router", id: "fusion", api: "pi-virtual", reasoning: true },
		ui: {
			notify: (msg: string) => notifications.push(msg),
			setStatus: (_key: string, text: string | undefined) => statusUpdates.push(text),
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			select: async (_title: string, opts: string[]) => {
				const next = selectAnswers.shift();
				return typeof next === "function" ? next(opts) : next;
			},
			input: async () => inputAnswers.shift(),
			editor: async () => inputAnswers.shift(),
		},
		sessionManager: {
			getBranch: () =>
				options?.withBranchState
					? [
							{
								type: "custom",
								customType: VIRTUAL_MODEL_STATE_ENTRY,
								data: { provider: "router", modelId: "fusion", state: restoredState },
							},
						]
					: [],
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
	} as unknown as ExtensionCommandContext;

	return {
		root,
		globalPath,
		projectPath,
		commands,
		handlers,
		registeredVirtual: () => registeredVirtual,
		registeredProviders,
		unregisteredProviders,
		notifications,
		statusUpdates,
		selectAnswers,
		inputAnswers,
		ctx,
		run: (args: string) => commands.get("fusion")!.handler(args, ctx),
		startSession: async () => {
			for (const fn of handlers.get("session_start") ?? []) {
				await fn({}, ctx);
			}
		},
		readJson: (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
	};
}

describe("index 扩展集成与命令冒烟测试", () => {
	let root: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-fusion-ext-"));
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
		mkdirSync(join(root, "project", ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	const writeProjectModels = (): void => {
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
	};

	it("完整注册虚拟模型、事件钩子与 /fusion 斜杠命令", async () => {
		writeProjectModels();
		const h = createHarness(root, { withBranchState: true });

		const virtual = h.registeredVirtual();
		assert.ok(virtual);
		assert.equal(virtual.provider, "router");
		assert.equal(virtual.id, "fusion");
		assert.deepEqual(virtual.input, ["text", "image"]);
		assert.ok(h.commands.has("fusion"));
		assert.ok(h.commands.has("router"));

		// 触发 session_start，验证项目配置加载与分支状态恢复
		await h.startSession();
		assert.equal(h.statusUpdates.at(-1), "Fusion: gpt-4o-mini • low");

		await h.run("status");
		await h.run("test 设计调度系统");
		assert.equal(h.notifications.some((n) => n.includes("Pi-Fusion 路由状态")), true);
		assert.equal(h.notifications.some((n) => n.includes("推荐模型: anthropic/claude-opus-4-5")), true);

		// 模拟 message_end 失败后 /fusion health 显示冷却，随后 /fusion health reset 清除
		for (const fn of h.handlers.get("message_end") ?? []) {
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
				h.ctx,
			);
		}
		await h.run("health");
		assert.equal(h.notifications.some((n) => n.includes("冷却中")), true);
		await h.run("status");
		assert.equal(h.notifications.some((n) => n.includes("冷却中: openai/gpt-4o-mini")), true);

		await h.run("health reset");
		assert.equal(h.notifications.some((n) => n.includes("已重置全部模型健康状态")), true);

		const routerCmd = h.commands.get("router")!;
		await routerCmd.handler("explain", h.ctx);
		assert.equal(h.notifications.some((n) => n.includes("最近一次路由决策详情")), true);

		await routerCmd.handler("classifier list", h.ctx);
		assert.equal(h.notifications.some((n) => n.includes("可用分类器链")), true);

		await routerCmd.handler("mode off", h.ctx);
		assert.equal(h.statusUpdates.at(-1), "Fusion: 已停用");

		await routerCmd.handler("mode on", h.ctx);
		assert.equal(h.statusUpdates.at(-1), "Fusion: gpt-4o-mini • low");

		for (const fn of h.handlers.get("session_shutdown") ?? []) {
			await fn({}, h.ctx);
		}
		assert.equal(h.statusUpdates.at(-1), undefined);
	});

	it("保存配置时仅写入目标层级，不把全局与项目配置互相复制", async () => {
		writeFileSync(
			join(root, "agent", "fusion-router.json"),
			JSON.stringify({
				preferences: "全局偏好",
				models: [
					{ provider: "anthropic", id: "claude-opus-4-5", priority: 95, costTier: "premium", specialty: "hard architecture" },
					{ provider: "openai", id: "gpt-4o-mini", priority: 60, costTier: "budget", specialty: "quick edits" },
				],
			}),
			"utf8",
		);
		writeFileSync(join(root, "project", ".pi", "fusion-router.json"), JSON.stringify({ mode: "auto" }), "utf8");
		const h = createHarness(root);
		await h.startSession();
		const globalBefore = readFileSync(h.globalPath, "utf8");

		// 默认写入项目层：仅包含变更字段
		await h.run("mode observe");
		const project = h.readJson(h.projectPath);
		assert.equal(project.mode, "observe");
		assert.equal(project.preferences, undefined);
		assert.equal(project.models, undefined);
		assert.equal(readFileSync(h.globalPath, "utf8"), globalBefore);

		// 在项目层停用全局定义的模型：只写入 enabled 字段，合并后保留全局画像
		await h.run("models disable openai/gpt-4o-mini");
		const projectAfter = h.readJson(h.projectPath);
		assert.deepEqual(projectAfter.models, [{ provider: "openai", id: "gpt-4o-mini", enabled: false }]);
		await h.run("models list");
		const listing = h.notifications.at(-1) ?? "";
		assert.match(listing, /openai\/gpt-4o-mini \| 停用 \| budget \| P60/);
		assert.match(listing, /anthropic\/claude-opus-4-5 \| 启用 \| premium \| P95/);
		assert.equal(readFileSync(h.globalPath, "utf8"), globalBefore);
	});

	it("配置文件损坏时保存失败并保留原文件", async () => {
		const h = createHarness(root);
		writeFileSync(h.projectPath, "{ invalid json", "utf8");
		await h.startSession();
		await h.run("mode observe");
		assert.match(h.notifications.at(-1) ?? "", /保存配置失败/);
		assert.equal(readFileSync(h.projectPath, "utf8"), "{ invalid json");
	});

	it("支持通过命令启用、停用、设置默认模型与修改画像字段", async () => {
		writeProjectModels();
		const h = createHarness(root);
		await h.startSession();

		await h.run("models default anthropic/claude-opus-4-5");
		assert.equal(h.readJson(h.projectPath).defaultModel, "anthropic/claude-opus-4-5");

		await h.run("models set openai/gpt-4o-mini priority 80");
		await h.run("models set openai/gpt-4o-mini thinking low");
		await h.run("models set openai/gpt-4o-mini specialty 文档整理与小改动");
		await h.run("models set openai/gpt-4o-mini priority 999");
		assert.match(h.notifications.at(-1) ?? "", /优先级必须是 1~100 的整数/);

		const models = h.readJson(h.projectPath).models as Array<Record<string, unknown>>;
		const mini = models.find((m) => m.id === "gpt-4o-mini");
		assert.equal(mini?.priority, 80);
		assert.equal(mini?.defaultThinking, "low");
		assert.equal(mini?.specialty, "文档整理与小改动");

		await h.run("models set openai/gpt-4o-mini thinking auto");
		const cleared = (h.readJson(h.projectPath).models as Array<Record<string, unknown>>).find((m) => m.id === "gpt-4o-mini");
		assert.equal(cleared?.defaultThinking, null);
		await h.run("models list");
		assert.doesNotMatch(h.notifications.at(-1) ?? "", /gpt-4o-mini[^\n]*思考/);

		// 停用最后一个可用模型时拒绝
		await h.run("models disable anthropic/claude-opus-4-5");
		await h.run("models disable openai/gpt-4o-mini");
		assert.match(h.notifications.at(-1) ?? "", /至少需要保留 1 个/);

		await h.run("models default clear");
		assert.equal(h.readJson(h.projectPath).defaultModel, "");

		await h.run("models enable unknown/model");
		assert.match(h.notifications.at(-1) ?? "", /未找到已认证的模型/);
	});

	it("自动发现状态下修改模型会先保存发现结果，保持候选池不变", async () => {
		const h = createHarness(root);
		await h.startSession();
		await h.run("models disable openai/gpt-4o-mini");
		const saved = h.readJson(h.globalPath).models as Array<Record<string, unknown>>;
		assert.equal(saved.length, 2);
		assert.equal(saved.find((m) => m.id === "gpt-4o-mini")?.enabled, false);
		assert.equal(saved.find((m) => m.id === "claude-opus-4-5")?.enabled, true);
		assert.equal(existsSync(h.projectPath), false);
	});

	it("交互式模型管理菜单可切换保存位置并修改模型", async () => {
		writeProjectModels();
		const h = createHarness(root);
		await h.startSession();

		const pickModel = (options: string[]) => options.find((o) => o.startsWith("openai/gpt-4o-mini"));
		h.selectAnswers.push(
			(options) => options.find((o) => o.startsWith("保存位置")),
			pickModel,
			(options) => options.find((o) => o.startsWith("成本档位")),
			"premium",
			pickModel,
			(options) => options.find((o) => o.startsWith("优先级")),
			undefined,
		);
		h.inputAnswers.push("70");
		await h.run("models");

		// 保存位置切换为全局后，修改只写入全局层，项目层保持原样；项目层字段仍覆盖全局层
		const globalMini = (h.readJson(h.globalPath).models as Array<Record<string, unknown>>)
			.find((m) => m.id === "gpt-4o-mini");
		assert.deepEqual(globalMini, { provider: "openai", id: "gpt-4o-mini", costTier: "premium", priority: 70 });
		const projectMini = (h.readJson(h.projectPath).models as Array<Record<string, unknown>>)
			.find((m) => m.id === "gpt-4o-mini");
		assert.equal(projectMini?.costTier, "budget");
		assert.equal(projectMini?.priority, 60);
	});

	it("交互式切换决策分类器并配置、清除自定义决策端点", async () => {
		const h = createHarness(root);
		await h.startSession();

		h.selectAnswers.push("typesafe/jev-latest");
		await h.run("classifier");
		const classifier = h.readJson(h.globalPath).classifier as Record<string, unknown>;
		assert.equal(classifier.provider, "typesafe");
		assert.equal(classifier.model, "jev-latest");

		await h.run("classifier endpoint https://classifier.example.com/v1/ typesafe-system-one MY_CLASSIFIER_KEY");
		const withEndpoint = h.readJson(h.globalPath).classifier as Record<string, unknown>;
		assert.equal(withEndpoint.provider, "auto");
		assert.deepEqual(withEndpoint.customEndpoint, {
			baseUrl: "https://classifier.example.com/v1",
			importFromPiClassifier: false,
			api: "typesafe-system-one",
			apiKeyEnv: "MY_CLASSIFIER_KEY",
		});
		assert.equal(h.registeredProviders.includes("fusion-classifier"), true);

		await h.run("classifier endpoint ftp://bad");
		assert.match(h.notifications.at(-1) ?? "", /端点地址无效/);

		await h.run("classifier endpoint clear");
		assert.equal((h.readJson(h.globalPath).classifier as Record<string, unknown>).customEndpoint, null);
		assert.equal(h.unregisteredProviders.includes("fusion-classifier"), true);
	});
});
