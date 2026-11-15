import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import {
	buildCandidatePool,
	estimateUsedTokensFromMessages,
	pickDefaultOrFallbackCandidate,
	pickDirectCandidate,
} from "./catalog.ts";
import {
	buildClassifierContext,
	buildClassifierInputSummary,
	type ClassifierLookupRegistry,
	type ClassifierRunnerRegistry,
	resolveClassifierChain,
	runClassifierDecision,
} from "./classifier.ts";
import { modelKey, parseModelKey } from "./config.ts";
import { resolveThinkingLevel } from "./effort.ts";
import type { ModelHealthTracker } from "./health.ts";
import {
	countTrailingToolErrors,
	countTurnAssistantSteps,
	evaluateContinuationPolicy,
	evaluateSwitchBenefitGate,
	extractCurrentTaskSummary,
	hasActiveThinkingSignature,
	hasCompletedUserTaskShiftSignal,
} from "./policy.ts";
import type {
	CandidatePoolSnapshot,
	ClassifierDecision,
	FusionRouteState,
	FusionRouterConfig,
	ResolvedCandidate,
	RouteTrigger,
} from "./types.ts";

export {
	countTrailingToolErrors,
	countTurnAssistantSteps,
	evaluateContinuationPolicy,
	evaluateSwitchBenefitGate,
	extractCurrentTaskSummary,
	hasActiveThinkingSignature,
	hasCompletedUserTaskShiftSignal,
};

export interface RouterRegistryView extends ClassifierLookupRegistry, ClassifierRunnerRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAvailable(): Model<Api>[];
	hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface RouteDependencies {
	modelRegistry: RouterRegistryView;
	config: FusionRouterConfig;
	healthTracker: ModelHealthTracker;
	/** 可选：来自 ctx.getContextUsage()?.tokens 的精确上下文已用 Token 数 */
	usedTokens?: number;
	onRouteResolved?: (info: {
		route: ModelRoute<FusionRouteState>;
		state: FusionRouteState;
		stateChanged: boolean;
		switchedFrom?: string;
		trigger: RouteTrigger;
	}) => void;
}

/** 构造状态对象，若关键字段未变化则复用 request.state 引用以避免 Pi 写入冗余条目 */
function finalizeRouteResult(params: {
	request: ModelRouteRequest<FusionRouteState>;
	selectedCandidate: ResolvedCandidate;
	thinkingLevel: ModelThinkingLevel;
	trigger: RouteTrigger;
	reason: string;
	classifierDecision?: ClassifierDecision;
	nextTaskSummary?: string;
	decidedAtTurnStep: number;
	continuationSteps: number;
	consecutiveToolErrors: number;
	attemptedModels: string[];
}): {
	route: ModelRoute<FusionRouteState>;
	state: FusionRouteState;
	stateChanged: boolean;
} {
	const {
		request,
		selectedCandidate,
		thinkingLevel,
		trigger,
		reason,
		classifierDecision,
		nextTaskSummary,
		decidedAtTurnStep,
		continuationSteps,
		consecutiveToolErrors,
		attemptedModels,
	} = params;

	const prevState = request.state;
	const canReusePreviousState =
		prevState !== undefined &&
		classifierDecision === undefined &&
		prevState.selectedModel === selectedCandidate.key &&
		prevState.thinkingLevel === thinkingLevel &&
		prevState.continuationSteps === continuationSteps &&
		prevState.consecutiveToolErrors === consecutiveToolErrors &&
		trigger === "sticky_hold";

	if (canReusePreviousState) {
		return {
			route: {
				model: selectedCandidate.model,
				thinkingLevel,
				state: request.state,
			},
			state: prevState,
			stateChanged: false,
		};
	}

	const nextState: FusionRouteState = {
		version: 1,
		selectedModel: selectedCandidate.key,
		thinkingLevel,
		taskSummary: nextTaskSummary ?? prevState?.taskSummary,
		decidedAtTurnStep,
		continuationSteps,
		consecutiveToolErrors,
		attemptedModels,
		lastDecision: {
			model: selectedCandidate.key,
			thinkingLevel,
			reason,
			trigger,
			classifierModel: classifierDecision?.classifierModelKey,
			recommendedModel: classifierDecision?.selectedModelKey,
			confidence: classifierDecision?.selectedModelConfidence,
			switchBenefit: classifierDecision?.switchBenefit,
			switchBenefitConfidence: classifierDecision?.switchBenefitConfidence,
			latencyMs: classifierDecision?.latencyMs,
			timestamp: Date.now(),
		},
	};

	return {
		route: {
			model: selectedCandidate.model,
			thinkingLevel,
			state: nextState,
		},
		state: nextState,
		stateChanged: true,
	};
}

