import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	getSelectPageIndex,
	matchesKey,
	truncateToWidth,
	type TuiMouseEvent,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { parseModelKey } from "./config.ts";
import { STATUS_BAR_KEY } from "./constants.ts";
import type { FusionRouteState, FusionRouterConfig, PartialFusionRouterConfig, RouteTrigger } from "./types.ts";

/** 更新状态栏中的路由器状态 */
export function updateRouterStatusBar(
	ctx: Pick<ExtensionContext, "hasUI" | "ui" | "model">,
	config: FusionRouterConfig,
	state?: FusionRouteState,
): void {
	if (!ctx.hasUI) return;
	if (!config.ui.showStatusBar) {
		ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
		return;
	}

	const selectedIsFusion =
		ctx.model?.provider === config.virtualModel.provider &&
		ctx.model?.id === config.virtualModel.id;

	if (!selectedIsFusion) {
		ctx.ui.setStatus(STATUS_BAR_KEY, undefined);
		return;
	}

	const theme = ctx.ui.theme;
	if (!config.enabled) {
		ctx.ui.setStatus(STATUS_BAR_KEY, theme.fg("dim", "Fusion: 已停用"));
		return;
	}

	if (!state) {
		const modeLabel = config.mode === "observe" ? " [观察]" : "";
		ctx.ui.setStatus(STATUS_BAR_KEY, theme.fg("dim", `Fusion${modeLabel}: 就绪`));
		return;
	}

	const modePrefix = config.mode === "observe" ? "Fusion [观察]" : "Fusion";
	const modelLabel = parseModelKey(state.selectedModel)?.id ?? state.selectedModel;
	const summary = `${modePrefix}: ${modelLabel} • ${state.thinkingLevel}`;
	if (state.lastDecision.trigger === "failover") {
		ctx.ui.setStatus(STATUS_BAR_KEY, theme.fg("warning", `${summary} [故障转移]`));
		return;
	}
	const stickyMark = state.lastDecision.trigger === "sticky_hold" ? " (保持)" : "";
	ctx.ui.setStatus(STATUS_BAR_KEY, theme.fg("accent", `${summary}${stickyMark}`));
}

/** 根据配置决定是否弹出切换或故障转移通知 */
export function notifyRouteTransition(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	config: FusionRouterConfig,
	info: {
		selectedModel: string;
		thinkingLevel: string;
		switchedFrom?: string;
		trigger: RouteTrigger;
		reason: string;
	},
): void {
	if (!ctx.hasUI) return;

	if (info.trigger === "failover" && config.ui.notifyOnFailover) {
		const fromText = info.switchedFrom ? `${info.switchedFrom} → ` : "";
		ctx.ui.notify(
			`模型故障转移：${fromText}${info.selectedModel} (${info.thinkingLevel})`,
			"warning",
		);
		return;
	}

	if (info.switchedFrom && config.ui.notifyOnSwitch) {
		ctx.ui.notify(
			`模型已切换：${info.switchedFrom} → ${info.selectedModel} (${info.thinkingLevel})`,
			"info",
		);
	}
}

// ───────────────────────── 固定高度双栏工作台组件 ─────────────────────────

/** 双栏自适应列宽阈值：达到该宽度使用左右分栏，以下退化为固定高度上下布局 */
const SPLIT_LAYOUT_MIN_WIDTH = 72;
/** 宽屏主体固定行数（左栏列表与右栏详情共同严格锁定该高度） */
const DEFAULT_SPLIT_BODY_ROWS = 10;
/** 窄屏列表区与详情区固定行数，避免移动光标或切换分区时界面跳动 */
const NARROW_LIST_ROWS = 7;
const NARROW_DETAIL_ROWS = 5;

export type DetailTone = "accent" | "success" | "warning" | "error" | "text" | "muted" | "dim";

export interface SummarySegment {
	label: string;
	value: string;
	tone?: DetailTone;
}

export type DetailEntry =
	| { kind: "kv"; key: string; value: string; tone?: DetailTone }
	| { kind: "text"; text: string; tone?: DetailTone }
	| { kind: "heading"; text: string }
	| { kind: "bullet"; label: string; value?: string; tone?: DetailTone }
	| { kind: "hint"; text: string }
	| { kind: "spacer" };

export interface WorkspaceItem {
	id: string;
	label: string;
	/** 左栏右侧对齐显示的当前值或简短状态 */
	value?: string;
	/** 左栏右侧值的语义色调 */
	valueTone?: DetailTone;
	/** 光标选中该项时右栏显示的标题 */
	detailTitle?: string;
	/** 结构化右栏详情条目（优先于 detailLines） */
	detailEntries?: DetailEntry[];
	/** 纯文本右栏详情行（兼容简单场景） */
	detailLines?: string[];
	/** 是否允许按空格键触发（适合布尔与枚举切换项） */
	allowSpace?: boolean;
	/** 激活回调；返回 "close" 时关闭当前工作台 */
	onActivate?: (spacePressed: boolean) => void | "close" | Promise<void | "close">;
}

export interface WorkspaceSection {
	id: string;
	title: string;
	items: WorkspaceItem[];
	/** 该分区默认的右栏标题 */
	detailTitle?: string;
	/** 该分区默认的结构化右栏详情 */
	detailEntries?: DetailEntry[];
	/** 该分区默认的纯文本右栏详情 */
	detailLines?: string[];
}

export interface WorkspaceViewSpec {
	title: string;
	/** 顶栏标题行右侧对齐显示的状态徽章 */
	headerBadge?: { text: string; tone?: DetailTone };
	/** 顶栏标题行右侧纯文本摘要（向后兼容） */
	headerRight?: string;
	/** 顶栏固定单行关键指标条（永不折行） */
	summarySegments?: SummarySegment[];
	/** 宽屏主体固定行数（默认 10 行） */
	bodyRows?: number;
	sections: WorkspaceSection[];
}

interface ThemeLike {
	fg: (color: DetailTone, text: string) => string;
	bold: (text: string) => string;
}

function applyTone(theme: ThemeLike, tone: DetailTone | undefined, text: string): string {
	if (!tone || tone === "text") return theme.fg("text", text);
	return theme.fg(tone, text);
}

