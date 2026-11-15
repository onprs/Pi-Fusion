import { FAILURE_PATTERNS, HEALTH_DEBOUNCE_MS } from "./constants.ts";
import type { FailureCategory, HealthConfig, ModelHealthSnapshot } from "./types.ts";

interface ModelHealthRecord {
	consecutiveFailures: number;
	lastFailureAt: number;
	cooldownUntil: number;
	lastCategory?: FailureCategory;
	lastSummary?: string;
}

export interface FailureClassification {
	category: FailureCategory;
	shouldCooldown: boolean;
	shouldFailover: boolean;
	summary: string;
}

/** 对错误消息进行安全脱敏与归类 */
export function classifyModelFailure(
	stopReason?: string,
	errorMessage?: string,
): FailureClassification {
	const raw = (errorMessage ?? "").trim();
	const normalizedReason = (stopReason ?? "").trim().toLowerCase();

	if (normalizedReason === "aborted" || FAILURE_PATTERNS.aborted.test(raw)) {
		return {
			category: "aborted",
			shouldCooldown: false,
			shouldFailover: false,
			summary: "请求已取消",
		};
	}

	if (FAILURE_PATTERNS.contextOverflow.test(raw)) {
		return {
			category: "context_overflow",
			shouldCooldown: false,
			shouldFailover: false,
			summary: "上下文长度超限",
		};
	}

	if (FAILURE_PATTERNS.auth.test(raw)) {
		return {
			category: "auth",
			shouldCooldown: true,
			shouldFailover: true,
			summary: "认证或权限异常 (401/403)",
		};
	}

	if (FAILURE_PATTERNS.missing.test(raw)) {
		return {
			category: "missing",
			shouldCooldown: true,
			shouldFailover: true,
			summary: "模型不可用或不存在 (404)",
		};
	}

	if (FAILURE_PATTERNS.rateLimit.test(raw)) {
		return {
			category: "rate_limit",
			shouldCooldown: true,
			shouldFailover: true,
			summary: "请求限流或配额不足 (429)",
		};
	}

	if (FAILURE_PATTERNS.parameter.test(raw)) {
		return {
			category: "parameter",
			shouldCooldown: true,
			shouldFailover: true,
			summary: "请求参数不兼容 (400/422)",
		};
	}

	if (FAILURE_PATTERNS.timeout.test(raw)) {
		return {
			category: "timeout",
			shouldCooldown: true,
			shouldFailover: true,
			summary: "上游响应超时",
		};
	}

	if (FAILURE_PATTERNS.network.test(raw)) {
		return {
			category: "network",
			shouldCooldown: true,
			shouldFailover: true,
			summary: "网络连接异常",
		};
	}

	if (FAILURE_PATTERNS.unavailable.test(raw)) {
		return {
			category: "unavailable",
			shouldCooldown: true,
			shouldFailover: true,
			summary: "上游服务暂不可用 (5xx)",
		};
	}

	if (normalizedReason === "error") {
		return {
			category: "unknown",
			shouldCooldown: true,
			shouldFailover: true,
			summary: "未知模型响应异常",
		};
	}

	return {
		category: "unknown",
		shouldCooldown: false,
		shouldFailover: false,
		summary: "正常",
	};
}

/**
 * 模型健康管理器：负责故障冷却、1500ms 防抖、指数退避与成功恢复
 */
export class ModelHealthTracker {
	private readonly records = new Map<string, ModelHealthRecord>();
	private readonly nowFn: () => number;

	constructor(nowFn: () => number = () => Date.now()) {
		this.nowFn = nowFn;
	}

	/** 记录模型失败，返回归类结果及是否新触发冷却 */
	reportFailure(
		key: string,
		stopReason: string | undefined,
		errorMessage: string | undefined,
		policy: HealthConfig,
	): { classification: FailureClassification; recorded: boolean } {
		const classification = classifyModelFailure(stopReason, errorMessage);
		if (!policy.enabled || !classification.shouldCooldown) {
			return { classification, recorded: false };
		}

		const now = this.nowFn();
		const existing = this.records.get(key);

		// 1500ms 防抖窗口内同类型错误只计数一次
		if (
			existing &&
			existing.lastCategory === classification.category &&
			now - existing.lastFailureAt < HEALTH_DEBOUNCE_MS
		) {
			return { classification, recorded: false };
		}

		const consecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
		const cooldownSeconds =
			classification.category === "auth" || classification.category === "missing"
				? policy.maxCooldownSeconds
				: Math.min(
						policy.maxCooldownSeconds,
						policy.cooldownSeconds * 2 ** Math.min(consecutiveFailures - 1, 8),
					);

		this.records.set(key, {
			consecutiveFailures,
			lastFailureAt: now,
			cooldownUntil: now + cooldownSeconds * 1000,
			lastCategory: classification.category,
			lastSummary: classification.summary,
		});

		return { classification, recorded: true };
	}

	/** 记录模型成功响应，立即恢复健康并清零连续失败计数 */
	reportSuccess(key: string): void {
		this.records.delete(key);
	}

	/** 判断模型当前是否可用（未处于主动冷却期） */
	isAvailable(key: string, policy?: HealthConfig): boolean {
		if (policy && !policy.enabled) return true;
		const record = this.records.get(key);
		if (!record) return true;
		return this.nowFn() >= record.cooldownUntil;
	}

	/** 获取单个模型的健康状态快照 */
	getSnapshot(key: string, policy?: HealthConfig): ModelHealthSnapshot {
		if (policy && !policy.enabled) {
			return {
				key,
				status: "healthy",
				consecutiveFailures: 0,
				remainingCooldownMs: 0,
			};
		}
		const record = this.records.get(key);
		if (!record) {
			return {
				key,
				status: "healthy",
				consecutiveFailures: 0,
				remainingCooldownMs: 0,
			};
		}
		const now = this.nowFn();
		const remainingCooldownMs = Math.max(0, record.cooldownUntil - now);
		return {
			key,
			status: remainingCooldownMs > 0 ? "cooldown" : "ready_to_retry",
			consecutiveFailures: record.consecutiveFailures,
			lastFailureAt: record.lastFailureAt,
			cooldownUntil: record.cooldownUntil,
			remainingCooldownMs,
			lastCategory: record.lastCategory,
			lastSummary: record.lastSummary,
		};
	}

	/** 获取所有已追踪模型的健康快照 */
	listSnapshots(keys?: string[], policy?: HealthConfig): ModelHealthSnapshot[] {
		const targetKeys = keys
			? Array.from(new Set([...keys, ...this.records.keys()]))
			: Array.from(this.records.keys());
		return targetKeys.map((k) => this.getSnapshot(k, policy));
	}

	/** 手动重置单个或全部模型的健康冷却状态 */
	reset(key?: string): void {
		if (key) {
			this.records.delete(key);
		} else {
			this.records.clear();
		}
	}
}