function findCandidateByKey(
	pool: CandidatePoolSnapshot,
	key: string | undefined,
): ResolvedCandidate | undefined {
	if (!key) return undefined;
	const parsed = parseModelKey(key);
	const normalized = parsed ? modelKey(parsed.provider, parsed.id) : key;
	return pool.contextSafe.find((c) => c.key === normalized)
		?? pool.healthy.find((c) => c.key === normalized);
}

/** 执行一次完整虚拟模型路由决策 */
export async function routeRequest(
	request: ModelRouteRequest<FusionRouteState>,
	deps: RouteDependencies,
): Promise<ModelRoute<FusionRouteState>> {
	const { modelRegistry, config, healthTracker, onRouteResolved } = deps;
	const prevState = request.state;
	const currentModelKey = prevState?.selectedModel
		?? (request.previous ? modelKey(request.previous.model.provider, request.previous.model.id) : undefined);

	const usedTokens =
		typeof deps.usedTokens === "number" && deps.usedTokens > 0
			? deps.usedTokens
			: estimateUsedTokensFromMessages(request.messages);
	const pool = buildCandidatePool({
		modelRegistry,
		config,
		healthTracker,
		usedTokens,
		currentModelKey,
	});

	if (pool.allResolved.length === 0) {
		throw new Error("未找到任何已配置凭据且可用的物理模型，请检查模型与凭据设置");
	}

	const previousModelKey = request.previous
		? modelKey(request.previous.model.provider, request.previous.model.id)
		: undefined;

	// 当路由器被禁用或处于 observe 模式时，直接路由至默认/上一个模型
	if (!config.enabled) {
		const fallback = findCandidateByKey(pool, previousModelKey)
			?? pickDefaultOrFallbackCandidate(pool.contextSafe, config)
			?? pool.allResolved[0]!;
		const thinkingLevel = resolveThinkingLevel({
			physicalModel: fallback.model,
			profile: fallback.profile,
			requestedThinkingLevel: request.thinkingLevel,
			thinkingMode: "passthrough",
		});
		const finalized = finalizeRouteResult({
			request,
			selectedCandidate: fallback,
			thinkingLevel,
			trigger: "disabled",
			reason: "路由器已禁用，使用默认/当前模型",
			decidedAtTurnStep: prevState?.decidedAtTurnStep ?? 0,
			continuationSteps: prevState?.continuationSteps ?? 0,
			consecutiveToolErrors: 0,
			attemptedModels: [fallback.key],
		});
		onRouteResolved?.({ ...finalized, trigger: "disabled" });
		return finalized.route;
	}

	// 1. Agent 循环外 direct 请求（如 Compaction 摘要）不读取/不修改会话状态
	if (request.reason === "direct") {
		const directCandidate = pickDirectCandidate(pool.contextSafe, currentModelKey, config)
			?? pool.allResolved[0]!;
		const preferredDirectThinking = request.thinkingLevel === "off" ? "off" : "low";
		const thinkingLevel = resolveThinkingLevel({
			physicalModel: directCandidate.model,
			profile: directCandidate.profile,
			requestedThinkingLevel: preferredDirectThinking,
			thinkingMode: "passthrough",
		});
		return {
			model: directCandidate.model,
			thinkingLevel,
		};
	}

	// 2. 自动重试分支：上报失败、触发冷却并切换健康备用模型
	if (request.reason === "retry") {
		const failedModel = request.failed?.model;
		const failedKey = failedModel ? modelKey(failedModel.provider, failedModel.id) : currentModelKey;
		const attempted = new Set<string>(prevState?.attemptedModels ?? []);
		if (failedKey) attempted.add(failedKey);

		let failureSummary = "上游请求失败";
		let isContextOverflow = false;
		if (failedKey && request.failed) {
			const reported = healthTracker.reportFailure(
				failedKey,
				request.failed.message.stopReason,
				request.failed.message.errorMessage,
				config.health,
			);
			failureSummary = reported.classification.summary;
			isContextOverflow = reported.classification.category === "context_overflow";
		}

		// 若因上下文超限且 Pi 已执行 compaction 后重试，可优先保持原模型或更大窗口模型
		let nextCandidate: ResolvedCandidate | undefined;
		if (isContextOverflow && failedKey) {
			const same = findCandidateByKey(pool, failedKey);
			if (same) nextCandidate = same;
		}
		if (!nextCandidate && config.health.autoFailover) {
			// 先找未尝试过的健康且上下文安全模型
			nextCandidate = pickDefaultOrFallbackCandidate(pool.contextSafe, config, attempted)
				?? pickDefaultOrFallbackCandidate(pool.healthy, config, attempted);
		}
		if (!nextCandidate) {
			nextCandidate = findCandidateByKey(pool, failedKey)
				?? pickDefaultOrFallbackCandidate(pool.contextSafe, config)
				?? pool.allResolved[0]!;
		}

		const thinkingLevel = resolveThinkingLevel({
			physicalModel: nextCandidate.model,
			profile: nextCandidate.profile,
			requestedThinkingLevel: request.thinkingLevel,
			thinkingMode: config.thinkingMode,
		});

		const trigger: RouteTrigger = nextCandidate.key !== failedKey ? "failover" : "fallback";
		const finalized = finalizeRouteResult({
			request,
			selectedCandidate: nextCandidate,
			thinkingLevel,
			trigger,
			reason: nextCandidate.key !== failedKey
				? `${failedKey ?? "原模型"} ${failureSummary}，故障转移至 ${nextCandidate.key}`
				: `继续重试 ${nextCandidate.key}`,
			decidedAtTurnStep: prevState?.decidedAtTurnStep ?? 0,
			continuationSteps: prevState?.continuationSteps ?? 0,
			consecutiveToolErrors: prevState?.consecutiveToolErrors ?? 0,
			attemptedModels: Array.from(attempted.add(nextCandidate.key)),
		});
		onRouteResolved?.({
			...finalized,
			switchedFrom: failedKey,
			trigger,
		});
		return finalized.route;
	}

	// 3. continuation 分支（工具结果/扩展消息后继续）：默认 Sticky，仅在特定条件触发重决策
	const trailingErrors = countTrailingToolErrors(request);
	const turnAssistantSteps = countTurnAssistantSteps(request);
	const currentCandidate = findCandidateByKey(pool, currentModelKey);
	const currentIsHealthyAndSafe = currentCandidate !== undefined
		&& pool.contextSafe.some((c) => c.key === currentCandidate.key);

	if (request.reason === "continuation") {
		// 若当前模型仍健康且符合上下文窗口，检查 Sticky 策略
		if (currentIsHealthyAndSafe && currentCandidate) {
			const policyEval = evaluateContinuationPolicy({
				request,
				config,
				turnAssistantSteps,
				trailingErrors,
				prevState,
			});

			if (!policyEval.shouldRedecide) {
				const stickyThinking = prevState?.thinkingLevel
					?? request.previous?.thinkingLevel
					?? resolveThinkingLevel({
						physicalModel: currentCandidate.model,
						profile: currentCandidate.profile,
						requestedThinkingLevel: request.thinkingLevel,
						thinkingMode: config.thinkingMode,
					});
				const finalized = finalizeRouteResult({
					request,
					selectedCandidate: currentCandidate,
					thinkingLevel: stickyThinking,
					trigger: "sticky_hold",
					reason: "工具循环中保持当前模型与缓存",
					decidedAtTurnStep: prevState?.decidedAtTurnStep ?? 0,
					continuationSteps: prevState?.continuationSteps ?? 0,
					consecutiveToolErrors: prevState?.consecutiveToolErrors ?? 0,
					attemptedModels: prevState?.attemptedModels ?? [currentCandidate.key],
				});
				onRouteResolved?.({ ...finalized, trigger: "sticky_hold" });
				return finalized.route;
			}

			// 触发重决策（需经过收益置信度门槛验证）
			const triggerReason: RouteTrigger = policyEval.triggerReason;
			const decision = await invokeClassifierForCandidates({
				request,
				pool,
				config,
				modelRegistry,
				turnStepCount: turnAssistantSteps,
				consecutiveToolErrors: trailingErrors,
				currentModelKey: currentCandidate.key,
				currentThinkingLevel: prevState?.thinkingLevel ?? request.previous?.thinkingLevel,
				includeSwitchBenefit: true,
			});

			const gate = decision
				? evaluateSwitchBenefitGate({
						decision,
						currentModelKey: currentCandidate.key,
						isFirstDecision: false,
						currentIsHealthyAndSafe: true,
						minConfidence: config.classifier.minConfidence,
						minSwitchBenefitConfidence: config.redecision.minSwitchBenefitConfidence,
					})
				: undefined;

			const canSwitchByConfidence =
				decision !== undefined
				&& decision.selectedModelKey !== currentCandidate.key
				&& Boolean(gate?.meetsConfidence && gate?.switchAllowed);

			const recommendedCandidate = canSwitchByConfidence
				? findCandidateByKey(pool, decision.selectedModelKey)
				: undefined;

			if (recommendedCandidate && config.mode === "auto") {
				const thinkingLevel = resolveThinkingLevel({
					physicalModel: recommendedCandidate.model,
					profile: recommendedCandidate.profile,
					requestedThinkingLevel: request.thinkingLevel,
					classifierEffortLabel: decision?.effortLabel,
					thinkingMode: config.thinkingMode,
				});
				const finalized = finalizeRouteResult({
					request,
					selectedCandidate: recommendedCandidate,
					thinkingLevel,
					trigger: triggerReason,
					reason: policyEval.errorTriggered
						? `连续 ${trailingErrors} 次工具失败，分类器建议切换至 ${recommendedCandidate.key}`
						: `周期复查切换至 ${recommendedCandidate.key}`,
					classifierDecision: decision,
					decidedAtTurnStep: turnAssistantSteps,
					continuationSteps: turnAssistantSteps,
					consecutiveToolErrors: trailingErrors,
					attemptedModels: [recommendedCandidate.key],
				});
				onRouteResolved?.({
					...finalized,
					switchedFrom: currentCandidate.key,
					trigger: triggerReason,
				});
				return finalized.route;
			}

			// 分类器未建议切换或置信度不足 -> 保持原模型并推进复查基线
			const thinkingLevel = prevState?.thinkingLevel
				?? request.previous?.thinkingLevel
				?? resolveThinkingLevel({
					physicalModel: currentCandidate.model,
					profile: currentCandidate.profile,
					requestedThinkingLevel: request.thinkingLevel,
					thinkingMode: config.thinkingMode,
				});
			const finalized = finalizeRouteResult({
				request,
				selectedCandidate: currentCandidate,
				thinkingLevel,
				trigger: "sticky_hold",
				reason: "重决策评估后保持当前模型",
				classifierDecision: decision,
				decidedAtTurnStep: turnAssistantSteps,
				continuationSteps: turnAssistantSteps,
				consecutiveToolErrors: trailingErrors,
				attemptedModels: prevState?.attemptedModels ?? [currentCandidate.key],
			});
			onRouteResolved?.({ ...finalized, trigger: "sticky_hold" });
			return finalized.route;
		}

		// 当前模型已不可用或超出窗口，主动回退到健康候选
		const replacement = pickDefaultOrFallbackCandidate(pool.contextSafe, config) ?? pool.allResolved[0]!;
		const thinkingLevel = resolveThinkingLevel({
			physicalModel: replacement.model,
			profile: replacement.profile,
			requestedThinkingLevel: request.thinkingLevel,
			thinkingMode: config.thinkingMode,
		});
		const finalized = finalizeRouteResult({
			request,
			selectedCandidate: replacement,
			thinkingLevel,
			trigger: "failover",
			reason: `原模型 ${currentModelKey ?? "未知"} 不可用或窗口不足，切换至 ${replacement.key}`,
			decidedAtTurnStep: turnAssistantSteps,
			continuationSteps: turnAssistantSteps,
			consecutiveToolErrors: trailingErrors,
			attemptedModels: [replacement.key],
		});
		onRouteResolved?.({
			...finalized,
			switchedFrom: currentModelKey,
			trigger: "failover",
		});
		return finalized.route;
	}

	// 4. user 分支（新用户提示 / steering / followUp）
	const taskSummary = extractCurrentTaskSummary(request);
	const isFirstDecision = prevState === undefined && request.previous === undefined;

	// 当配置关闭了新消息重决策、且当前模型仍可用时，保持现有模型避免破坏缓存
	if (!isFirstDecision && !config.redecision.redecideOnTaskShift && currentIsHealthyAndSafe && currentCandidate) {
		const stickyThinking = prevState?.thinkingLevel
			?? request.previous?.thinkingLevel
			?? resolveThinkingLevel({
				physicalModel: currentCandidate.model,
				profile: currentCandidate.profile,
				requestedThinkingLevel: request.thinkingLevel,
				thinkingMode: config.thinkingMode,
			});
		const finalized = finalizeRouteResult({
			request,
			selectedCandidate: currentCandidate,
			thinkingLevel: stickyThinking,
			trigger: "sticky_hold",
			reason: "保持当前会话模型",
			decidedAtTurnStep: 0,
			continuationSteps: 0,
			consecutiveToolErrors: 0,
			attemptedModels: [currentCandidate.key],
		});
		onRouteResolved?.({ ...finalized, trigger: "sticky_hold" });
		return finalized.route;
	}

	// 调用 Classifier 做全局最优模型决策
	const decision = await invokeClassifierForCandidates({
		request,
		pool,
		config,
		modelRegistry,
		turnStepCount: 0,
		consecutiveToolErrors: 0,
		currentModelKey,
		currentThinkingLevel: prevState?.thinkingLevel ?? request.previous?.thinkingLevel,
		includeSwitchBenefit: !isFirstDecision && currentIsHealthyAndSafe,
	});

	let chosenCandidate: ResolvedCandidate | undefined;
	let chosenTrigger: RouteTrigger = isFirstDecision ? "user_initial" : "user_redecide";
	let reason = "";

	if (decision) {
		const matched = findCandidateByKey(pool, decision.selectedModelKey);
		const gate = evaluateSwitchBenefitGate({
			decision,
			currentModelKey,
			isFirstDecision,
			currentIsHealthyAndSafe,
			minConfidence: config.classifier.minConfidence,
			minSwitchBenefitConfidence: config.redecision.minSwitchBenefitConfidence,
		});

		if (matched && gate.meetsConfidence && gate.switchAllowed) {
			chosenCandidate = matched;
			reason = `Classifier (${decision.classifierModelKey}) 推荐 ${matched.key} (置信度 ${Math.round(decision.selectedModelConfidence * 100)}%)`;
		} else if (currentIsHealthyAndSafe && currentCandidate) {
			chosenCandidate = currentCandidate;
			chosenTrigger = "sticky_hold";
			reason = "分类器置信度或切换收益未达阈值，保持当前模型";
		}
	}

	// observe 模式：记录分类器推荐结果，但实际派发默认模型（或当前健康模型）
	if (config.mode === "observe") {
		const observeTarget = (currentIsHealthyAndSafe ? currentCandidate : undefined)
			?? pickDefaultOrFallbackCandidate(pool.contextSafe, config)
			?? pool.allResolved[0]!;
		const thinkingLevel = resolveThinkingLevel({
			physicalModel: observeTarget.model,
			profile: observeTarget.profile,
			requestedThinkingLevel: request.thinkingLevel,
			classifierEffortLabel: decision?.effortLabel,
			thinkingMode: config.thinkingMode,
		});
		const finalized = finalizeRouteResult({
			request,
			selectedCandidate: observeTarget,
			thinkingLevel,
			trigger: "observe",
			reason: decision
				? `观察模式：分类器推荐 ${decision.selectedModelKey}，实际派发 ${observeTarget.key}`
				: `观察模式：使用默认模型 ${observeTarget.key}`,
			classifierDecision: decision,
			nextTaskSummary: taskSummary,
			decidedAtTurnStep: 0,
			continuationSteps: 0,
			consecutiveToolErrors: 0,
			attemptedModels: [observeTarget.key],
		});
		onRouteResolved?.({ ...finalized, trigger: "observe" });
		return finalized.route;
	}

	if (!chosenCandidate) {
		chosenCandidate = (currentIsHealthyAndSafe ? currentCandidate : undefined)
			?? pickDefaultOrFallbackCandidate(pool.contextSafe, config)
			?? pool.allResolved[0]!;
		chosenTrigger = decision ? chosenTrigger : "fallback";
		reason = decision
			? `回退至 ${chosenCandidate.key}`
			: `分类器不可用或超时，回退至 ${chosenCandidate.key}`;
	}

	const thinkingLevel = resolveThinkingLevel({
		physicalModel: chosenCandidate.model,
		profile: chosenCandidate.profile,
		requestedThinkingLevel: request.thinkingLevel,
		classifierEffortLabel: decision?.effortLabel,
		thinkingMode: config.thinkingMode,
	});

	const finalized = finalizeRouteResult({
		request,
		selectedCandidate: chosenCandidate,
		thinkingLevel,
		trigger: chosenTrigger,
		reason,
		classifierDecision: decision,
		nextTaskSummary: taskSummary,
		decidedAtTurnStep: 0,
		continuationSteps: 0,
		consecutiveToolErrors: 0,
		attemptedModels: [chosenCandidate.key],
	});

	onRouteResolved?.({
		...finalized,
		switchedFrom: currentModelKey && currentModelKey !== chosenCandidate.key ? currentModelKey : undefined,
		trigger: chosenTrigger,
	});
	return finalized.route;
}