function padRightVisible(text: string, targetWidth: number): string {
	const clipped = visibleWidth(text) > targetWidth ? truncateToWidth(text, targetWidth, "…") : text;
	const pad = Math.max(0, targetWidth - visibleWidth(clipped));
	return clipped + " ".repeat(pad);
}

/** 将结构化详情条目转换为纯文本，用于非 TUI 回退展示 */
export function formatDetailEntriesPlain(entries: readonly DetailEntry[]): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		switch (entry.kind) {
			case "kv":
				lines.push(`${entry.key}: ${entry.value}`);
				break;
			case "text":
				lines.push(entry.text);
				break;
			case "heading":
				lines.push(entry.text);
				break;
			case "bullet":
				lines.push(entry.value ? `- ${entry.label} (${entry.value})` : `- ${entry.label}`);
				break;
			case "hint":
				break;
			case "spacer":
				if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
				break;
		}
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function renderSummaryLine(segments: readonly SummarySegment[], safeWidth: number, theme: ThemeLike): string {
	const sep = theme.fg("dim", "  │  ");
	const parts = segments.map((seg) => {
		const k = theme.fg("dim", `${seg.label} `);
		const v = applyTone(theme, seg.tone ?? "text", seg.value);
		return `${k}${v}`;
	});
	return truncateToWidth(` ${parts.join(sep)}`, safeWidth, "…");
}

function renderLeftItemRow(
	item: WorkspaceItem,
	isSelected: boolean,
	colWidth: number,
	theme: ThemeLike,
): string {
	const prefix = isSelected ? theme.fg("accent", "▸ ") : "  ";
	const innerWidth = Math.max(4, colWidth - 2);

	if (!item.value) {
		const rawLabel = truncateToWidth(item.label, innerWidth, "…");
		const styled = isSelected ? theme.fg("accent", theme.bold(rawLabel)) : theme.fg("text", rawLabel);
		return padRightVisible(prefix + styled, colWidth);
	}

	const minGap = 2;
	const valueBudget = Math.max(6, Math.floor(innerWidth * 0.44));
	const clippedValue = truncateToWidth(item.value, valueBudget, "…");
	const clippedValueW = visibleWidth(clippedValue);
	const labelBudget = Math.max(6, innerWidth - clippedValueW - minGap);
	const labelPart = truncateToWidth(item.label, labelBudget, "…");
	const labelW = visibleWidth(labelPart);
	const remainingForValue = Math.max(0, innerWidth - labelW - minGap);
	const valuePart = remainingForValue > 0 ? truncateToWidth(item.value, remainingForValue, "…") : "";
	const valueW = visibleWidth(valuePart);
	const gapSpaces = " ".repeat(Math.max(1, innerWidth - labelW - valueW));

	const styledLabel = isSelected ? theme.fg("accent", theme.bold(labelPart)) : theme.fg("text", labelPart);
	const valueTone = item.valueTone ?? "muted";
	const styledValue = isSelected
		? valueTone === "warning" || valueTone === "error" || valueTone === "success"
			? theme.bold(applyTone(theme, valueTone, valuePart))
			: theme.fg("accent", valuePart)
		: applyTone(theme, valueTone, valuePart);
	return padRightVisible(`${prefix}${styledLabel}${gapSpaces}${styledValue}`, colWidth);
}

function renderDetailColumn(
	title: string | undefined,
	entries: readonly DetailEntry[] | undefined,
	fallbackLines: readonly string[] | undefined,
	colWidth: number,
	maxRows: number,
	theme: ThemeLike,
): string[] {
	const safeWidth = Math.max(12, colWidth);
	const body: string[] = [];

	if (entries && entries.length > 0) {
		const kvKeys = entries.filter((e): e is Extract<DetailEntry, { kind: "kv" }> => e.kind === "kv");
		const maxKeyW = kvKeys.reduce((acc, e) => Math.max(acc, visibleWidth(e.key)), 0);
		const keyColW = Math.min(12, maxKeyW);

		for (const entry of entries) {
			switch (entry.kind) {
				case "spacer":
					if (body.length > 0 && body[body.length - 1] !== "") body.push("");
					break;
				case "heading":
					body.push(truncateToWidth(theme.fg("muted", theme.bold(entry.text)), safeWidth, "…"));
					break;
				case "hint":
					body.push(truncateToWidth(theme.fg("dim", entry.text), safeWidth, "…"));
					break;
				case "text": {
					for (const sub of entry.text.split("\n")) {
						if (!sub.trim()) {
							body.push("");
							continue;
						}
						for (const wrapped of wrapTextWithAnsi(applyTone(theme, entry.tone ?? "muted", sub), safeWidth)) {
							body.push(truncateToWidth(wrapped, safeWidth, "…"));
						}
					}
					break;
				}
				case "kv": {
					const clippedKey = truncateToWidth(entry.key, keyColW, "…");
					const keyPad = " ".repeat(Math.max(0, keyColW - visibleWidth(clippedKey)));
					const prefixText = `${theme.fg("dim", clippedKey)}${keyPad}  `;
					const valWidth = Math.max(8, safeWidth - keyColW - 2);
					const wrappedVals = wrapTextWithAnsi(applyTone(theme, entry.tone ?? "text", entry.value), valWidth);
					const indent = " ".repeat(keyColW + 2);
					wrappedVals.forEach((wLine, idx) => {
						const line = idx === 0 ? `${prefixText}${wLine}` : `${indent}${wLine}`;
						body.push(truncateToWidth(line, safeWidth, "…"));
					});
					break;
				}
				case "bullet": {
					const dot = theme.fg("dim", "• ");
					const innerW = Math.max(8, safeWidth - 2);
					if (!entry.value) {
						body.push(truncateToWidth(`${dot}${applyTone(theme, entry.tone ?? "text", entry.label)}`, safeWidth, "…"));
					} else {
						const valBudget = Math.max(6, Math.floor(innerW * 0.45));
						const valPart = truncateToWidth(entry.value, valBudget, "…");
						const labelBudget = Math.max(6, innerW - visibleWidth(valPart) - 2);
						const labelPart = truncateToWidth(entry.label, labelBudget, "…");
						const gap = " ".repeat(Math.max(1, innerW - visibleWidth(labelPart) - visibleWidth(valPart)));
						body.push(
							truncateToWidth(
								`${dot}${theme.fg("text", labelPart)}${gap}${applyTone(theme, entry.tone ?? "muted", valPart)}`,
								safeWidth,
								"…",
							),
						);
					}
					break;
				}
			}
		}
	} else if (fallbackLines && fallbackLines.length > 0) {
		for (const raw of fallbackLines) {
			for (const sub of raw.split("\n")) {
				if (!sub.trim()) {
					body.push("");
					continue;
				}
				for (const wLine of wrapTextWithAnsi(theme.fg("muted", sub), safeWidth)) {
					body.push(truncateToWidth(wLine, safeWidth, "…"));
				}
			}
		}
	}

	while (body.length > 0 && body[body.length - 1] === "") body.pop();

	const out: string[] = [];
	if (title) {
		out.push(truncateToWidth(theme.fg("accent", theme.bold(title)), safeWidth, "…"));
		if (body.length > 0 && body.length <= maxRows - 2) {
			out.push("");
		}
	}
	out.push(...body);

	if (out.length > maxRows) {
		const omitted = out.length - (maxRows - 1);
		return [
			...out.slice(0, maxRows - 1),
			truncateToWidth(theme.fg("dim", `… 其余 ${omitted} 行`), safeWidth, "…"),
		];
	}

	// 补齐空行以保证详情区高度恒定
	while (out.length < maxRows) out.push("");
	return out;
}

