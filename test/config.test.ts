import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createDefaultConfig,
	getGlobalConfigPath,
	getProjectConfigPath,
	loadFusionRouterConfig,
	mergeAndValidateConfig,
	migrateLegacyConfig,
	parseModelKey,
	saveFusionRouterConfig,
} from "../src/config.ts";

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("config 配置系统", () => {
	it("支持跨平台路径解析且项目配置覆盖全局配置", () => {
		const root = makeTempDir("pi-fusion-cfg-");
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "workspace");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(projectDir, ".pi"), { recursive: true });

			writeFileSync(
				getGlobalConfigPath(agentDir),
				JSON.stringify({
					mode: "observe",
					classifier: { provider: "typesafe", model: "jev-latest", timeoutMs: 3000 },
					models: [
						{ provider: "anthropic", id: "claude-sonnet-4-5", costTier: "balanced", priority: 80, specialty: "coding" },
						{ provider: "openai", id: "gpt-4o-mini", costTier: "budget", priority: 60, specialty: "fast" },
					],
					preferences: "global preference",
				}),
				"utf8",
			);

			writeFileSync(
				getProjectConfigPath(projectDir),
				JSON.stringify({
					mode: "auto",
					preferences: "project preference",
					models: [
						{ provider: "anthropic", id: "claude-sonnet-4-5", costTier: "balanced", priority: 95, specialty: "project core" },
					],
				}),
				"utf8",
			);

			const loaded = loadFusionRouterConfig({ cwd: projectDir, agentDir });
			assert.equal(loaded.globalExists, true);
			assert.equal(loaded.projectExists, true);
			assert.equal(loaded.config.mode, "auto");
			assert.equal(loaded.config.classifier.provider, "typesafe");
			assert.equal(loaded.config.classifier.timeoutMs, 3000);
			assert.equal(loaded.config.preferences, "project preference");
			assert.equal(loaded.config.models.length, 2);

			const sonnet = loaded.config.models.find((m) => m.id === "claude-sonnet-4-5");
			assert.equal(sonnet?.priority, 95);
			assert.equal(sonnet?.specialty, "project core");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("能够拦截非法 JSON、越界参数与重复模型键并给出告警", () => {
		const root = makeTempDir("pi-fusion-invalid-");
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "workspace");
			mkdirSync(agentDir, { recursive: true });

			writeFileSync(getGlobalConfigPath(agentDir), "{ invalid json", "utf8");
			const loaded = loadFusionRouterConfig({ cwd: projectDir, agentDir });
			assert.equal(loaded.warnings.length > 0, true);
			assert.equal(loaded.config.enabled, true);

			const warnings: string[] = [];
			const { config } = mergeAndValidateConfig(
				createDefaultConfig(),
				{
					mode: "unknown_mode",
					classifier: { timeoutMs: 999999, minConfidence: 2.5 },
					models: [
						{ provider: "anthropic", id: "claude-sonnet-4-5", priority: 200, costTier: "invalid_tier" },
						{ provider: "anthropic", id: "claude-sonnet-4-5", priority: 70, costTier: "balanced" },
						{ provider: "", id: "broken" },
					],
				},
				warnings,
			);

			assert.equal(config.mode, "auto");
			assert.equal(config.classifier.timeoutMs, 15000);
			assert.equal(config.classifier.minConfidence, 1);
			assert.equal(config.models.length, 1);
			assert.equal(config.models[0]?.priority, 70);
			assert.equal(warnings.length >= 4, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("能够自动迁移旧版 high / medium / low 三档配置", () => {
		const { patch, migratedFrom } = migrateLegacyConfig({
			models: {
				high: "anthropic/claude-opus-4-5",
				medium: { provider: "openai", id: "gpt-5", specialty: "general" },
				low: { model: "google/gemini-2.5-flash" },
			},
			fallbackOrder: ["openai/gpt-5", "google/gemini-2.5-flash"],
		});

		assert.equal(migratedFrom, "legacy-3-tier-models");
		assert.equal(patch.models?.length, 3);
		assert.equal(patch.models?.[0]?.costTier, "premium");
		assert.equal(patch.models?.[1]?.specialty, "general");
		assert.equal(patch.models?.[2]?.id, "gemini-2.5-flash");
		assert.deepEqual(patch.fallbackChain, ["openai/gpt-5", "google/gemini-2.5-flash"]);
	});

	it("支持原子写入与读取配置且正确拆分含斜杠的模型 ID", () => {
		const root = makeTempDir("pi-fusion-save-");
		try {
			const parsed = parseModelKey("openrouter/anthropic/claude-sonnet-4.5");
			assert.deepEqual(parsed, { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" });

			const cfg = createDefaultConfig();
			cfg.preferences = "Prefer fast responses for small edits";
			const savedPath = saveFusionRouterConfig(cfg, { scope: "project", cwd: root });
			const reloaded = loadFusionRouterConfig({ cwd: root, agentDir: join(root, "unused-agent") });
			assert.equal(savedPath, getProjectConfigPath(root));
			assert.equal(reloaded.config.preferences, "Prefer fast responses for small edits");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
