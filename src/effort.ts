import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { CandidateModelProfile, ThinkingSelectionMode } from "./types.ts";

const THINKING_ORDER: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * 将目标 ThinkingLevel 安全 Clamp 到物理模型实际支持的档位：
 * - 非推理模型强制返回 "off"
 * - 过高档位（如 xhigh / max）优先向下就近降级（xhigh -> high）
 * - 过低档位（如 minimal）优先向上就近适配（minimal -> low）
 */
export function clampToSupportedThinkingLevel(
	model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">,
	requested: ModelThinkingLevel,
): ModelThinkingLevel {
	if (!model.reasoning) return "off";

	const supported = getSupportedThinkingLevels(model as Model<Api>);
	if (supported.length === 0) return "off";
	if (supported.includes(requested)) return requested;

	const idx = THINKING_ORDER.indexOf(requested);
	if (idx === -1) return supported[0] ?? "off";

	// 对于 high/xhigh/max，优先向下查找最接近的支持档位
	if (requested === "high" || requested === "xhigh" || requested === "max") {
		for (let i = idx - 1; i >= 0; i--) {
			const candidate = THINKING_ORDER[i];
			if (candidate && supported.includes(candidate)) return candidate;
		}
		for (let i = idx + 1; i < THINKING_ORDER.length; i++) {
			const candidate = THINKING_ORDER[i];
			if (candidate && supported.includes(candidate)) return candidate;
		}
		return supported[0] ?? "off";
	}

	// 对于 off/minimal/low/medium，优先向上查找最接近的支持档位，再向下回退
	for (let i = idx + 1; i < THINKING_ORDER.length; i++) {
		const candidate = THINKING_ORDER[i];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	for (let i = idx - 1; i >= 0; i--) {
		const candidate = THINKING_ORDER[i];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	return supported[0] ?? "off";
}

/** 判断某个字符串是否为合法的 ModelThinkingLevel */
export function isValidThinkingLevel(value: string | undefined): value is ModelThinkingLevel {
	return value !== undefined && THINKING_ORDER.includes(value as ModelThinkingLevel);
}

/** 综合思考模式、用户虚拟档位、模型画像映射与物理能力，解析最终 ThinkingLevel */
export function resolveThinkingLevel(params: {
	physicalModel: Pick<Model<Api>, "reasoning" | "thinkingLevelMap">;
	profile?: CandidateModelProfile;
	requestedThinkingLevel: ModelThinkingLevel;
	classifierEffortLabel?: string;
	thinkingMode: ThinkingSelectionMode;
}): ModelThinkingLevel {
	const {
		physicalModel,
		profile,
		requestedThinkingLevel,
		classifierEffortLabel,
		thinkingMode,
	} = params;

	let desired: ModelThinkingLevel;

	if (thinkingMode === "passthrough") {
		desired = requestedThinkingLevel;
	} else if (thinkingMode === "profile-default") {
		desired = profile?.defaultThinking ?? requestedThinkingLevel;
	} else {
		// auto 模式：若用户在 UI 显式关闭推理（"off"），尊重用户意愿
		if (requestedThinkingLevel === "off") {
			desired = "off";
		} else if (classifierEffortLabel) {
			const mapped = profile?.effortMap?.[classifierEffortLabel];
			if (mapped) {
				desired = mapped;
			} else if (isValidThinkingLevel(classifierEffortLabel)) {
				desired = classifierEffortLabel;
			} else {
				desired = profile?.defaultThinking ?? requestedThinkingLevel;
			}
		} else {
			desired = profile?.defaultThinking ?? requestedThinkingLevel;
		}
	}

	return clampToSupportedThinkingLevel(physicalModel, desired);
}