function renderTabBar(
	sections: readonly WorkspaceSection[],
	activeIndex: number,
	safeWidth: number,
	theme: ThemeLike,
): { line: string; hitRanges: Array<{ startCol: number; endCol: number; index: number }> } {
	const build = (compact: boolean) => {
		const hitRanges: Array<{ startCol: number; endCol: number; index: number }> = [];
		let line = " ";
		let colCursor = 1;
		let allFit = true;

		for (let i = 0; i < sections.length; i++) {
			const s = sections[i]!;
			const isActive = i === activeIndex;
			const rawTab = compact
				? isActive
					? `▸${i + 1}${s.title}`
					: `${i + 1}${s.title}`
				: isActive
					? `▸ ${i + 1} ${s.title}`
					: `  ${i + 1} ${s.title}`;
			const sepRaw = compact ? " │ " : "  │  ";
			const tabW = visibleWidth(rawTab);
			if (colCursor + tabW > safeWidth - 1) {
				allFit = false;
				break;
			}
			hitRanges.push({ startCol: colCursor, endCol: colCursor + tabW, index: i });
			line += isActive ? theme.fg("accent", theme.bold(rawTab)) : theme.fg("muted", rawTab);
			colCursor += tabW;
			if (i < sections.length - 1 && colCursor + visibleWidth(sepRaw) < safeWidth) {
				line += theme.fg("dim", sepRaw);
				colCursor += visibleWidth(sepRaw);
			}
		}
		return { line: truncateToWidth(line, safeWidth, "…"), hitRanges, allFit };
	};

	const spacious = build(false);
	if (spacious.allFit) return { line: spacious.line, hitRanges: spacious.hitRanges };
	const compact = build(true);
	return { line: compact.line, hitRanges: compact.hitRanges };
}

/**
 * 打开固定高度的横向分区双栏工作台：
 * - TUI 模式下：所有面板区域（顶栏、标签栏、列表区、详情区、底栏）均保持固定行数，切页与移动光标零跳动
 * - 非 TUI 交互模式下：自动回退至 ctx.ui.select 分区与操作列表
 */