async function invokeClassifierForCandidates(params: {
	request: ModelRouteRequest<FusionRouteState>;
	pool: CandidatePoolSnapshot;
	config: FusionRouterConfig;
	modelRegistry: RouteDependencies["modelRegistry"];
	turnStepCount: number;
	consecutiveToolErrors: number;
	currentModelKey?: string;
	currentThinkingLevel?: ModelThinkingLevel;
	includeSwitchBenefit: boolean;
}): Promise<ClassifierDecision | undefined> {
	const {
		request,
		pool,
		config,
		modelRegistry,
		turnStepCount,
		consecutiveToolErrors,
		currentModelKey,
		currentThinkingLevel,
		includeSwitchBenefit,
	} = params;

	// 仅 1 个候选模型时无需浪费一次分类器网络往返
	if (pool.forDecision.length <= 1) return undefined;

	const classifiers = await resolveClassifierChain(modelRegistry, config.classifier);
	if (classifiers.length === 0) return undefined;

	const summary = buildClassifierInputSummary({
		messages: request.messages,
		turnStepCount,
		consecutiveToolErrors,
		currentModelKey,
		currentThinkingLevel,
	});

	const context = buildClassifierContext({
		summary,
		candidates: pool.forDecision,
		efforts: config.efforts,
		preferences: config.preferences,
		includeSwitchBenefit,
	});

	return runClassifierDecision({
		modelRegistry,
		classifiers,
		context,
		timeoutMs: config.classifier.timeoutMs,
		signal: request.signal,
	});
}