export async function openTabbedSplitWorkspace(
	ctx: ExtensionContext,
	buildSpec: () => WorkspaceViewSpec,
	options?: {
		initialSectionId?: string;
		initialItemId?: string;
	},
): Promise<void> {
	if (!ctx.hasUI) return;

	const canUseCustomTui = ctx.mode === "tui" && typeof ctx.ui.custom === "function";
	if (!canUseCustomTui) {
		let currentSectionIdx = 0;
		const firstSpec = buildSpec();
		if (options?.initialSectionId) {
			const idx = firstSpec.sections.findIndex((s) => s.id === options.initialSectionId);
			if (idx >= 0) currentSectionIdx = idx;
		}

		const formatSummaryPlain = (spec: WorkspaceViewSpec): string | undefined => {
			if (!spec.summarySegments || spec.summarySegments.length === 0) return undefined;
			return spec.summarySegments.map((s) => `${s.label}: ${s.value}`).join(" | ");
		};

		const extractDetailPlain = (
			entries: readonly DetailEntry[] | undefined,
			lines: readonly string[] | undefined,
		): string[] => {
			if (entries && entries.length > 0) return formatDetailEntriesPlain(entries);
			return lines ? [...lines] : [];
		};

		// 单分区时直接展示该分区的项目列表；多分区时支持在分区列表与分区内操作列表之间切换
		if (firstSpec.sections.length <= 1) {
			for (;;) {
				const spec = buildSpec();
				const sec = spec.sections[0];
				if (!sec || sec.items.length === 0) return;
				const detailLines = extractDetailPlain(sec.detailEntries, sec.detailLines);
				const summaryText = formatSummaryPlain(spec);
				const detailText = detailLines.length > 0 ? detailLines.join("\n") : summaryText;
				const header = detailText ? `${spec.title}\n${detailText}` : spec.title;
				const labels = sec.items.map((item) => (item.value ? `${item.label}：${item.value}` : item.label));
				const picked = await ctx.ui.select(header, labels);
				if (!picked) return;
				const target = sec.items[labels.indexOf(picked)];
				if (!target?.onActivate) continue;
				const res = await target.onActivate(false);
				if (res === "close") return;
			}
		}

		for (;;) {
			const spec = buildSpec();
			if (spec.sections.length === 0) return;
			const summaryText = formatSummaryPlain(spec);
			const rootHeader = summaryText ? `${spec.title}\n${summaryText}` : spec.title;
			const sectionLabels = spec.sections.map((sec) => `${sec.title}（${sec.items.length} 项）`);
			const pickedSec = await ctx.ui.select(rootHeader, sectionLabels);
			if (!pickedSec) return;
			currentSectionIdx = Math.max(0, sectionLabels.indexOf(pickedSec));

			for (;;) {
				const innerSpec = buildSpec();
				const sec = innerSpec.sections[currentSectionIdx];
				if (!sec) break;
				const firstItem = sec.items[0];
				const detailLines = extractDetailPlain(
					firstItem?.detailEntries ?? sec.detailEntries,
					firstItem?.detailLines ?? sec.detailLines,
				);
				const secHeader = detailLines.length > 0
					? `${innerSpec.title} — ${sec.title}\n${detailLines.join("\n")}`
					: `${innerSpec.title} — ${sec.title}`;
				const backLabel = "返回分区列表";
				const itemLabels = sec.items.map((item) => (item.value ? `${item.label}：${item.value}` : item.label));
				const pickedItem = await ctx.ui.select(secHeader, [...itemLabels, backLabel]);
				if (!pickedItem || pickedItem === backLabel) break;
				const item = sec.items[itemLabels.indexOf(pickedItem)];
				if (!item?.onActivate) continue;
				const res = await item.onActivate(false);
				if (res === "close") return;
			}
		}
	}

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let spec = buildSpec();
			let sectionIndex = 0;
			if (options?.initialSectionId) {
				const foundSec = spec.sections.findIndex((s) => s.id === options.initialSectionId);
				if (foundSec >= 0) sectionIndex = foundSec;
			}
			const selectedBySection = new Map<string, number>();
			const scrollBySection = new Map<string, number>();
			if (options?.initialItemId) {
				const sec = spec.sections[sectionIndex];
				const foundItem = sec?.items.findIndex((i) => i.id === options.initialItemId) ?? -1;
				if (sec && foundItem >= 0) selectedBySection.set(sec.id, foundItem);
			}

			let busy = false;
			let tabHitRanges: Array<{ startCol: number; endCol: number; index: number }> = [];
			let tabRowIndex = -1;
			let listRowOffset = 0;
			let listVisibleStart = 0;
			let listVisibleEnd = 0;
			let lastListCapacity = DEFAULT_SPLIT_BODY_ROWS;
			let lastLeftWidth = 40;

			const topBorder = new DynamicBorder((s) => theme.fg("accent", s));
			const bottomBorder = new DynamicBorder((s) => theme.fg("accent", s));

			const getActiveSection = (): WorkspaceSection | undefined => {
				if (spec.sections.length === 0) return undefined;
				sectionIndex = Math.max(0, Math.min(spec.sections.length - 1, sectionIndex));
				return spec.sections[sectionIndex];
			};

			const getSelectedIndex = (sec: WorkspaceSection): number => {
				if (sec.items.length === 0) return 0;
				const saved = selectedBySection.get(sec.id) ?? 0;
				const clamped = Math.max(0, Math.min(sec.items.length - 1, saved));
				selectedBySection.set(sec.id, clamped);
				return clamped;
			};

			const setSelectedIndex = (sec: WorkspaceSection, next: number): void => {
				if (sec.items.length === 0) return;
				const clamped = ((next % sec.items.length) + sec.items.length) % sec.items.length;
				selectedBySection.set(sec.id, clamped);
			};

			/** 锚定视口滚动：仅当选中项越出当前可见窗口边缘时移动窗口，避免常规移动导致整页跳动 */
			const resolveAnchoredScroll = (sec: WorkspaceSection, selIdx: number, capacity: number): number => {
				const maxOffset = Math.max(0, sec.items.length - capacity);
				let offset = Math.max(0, Math.min(maxOffset, scrollBySection.get(sec.id) ?? 0));
				if (selIdx < offset) {
					offset = selIdx;
				} else if (selIdx >= offset + capacity) {
					offset = selIdx - capacity + 1;
				}
				offset = Math.max(0, Math.min(maxOffset, offset));
				scrollBySection.set(sec.id, offset);
				return offset;
			};

			const refreshSpec = (): void => {
				spec = buildSpec();
				if (sectionIndex >= spec.sections.length) {
					sectionIndex = Math.max(0, spec.sections.length - 1);
				}
				tui.requestRender();
			};

			const triggerSelected = (spacePressed: boolean): void => {
				if (busy) return;
				const sec = getActiveSection();
				if (!sec || sec.items.length === 0) return;
				const item = sec.items[getSelectedIndex(sec)];
				if (!item?.onActivate) return;
				if (spacePressed && !item.allowSpace) return;

				const maybePromise = item.onActivate(spacePressed);
				if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
					busy = true;
					void (maybePromise as Promise<void | "close">)
						.then((res) => {
							busy = false;
							if (res === "close") {
								done();
								return;
							}
							refreshSpec();
						})
						.catch((err) => {
							busy = false;
							const msg = err instanceof Error ? err.message : String(err);
							ctx.ui.notify(msg, "error");
							refreshSpec();
						});
				} else {
					if (maybePromise === "close") {
						done();
						return;
					}
					refreshSpec();
				}
			};

			return {
				capturesViewportInput: true,
				invalidate() {
					spec = buildSpec();
				},
				render(width: number): string[] {
					const safeWidth = Math.max(24, width);
					const lines: string[] = [];
					const themeAdapter: ThemeLike = {
						fg: (c, t) => theme.fg(c, t),
						bold: (t) => theme.bold(t),
					};

					lines.push(...topBorder.render(safeWidth));

					// 顶栏严格单行（左标题 + 右对齐状态徽章），绝不折行
					const leftTitle = ` ${theme.fg("accent", theme.bold(spec.title))}`;
					const badgeSpec = spec.headerBadge ?? (spec.headerRight ? { text: spec.headerRight, tone: "muted" as const } : undefined);
					if (badgeSpec) {
						const rightBadge = `${applyTone(themeAdapter, badgeSpec.tone ?? "muted", badgeSpec.text)} `;
						const gap = safeWidth - visibleWidth(leftTitle) - visibleWidth(rightBadge);
						if (gap >= 2) {
							lines.push(`${leftTitle}${" ".repeat(gap)}${rightBadge}`);
						} else {
							const availTitle = Math.max(8, safeWidth - visibleWidth(rightBadge) - 2);
							const clippedTitle = truncateToWidth(leftTitle, availTitle, "…");
							const pad = Math.max(1, safeWidth - visibleWidth(clippedTitle) - visibleWidth(rightBadge));
							lines.push(truncateToWidth(`${clippedTitle}${" ".repeat(pad)}${rightBadge}`, safeWidth, "…"));
						}
					} else {
						lines.push(truncateToWidth(leftTitle, safeWidth, "…"));
					}

					// 可选单行指标条（严格单行截断，高度恒定）
					if (spec.summarySegments && spec.summarySegments.length > 0) {
						lines.push(renderSummaryLine(spec.summarySegments, safeWidth, themeAdapter));
					}

					// 多分区横向标签栏（固定 1 行 + 1 条底分隔线）
					tabHitRanges = [];
					tabRowIndex = -1;
					const hasTabs = spec.sections.length > 1;
					if (hasTabs) {
						tabRowIndex = lines.length;
						const tabBar = renderTabBar(spec.sections, sectionIndex, safeWidth, themeAdapter);
						tabHitRanges = tabBar.hitRanges;
						lines.push(tabBar.line);
					}
					lines.push(theme.fg("dim", "─".repeat(safeWidth)));

					const isSplit = safeWidth >= SPLIT_LAYOUT_MIN_WIDTH;
					const splitRows = Math.max(6, spec.bodyRows ?? DEFAULT_SPLIT_BODY_ROWS);
					const listCapacity = isSplit ? splitRows : NARROW_LIST_ROWS;
					const detailCapacity = isSplit ? splitRows : NARROW_DETAIL_ROWS;
					lastListCapacity = listCapacity;

					const sec = getActiveSection();
					const leftWidth = isSplit
						? Math.min(42, Math.max(28, Math.floor((safeWidth - 3) * 0.42)))
						: safeWidth;
					lastLeftWidth = leftWidth;
					const rightWidth = isSplit ? Math.max(20, safeWidth - 3 - leftWidth) : safeWidth - 2;

					listRowOffset = lines.length;
					let selIdx = 0;
					let totalItems = 0;
					const leftRows: string[] = [];
					let rightRows: string[];

					if (!sec || sec.items.length === 0) {
						listVisibleStart = 0;
						listVisibleEnd = 0;
						leftRows.push(padRightVisible(` ${theme.fg("muted", "暂无可用项目")}`, leftWidth));
						while (leftRows.length < listCapacity) leftRows.push(" ".repeat(leftWidth));
						rightRows = renderDetailColumn(undefined, undefined, [], rightWidth, detailCapacity, themeAdapter);
					} else {
						totalItems = sec.items.length;
						selIdx = getSelectedIndex(sec);
						const startIdx = resolveAnchoredScroll(sec, selIdx, listCapacity);
						const endIdx = Math.min(startIdx + listCapacity, totalItems);
						listVisibleStart = startIdx;
						listVisibleEnd = endIdx;

						for (let i = startIdx; i < endIdx; i++) {
							leftRows.push(renderLeftItemRow(sec.items[i]!, i === selIdx, leftWidth, themeAdapter));
						}
						// 不足固定行数时补空白行，锁定列表高度
						while (leftRows.length < listCapacity) {
							leftRows.push(" ".repeat(leftWidth));
						}

						const selItem = sec.items[selIdx];
						const detailTitle = selItem?.detailTitle ?? sec.detailTitle ?? "详情";
						rightRows = renderDetailColumn(
							detailTitle,
							selItem?.detailEntries ?? sec.detailEntries,
							selItem?.detailLines ?? sec.detailLines,
							rightWidth,
							detailCapacity,
							themeAdapter,
						);
					}

					if (isSplit) {
						const divider = ` ${theme.fg("dim", "│")} `;
						for (let r = 0; r < splitRows; r++) {
							const lCell = leftRows[r] ?? " ".repeat(leftWidth);
							const rCell = rightRows[r] ?? "";
							lines.push(truncateToWidth(`${lCell}${divider}${rCell}`, safeWidth, ""));
						}
					} else {
						for (let r = 0; r < listCapacity; r++) {
							lines.push(truncateToWidth(leftRows[r] ?? "", safeWidth, "…"));
						}
						lines.push(theme.fg("dim", "─".repeat(safeWidth)));
						for (let r = 0; r < detailCapacity; r++) {
							lines.push(truncateToWidth(` ${rightRows[r] ?? ""}`, safeWidth, "…"));
						}
					}

					// 底栏严格单行：左侧按键提示 + 右侧列表定位页码
					const posText = totalItems > 0 ? `${selIdx + 1}/${totalItems}${totalItems > listCapacity ? " ↕" : ""}` : "";
					const leftHint = hasTabs
						? isSplit
							? ` ←→/Tab/1-${spec.sections.length} 切页 · ↑↓ 移动 · Enter/Space 操作 · Esc 返回`
							: " ←→ 切页 · ↑↓ 移动 · Enter/Space · Esc 返回"
						: " ↑↓ 移动 · Enter 确认 · Esc 返回";
					const rightPos = posText ? `${theme.fg("dim", posText)} ` : "";
					const availHintW = Math.max(8, safeWidth - visibleWidth(rightPos) - 1);
					const clippedHint = truncateToWidth(theme.fg("dim", leftHint), availHintW, "…");
					const footerGap = Math.max(1, safeWidth - visibleWidth(clippedHint) - visibleWidth(rightPos));

					lines.push(theme.fg("dim", "─".repeat(safeWidth)));
					lines.push(truncateToWidth(`${clippedHint}${" ".repeat(footerGap)}${rightPos}`, safeWidth, "…"));
					lines.push(...bottomBorder.render(safeWidth));

					return lines;
				},
				handleMouse(event: TuiMouseEvent) {
					if (busy) return undefined;
					const sec = getActiveSection();
					if (!sec) return undefined;

					if (event.type === "wheel" && event.wheelDelta) {
						const delta = event.wheelDelta < 0 ? -1 : 1;
						setSelectedIndex(sec, getSelectedIndex(sec) + delta);
						return { handled: true, render: true };
					}

					if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) {
						return undefined;
					}

					// 点击横向标签栏切换分区
					if (tabRowIndex >= 0 && event.y === tabRowIndex) {
						const hit = tabHitRanges.find((t) => event.x >= t.startCol && event.x < t.endCol);
						if (hit) {
							sectionIndex = hit.index;
							return { handled: true, focus: true, render: true };
						}
					}

					// 点击左栏项目
					if (event.x <= lastLeftWidth && event.y >= listRowOffset) {
						const clickedIdx = listVisibleStart + (event.y - listRowOffset);
						if (clickedIdx >= listVisibleStart && clickedIdx < listVisibleEnd) {
							setSelectedIndex(sec, clickedIdx);
							if (event.type === "click") {
								triggerSelected(false);
							}
							return { handled: true, focus: true, render: true };
						}
					}
					return undefined;
				},
				handleInput(data: string) {
					if (busy) return;
					const kb = getKeybindings();
					const sec = getActiveSection();

					if (kb.matches(data, "tui.select.cancel")) {
						done();
						return;
					}

					if (spec.sections.length > 1) {
						if (matchesKey(data, "left") || matchesKey(data, "shift+tab") || data === "h") {
							sectionIndex = (sectionIndex - 1 + spec.sections.length) % spec.sections.length;
							tui.requestRender();
							return;
						}
						if (matchesKey(data, "right") || matchesKey(data, "tab") || data === "l") {
							sectionIndex = (sectionIndex + 1) % spec.sections.length;
							tui.requestRender();
							return;
						}
						if (data.length === 1 && data >= "1" && data <= "9") {
							const numIdx = Number(data) - 1;
							if (numIdx < spec.sections.length) {
								sectionIndex = numIdx;
								tui.requestRender();
								return;
							}
						}
					}

					if (!sec || sec.items.length === 0) return;

					const curIdx = getSelectedIndex(sec);
					const pageIdx = getSelectPageIndex(kb, data, curIdx, sec.items.length, lastListCapacity);
					if (pageIdx !== undefined) {
						setSelectedIndex(sec, pageIdx);
						tui.requestRender();
						return;
					}
					if (kb.matches(data, "tui.select.up") || data === "k") {
						setSelectedIndex(sec, curIdx - 1);
						tui.requestRender();
						return;
					}
					if (kb.matches(data, "tui.select.down") || data === "j") {
						setSelectedIndex(sec, curIdx + 1);
						tui.requestRender();
						return;
					}
					if (kb.matches(data, "tui.select.confirm")) {
						triggerSelected(false);
						return;
					}
					if (data === " ") {
						triggerSelected(true);
					}
				},
			};
		},
		{ blocked: { kind: "question", message: buildSpec().title } },
	);
}

// ───────────────────────── 单分区固定双栏选择面板辅助 ─────────────────────────

export interface MenuPanelItem {
	value: string;
	label: string;
	valueBadge?: string;
	valueTone?: DetailTone;
	/** 非 TUI 模式下 ctx.ui.select 展示文本，默认按 label 与 valueBadge 组合 */
	selectLabel?: string;
	detailTitle?: string;
	detailEntries?: DetailEntry[];
	detailLines?: string[];
}

/**
 * 展示单分区固定高度左右双栏选择面板（左栏固定窗口列表，右栏实时详情卡片；非 TUI 下回退至 ctx.ui.select）
 */
export async function selectMenuPanel(
	ctx: ExtensionContext,
	params: {
		title: string;
		headerBadge?: { text: string; tone?: DetailTone };
		details?: string;
		detailEntries?: DetailEntry[];
		detailTitle?: string;
		items: readonly (string | MenuPanelItem)[];
		initialValue?: string;
		bodyRows?: number;
	},
): Promise<string | undefined> {
	if (!ctx.hasUI || params.items.length === 0) return undefined;

	const normalized: MenuPanelItem[] = params.items.map((entry) =>
		typeof entry === "string" ? { value: entry, label: entry } : entry,
	);

	const canUseCustomTui = ctx.mode === "tui" && typeof ctx.ui.custom === "function";
	if (!canUseCustomTui) {
		const plainDetail = params.detailEntries && params.detailEntries.length > 0
			? formatDetailEntriesPlain(params.detailEntries).join("\n")
			: params.details;
		const header = plainDetail ? `${params.title}\n${plainDetail}` : params.title;
		const labels = normalized.map((item) =>
			item.selectLabel ?? (item.valueBadge ? `${item.label}：${item.valueBadge}` : item.label),
		);
		const picked = await ctx.ui.select(header, labels);
		if (!picked) return undefined;
		const matched =
			normalized[labels.indexOf(picked)] ??
			normalized.find((i) => i.value === picked || i.label === picked);
		return matched?.value;
	}

	let selectedResult: string | undefined;
	const defaultLines = params.details ? params.details.split("\n") : [];

	await openTabbedSplitWorkspace(
		ctx,
		() => ({
			title: params.title,
			headerBadge: params.headerBadge,
			bodyRows: params.bodyRows,
			sections: [
				{
					id: "main",
					title: params.title,
					detailTitle: params.detailTitle ?? "详情",
					detailEntries: params.detailEntries,
					detailLines: defaultLines,
					items: normalized.map((item) => ({
						id: item.value,
						label: item.label,
						value: item.valueBadge,
						valueTone: item.valueTone,
						detailTitle: item.detailTitle,
						detailEntries: item.detailEntries,
						detailLines: item.detailLines,
						onActivate: () => {
							selectedResult = item.value;
							return "close";
						},
					})),
				},
			],
		}),
		{ initialItemId: params.initialValue },
	);

	return selectedResult;
}

// ───────────────────────── /fusion config 路由与界面设置面板（3 分区固定双栏） ─────────────────────────

export interface ConfigPanelCallbacks {
	getConfig: () => FusionRouterConfig;
	/** 可用专用决策分类器的 provider/model 列表 */
	getAvailableClassifiers: () => Promise<string[]>;
	getSaveScope: () => "global" | "project";
	onScopeChange?: (scope: "global" | "project") => void;
	getLastState: () => FusionRouteState | undefined;
	onApplyPatch: (patch: PartialFusionRouterConfig, scope: "global" | "project") => FusionRouterConfig;
}

/** 决策分类器选择项的展示值 */
export function formatClassifierChoice(config: FusionRouterConfig): string {
	return config.classifier.provider === "auto" ? "auto" : `${config.classifier.provider}/${config.classifier.model}`;
}

/** 将决策分类器选择项转换为配置补丁；无法解析时返回 undefined */
export function classifierChoiceToPatch(choice: string): PartialFusionRouterConfig | undefined {
	if (choice === "auto") return { classifier: { provider: "auto" } };
	const parsed = parseModelKey(choice);
	if (!parsed) return undefined;
	return { classifier: { provider: parsed.provider, model: parsed.id } };
}

function boolLabel(value: boolean): string {
	return value ? "开启" : "关闭";
}

function boolTone(value: boolean): DetailTone {
	return value ? "success" : "dim";
}

function scopeDisplayLabel(scope: "global" | "project"): string {
	return scope === "project" ? "项目配置" : "全局配置";
}

function cycleChoice<T extends string>(current: T, choices: readonly T[]): T {
	const idx = choices.indexOf(current);
	return choices[(idx + 1) % choices.length]!;
}

/** 打开 3 分区固定高度双栏路由与界面设置面板 */
export async function openFusionSettingsPanel(
	ctx: ExtensionContext,
	callbacks: ConfigPanelCallbacks,
): Promise<void> {
	if (!ctx.hasUI) return;

	const initial = callbacks.getConfig();
	const classifiers = await callbacks.getAvailableClassifiers();
	const classifierChoices = Array.from(new Set(["auto", formatClassifierChoice(initial), ...classifiers]));
	let activeScope: "global" | "project" = callbacks.getSaveScope();

	const savePatch = (patch: PartialFusionRouterConfig): void => {
		try {
			const updated = callbacks.onApplyPatch(patch, activeScope);
			updateRouterStatusBar(ctx, updated, callbacks.getLastState());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`保存配置失败：${message}`, "error");
		}
	};

	await openTabbedSplitWorkspace(ctx, () => {
		const cfg = callbacks.getConfig();
		const errValues = Array.from(new Set(["0", "1", "2", "3", "4", "5", String(cfg.redecision.redecideOnConsecutiveToolErrors)]));
		const stepValues = Array.from(new Set(["0", "4", "8", "12", "16", "24", String(cfg.redecision.periodicReviewSteps)]));

		const makeItem = (params: {
			id: string;
			label: string;
			value: string;
			valueTone?: DetailTone;
			desc: string;
			extra?: DetailEntry[];
			hint?: string;
			onToggle: () => void | Promise<void>;
			allowSpace?: boolean;
		}): WorkspaceItem => ({
			id: params.id,
			label: params.label,
			value: params.value,
			valueTone: params.valueTone,
			allowSpace: params.allowSpace ?? true,
			detailTitle: params.label,
			detailEntries: [
				{ kind: "kv", key: "当前值", value: params.value, tone: params.valueTone ?? "text" },
				{ kind: "spacer" },
				{ kind: "text", text: params.desc, tone: "text" },
				...(params.extra ? [{ kind: "spacer" as const }, ...params.extra] : []),
				{ kind: "spacer" },
				{ kind: "hint", text: params.hint ?? "Space / Enter 切换" },
			],
			onActivate: async () => {
				await params.onToggle();
			},
		});

		const headerBadge = cfg.enabled
			? {
					text: `● ${cfg.mode === "observe" ? "观察" : "自动"} · ${scopeDisplayLabel(activeScope)}`,
					tone: (cfg.mode === "observe" ? "warning" : "success") as DetailTone,
				}
			: {
					text: `○ 已停用 · ${scopeDisplayLabel(activeScope)}`,
					tone: "dim" as DetailTone,
				};

		const errCount = cfg.redecision.redecideOnConsecutiveToolErrors;
		const reviewSteps = cfg.redecision.periodicReviewSteps;

		return {
			title: "Pi-Fusion 设置",
			headerBadge,
			bodyRows: 8,
			sections: [
				{
					id: "core",
					title: "核心选路",
					items: [
						makeItem({
							id: "enabled",
							label: "路由器总开关",
							value: boolLabel(cfg.enabled),
							valueTone: boolTone(cfg.enabled),
							desc: "关闭后跳过分类器，始终派发默认回退模型。",
							onToggle: () => savePatch({ enabled: !cfg.enabled }),
						}),
						makeItem({
							id: "mode",
							label: "运行模式",
							value: cfg.mode,
							valueTone: cfg.mode === "observe" ? "warning" : "success",
							desc: "控制分类器决策是否实际切换派发模型。",
							extra: [
								{ kind: "kv", key: "auto", value: "按决策结果自动切换模型与思考深度", tone: "muted" },
								{ kind: "kv", key: "observe", value: "仅记录推荐结果，实际派发默认模型", tone: "muted" },
							],
							onToggle: () => savePatch({ mode: cfg.mode === "auto" ? "observe" : "auto" }),
						}),
						makeItem({
							id: "classifier",
							label: "决策分类器",
							value: formatClassifierChoice(cfg),
							valueTone: "text",
							desc: "指定专用决策模型；auto 按内置优先级自动发现。",
							extra: [{ kind: "kv", key: "可选项", value: `${classifierChoices.length} 个`, tone: "muted" }],
							hint: "Space / Enter 循环切换分类器",
							onToggle: () => {
								const next = cycleChoice(formatClassifierChoice(cfg), classifierChoices);
								const patch = classifierChoiceToPatch(next);
								if (patch) savePatch(patch);
							},
						}),
						makeItem({
							id: "thinkingMode",
							label: "思考强度模式",
							value: cfg.thinkingMode,
							valueTone: "text",
							desc: "控制目标模型推理强度的决策来源。",
							extra: [
								{ kind: "kv", key: "auto", value: "由分类器按任务难度决定", tone: "muted" },
								{ kind: "kv", key: "passthrough", value: "透传 Pi 当前选择的档位", tone: "muted" },
								{ kind: "kv", key: "profile", value: "使用模型画像默认档位", tone: "muted" },
							],
							onToggle: () =>
								savePatch({
									thinkingMode: cycleChoice(
										cfg.thinkingMode,
										["auto", "passthrough", "profile-default"] as const,
									),
								}),
						}),
						makeItem({
							id: "saveScope",
							label: "配置保存位置",
							value: scopeDisplayLabel(activeScope),
							valueTone: "accent",
							desc: "决定后续修改写入全局配置还是项目配置。",
							extra: [
								{ kind: "kv", key: "全局", value: "~/.pi/agent/fusion-router.json", tone: "dim" },
								{ kind: "kv", key: "项目", value: ".pi/fusion-router.json", tone: "dim" },
							],
							onToggle: () => {
								activeScope = activeScope === "project" ? "global" : "project";
								callbacks.onScopeChange?.(activeScope);
							},
						}),
					],
				},
				{
					id: "redecision",
					title: "重决策策略",
					items: [
						makeItem({
							id: "stickyDuringToolLoop",
							label: "工具循环粘性保持",
							value: boolLabel(cfg.redecision.stickyDuringToolLoop),
							valueTone: boolTone(cfg.redecision.stickyDuringToolLoop),
							desc: "工具调用返回后优先保持当前模型，保护上下文缓存。",
							onToggle: () => savePatch({ redecision: { stickyDuringToolLoop: !cfg.redecision.stickyDuringToolLoop } }),
						}),
						makeItem({
							id: "redecideOnTaskShift",
							label: "新消息重新决策",
							value: boolLabel(cfg.redecision.redecideOnTaskShift),
							valueTone: boolTone(cfg.redecision.redecideOnTaskShift),
							desc: "收到新用户消息时重新评估模型；关闭后保持当前会话模型。",
							onToggle: () => savePatch({ redecision: { redecideOnTaskShift: !cfg.redecision.redecideOnTaskShift } }),
						}),
						makeItem({
							id: "protectThinkingSignature",
							label: "思考签名保护",
							value: boolLabel(cfg.redecision.protectThinkingSignature),
							valueTone: boolTone(cfg.redecision.protectThinkingSignature),
							desc: "本轮已产生思考块时锁定周期复查，避免跨模型丢失推理签名。",
							onToggle: () =>
								savePatch({ redecision: { protectThinkingSignature: !cfg.redecision.protectThinkingSignature } }),
						}),
						makeItem({
							id: "redecideOnConsecutiveToolErrors",
							label: "连续工具报错阈值",
							value: errCount > 0 ? `${errCount} 次` : "关闭",
							valueTone: errCount > 0 ? "text" : "dim",
							desc: "连续工具报错达到该次数后触发重新选路。",
							extra: [{ kind: "kv", key: "可选值", value: "0(关) · 1 · 2 · 3 · 4 · 5", tone: "muted" }],
							onToggle: () => {
								const next = Number(cycleChoice(String(errCount), errValues));
								savePatch({ redecision: { redecideOnConsecutiveToolErrors: next } });
							},
						}),
						makeItem({
							id: "periodicReviewSteps",
							label: "周期复查步数",
							value: reviewSteps > 0 ? `${reviewSteps} 步` : "关闭",
							valueTone: reviewSteps > 0 ? "text" : "dim",
							desc: "工具循环每执行指定步数后重新评估一次模型。",
							extra: [{ kind: "kv", key: "可选值", value: "0(关) · 4 · 8 · 12 · 16 · 24", tone: "muted" }],
							onToggle: () => {
								const next = Number(cycleChoice(String(reviewSteps), stepValues));
								savePatch({ redecision: { periodicReviewSteps: next } });
							},
						}),
					],
				},
				{
					id: "health_ui",
					title: "健康与界面",
					items: [
						makeItem({
							id: "healthEnabled",
							label: "健康冷却追踪",
							value: boolLabel(cfg.health.enabled),
							valueTone: boolTone(cfg.health.enabled),
							desc: "记录限流、超时等故障并对异常模型执行指数退避冷却。",
							onToggle: () => savePatch({ health: { enabled: !cfg.health.enabled } }),
						}),
						makeItem({
							id: "autoFailover",
							label: "故障自动转移",
							value: boolLabel(cfg.health.autoFailover),
							valueTone: boolTone(cfg.health.autoFailover),
							desc: "遇到可重试故障时自动切换至下一个健康备用模型。",
							onToggle: () => savePatch({ health: { autoFailover: !cfg.health.autoFailover } }),
						}),
						makeItem({
							id: "showStatusBar",
							label: "底部状态栏显示",
							value: boolLabel(cfg.ui.showStatusBar),
							valueTone: boolTone(cfg.ui.showStatusBar),
							desc: "在底部状态栏展示当前激活的模型与思考强度。",
							onToggle: () => savePatch({ ui: { showStatusBar: !cfg.ui.showStatusBar } }),
						}),
						makeItem({
							id: "notifyOnSwitch",
							label: "切换模型通知",
							value: boolLabel(cfg.ui.notifyOnSwitch),
							valueTone: boolTone(cfg.ui.notifyOnSwitch),
							desc: "模型发生切换时弹出提示消息。",
							onToggle: () => savePatch({ ui: { notifyOnSwitch: !cfg.ui.notifyOnSwitch } }),
						}),
						makeItem({
							id: "notifyOnFailover",
							label: "故障转移通知",
							value: boolLabel(cfg.ui.notifyOnFailover),
							valueTone: boolTone(cfg.ui.notifyOnFailover),
							desc: "发生故障冷却并自动转移时弹出告警消息。",
							onToggle: () => savePatch({ ui: { notifyOnFailover: !cfg.ui.notifyOnFailover } }),
						}),
					],
				},
			],
		};
	});
}
