import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	getSelectPageIndex,
	matchesKey,
	truncateToWidth,
	type TuiMouseEvent,
	visibleWidth,
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

// ───────────────────────── 单栏固定高度工作台组件 ─────────────────────────

/** 启用行内第 3 列精简说明的最小终端列宽；窄屏退化为两列列表 + 底部固定 1 行选中项说明 */
const INLINE_HINT_MIN_WIDTH = 68;
/** 宽屏默认固定列表行数 */
const DEFAULT_LIST_ROWS = 10;
/** 窄屏固定列表行数 */
const NARROW_LIST_ROWS = 7;
/** 值列固定槽位宽度，防止切换枚举/开关值时后续说明列左右抖动 */
const FIXED_VALUE_COL_WIDTH = 15;

export type DetailTone = "accent" | "success" | "warning" | "error" | "text" | "muted" | "dim";

export interface SummarySegment {
	label: string;
	value: string;
	tone?: DetailTone;
}

export interface WorkspaceItem {
	id: string;
	label: string;
	/** 选项当前状态或数值 */
	value?: string;
	/** 状态值语义色调 */
	valueTone?: DetailTone;
	/** 选项行内精简摘要或说明（宽屏显示在第 3 列，窄屏选中时固定显示在底部 1 行） */
	hint?: string;
	/** 行内摘要语义色调 */
	hintTone?: DetailTone;
	/** 是否允许按空格键触发（适合布尔与枚举切换项） */
	allowSpace?: boolean;
	/** 激活回调；返回 "close" 时关闭当前工作台 */
	onActivate?: (spacePressed: boolean) => void | "close" | Promise<void | "close">;
}

export interface WorkspaceSection {
	id: string;
	title: string;
	items: WorkspaceItem[];
	/** 非 TUI 模式下展示在该分区顶部的补充说明行 */
	plainHeaderLines?: string[];
}

export interface WorkspaceViewSpec {
	title: string;
	/** 顶栏标题行右侧对齐显示的状态徽章 */
	headerBadge?: { text: string; tone?: DetailTone };
	/** 顶栏固定单行关键指标条（永不折行） */
	summarySegments?: SummarySegment[];
	/** 列表上方可选固定只读信息行（仅用于单页诊断视图，每行严格单行截断） */
	infoLines?: string[];
	/** 宽屏固定列表行数（默认 10 行） */
	listRows?: number;
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

function renderSummaryLine(segments: readonly SummarySegment[], safeWidth: number, theme: ThemeLike): string {
	const sep = theme.fg("dim", "  │  ");
	const parts = segments.map((seg) => {
		const k = theme.fg("dim", `${seg.label} `);
		const v = applyTone(theme, seg.tone ?? "text", seg.value);
		return `${k}${v}`;
	});
	return truncateToWidth(` ${parts.join(sep)}`, safeWidth, "…");
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
			const sepRaw = compact ? " │ " : "   ";
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

function styleItemValue(item: WorkspaceItem, isSelected: boolean, valuePart: string, theme: ThemeLike): string {
	const tone = item.valueTone ?? "muted";
	if (isSelected) {
		if (tone === "warning" || tone === "error" || tone === "success") {
			return theme.bold(applyTone(theme, tone, valuePart));
		}
		return theme.fg("accent", valuePart);
	}
	return applyTone(theme, tone, valuePart);
}

/** 宽屏三列对齐行：名称 + 固定槽位状态值 + 精简行内摘要 */
function renderWideListRow(
	item: WorkspaceItem,
	isSelected: boolean,
	layout: { safeWidth: number; labelColW: number; valueColW: number; hasValueCol: boolean },
	theme: ThemeLike,
): string {
	const prefix = isSelected ? theme.fg("accent", "▸ ") : "  ";
	const rawLabel = truncateToWidth(item.label, layout.labelColW, "…");
	const labelPad = " ".repeat(Math.max(0, layout.labelColW - visibleWidth(rawLabel)));
	const styledLabel = isSelected ? theme.fg("accent", theme.bold(rawLabel)) : theme.fg("text", rawLabel);

	let row = `${prefix}${styledLabel}${labelPad}`;
	let usedW = 2 + layout.labelColW;

	if (layout.hasValueCol) {
		const rawVal = item.value ? truncateToWidth(item.value, layout.valueColW, "…") : "";
		const valPad = " ".repeat(Math.max(0, layout.valueColW - visibleWidth(rawVal)));
		const styledVal = rawVal ? styleItemValue(item, isSelected, rawVal, theme) : "";
		row += `  ${styledVal}${valPad}`;
		usedW += 2 + layout.valueColW;
	}

	const hintBudget = layout.safeWidth - usedW - 3;
	if (item.hint && hintBudget >= 8) {
		const rawHint = truncateToWidth(item.hint, hintBudget, "…");
		const hintTone: DetailTone = item.hintTone ?? (isSelected ? "muted" : "dim");
		const styledHint = applyTone(theme, isSelected && !item.hintTone ? "text" : hintTone, rawHint);
		row += `  ${styledHint}`;
	}

	return padRightVisible(row, layout.safeWidth);
}

/** 窄屏两列紧凑行：左对齐名称 + 右对齐状态值 */
function renderNarrowListRow(
	item: WorkspaceItem,
	isSelected: boolean,
	safeWidth: number,
	theme: ThemeLike,
): string {
	const prefix = isSelected ? theme.fg("accent", "▸ ") : "  ";
	const innerWidth = Math.max(8, safeWidth - 3);

	if (!item.value) {
		const rawLabel = truncateToWidth(item.label, innerWidth, "…");
		const styled = isSelected ? theme.fg("accent", theme.bold(rawLabel)) : theme.fg("text", rawLabel);
		return padRightVisible(prefix + styled, safeWidth);
	}

	const valueBudget = Math.max(6, Math.floor(innerWidth * 0.4));
	const valPart = truncateToWidth(item.value, valueBudget, "…");
	const labelBudget = Math.max(6, innerWidth - visibleWidth(valPart) - 2);
	const labelPart = truncateToWidth(item.label, labelBudget, "…");
	const gap = " ".repeat(Math.max(1, innerWidth - visibleWidth(labelPart) - visibleWidth(valPart)));

	const styledLabel = isSelected ? theme.fg("accent", theme.bold(labelPart)) : theme.fg("text", labelPart);
	const styledValue = styleItemValue(item, isSelected, valPart, theme);
	return padRightVisible(`${prefix}${styledLabel}${gap}${styledValue}`, safeWidth);
}

/**
 * 打开单栏固定高度横向分区工作台：
 * - TUI 模式下：全宽三列固定高度列表（名称 + 固定槽位状态值 + 精简摘要），无冗余右侧概览板块；
 *   切页、移动光标与切换状态时面板高度与列对齐位置均保持恒定
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

		if (firstSpec.sections.length <= 1) {
			for (;;) {
				const spec = buildSpec();
				const sec = spec.sections[0];
				if (!sec || sec.items.length === 0) return;
				const headerExtra =
					sec.plainHeaderLines && sec.plainHeaderLines.length > 0
						? sec.plainHeaderLines.join("\n")
						: spec.infoLines && spec.infoLines.length > 0
							? spec.infoLines.join("\n")
							: formatSummaryPlain(spec);
				const header = headerExtra ? `${spec.title}\n${headerExtra}` : spec.title;
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
				const secHeader =
					sec.plainHeaderLines && sec.plainHeaderLines.length > 0
						? `${innerSpec.title} — ${sec.title}\n${sec.plainHeaderLines.join("\n")}`
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
			let lastListCapacity = DEFAULT_LIST_ROWS;

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

			/** 锚定视口滚动：仅当光标触及当前可见窗口上下边缘时滚动，常规移动保持列表稳定 */
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

					// 顶栏严格单行（左标题 + 右对齐状态徽章）
					const leftTitle = ` ${theme.fg("accent", theme.bold(spec.title))}`;
					if (spec.headerBadge) {
						const rightBadge = `${applyTone(themeAdapter, spec.headerBadge.tone ?? "muted", spec.headerBadge.text)} `;
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

					// 顶栏固定单行关键指标条（永不折行）
					if (spec.summarySegments && spec.summarySegments.length > 0) {
						lines.push(renderSummaryLine(spec.summarySegments, safeWidth, themeAdapter));
					}

					// 多分区横向标签栏（固定 1 行）
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

					// 可选固定只读信息行（用于独立诊断子页）
					if (spec.infoLines && spec.infoLines.length > 0) {
						for (const rawInfo of spec.infoLines) {
							lines.push(truncateToWidth(` ${theme.fg("muted", rawInfo)}`, safeWidth, "…"));
						}
						lines.push(theme.fg("dim", "─".repeat(safeWidth)));
					}

					const isWide = safeWidth >= INLINE_HINT_MIN_WIDTH;
					const listCapacity = isWide ? Math.max(4, spec.listRows ?? DEFAULT_LIST_ROWS) : NARROW_LIST_ROWS;
					lastListCapacity = listCapacity;

					// 跨全部分区统一计算对齐列宽，切换分区与修改状态值时列位置恒定
					const allItems = spec.sections.flatMap((s) => s.items);
					const hasValueCol = allItems.some((i) => i.value !== undefined && i.value !== "");
					const maxLabelW = allItems.reduce((m, i) => Math.max(m, visibleWidth(i.label)), 0);
					const labelColW = Math.min(28, Math.max(16, maxLabelW), Math.floor((safeWidth - 6) * 0.38));
					const valueColW = hasValueCol ? Math.min(FIXED_VALUE_COL_WIDTH, Math.floor((safeWidth - 6) * 0.24)) : 0;

					const sec = getActiveSection();
					listRowOffset = lines.length;
					let selIdx = 0;
					let totalItems = 0;
					let selectedHint = "";

					if (!sec || sec.items.length === 0) {
						listVisibleStart = 0;
						listVisibleEnd = 0;
						lines.push(padRightVisible(` ${theme.fg("muted", "暂无可用项目")}`, safeWidth));
						for (let r = 1; r < listCapacity; r++) lines.push(" ".repeat(safeWidth));
					} else {
						totalItems = sec.items.length;
						selIdx = getSelectedIndex(sec);
						selectedHint = sec.items[selIdx]?.hint ?? "";
						const startIdx = resolveAnchoredScroll(sec, selIdx, listCapacity);
						const endIdx = Math.min(startIdx + listCapacity, totalItems);
						listVisibleStart = startIdx;
						listVisibleEnd = endIdx;

						for (let i = startIdx; i < endIdx; i++) {
							const item = sec.items[i]!;
							lines.push(
								isWide
									? renderWideListRow(
											item,
											i === selIdx,
											{ safeWidth, labelColW, valueColW, hasValueCol },
											themeAdapter,
										)
									: renderNarrowListRow(item, i === selIdx, safeWidth, themeAdapter),
							);
						}
						// 不足固定列表行数时用空白行补齐，锁定列表高度
						for (let r = endIdx - startIdx; r < listCapacity; r++) {
							lines.push(" ".repeat(safeWidth));
						}
					}

					// 窄屏在列表下方固定保留 1 行显示当前选中项说明，避免丢失信息且高度恒定
					if (!isWide) {
						lines.push(theme.fg("dim", "─".repeat(safeWidth)));
						const hintLine = selectedHint ? ` ${theme.fg("muted", selectedHint)}` : "";
						lines.push(truncateToWidth(hintLine, safeWidth, "…"));
					}

					// 底栏严格单行：左侧按键提示 + 右侧列表定位页码
					const posText = totalItems > 0 ? `${selIdx + 1}/${totalItems}${totalItems > listCapacity ? " ↕" : ""}` : "";
					const leftHint = hasTabs
						? isWide
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

					// 点击列表任意位置选中或激活对应行
					if (event.y >= listRowOffset) {
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

// ───────────────────────── 单分区固定高度选择面板辅助 ─────────────────────────

export interface MenuPanelItem {
	value: string;
	label: string;
	valueBadge?: string;
	valueTone?: DetailTone;
	/** 行内精简说明或动态摘要 */
	hint?: string;
	hintTone?: DetailTone;
	/** 非 TUI 模式下 ctx.ui.select 展示文本，默认按 label 与 valueBadge 组合 */
	selectLabel?: string;
}

/**
 * 展示单分区固定高度全宽选择面板（非 TUI 下回退至 ctx.ui.select）
 */
export async function selectMenuPanel(
	ctx: ExtensionContext,
	params: {
		title: string;
		headerBadge?: { text: string; tone?: DetailTone };
		summarySegments?: SummarySegment[];
		/** 非 TUI 模式下的头部说明文本 */
		details?: string;
		/** TUI 模式下列表上方的固定紧凑信息行（仅用于独立诊断视图） */
		infoLines?: string[];
		items: readonly (string | MenuPanelItem)[];
		initialValue?: string;
		listRows?: number;
	},
): Promise<string | undefined> {
	if (!ctx.hasUI || params.items.length === 0) return undefined;

	const normalized: MenuPanelItem[] = params.items.map((entry) =>
		typeof entry === "string" ? { value: entry, label: entry } : entry,
	);

	const canUseCustomTui = ctx.mode === "tui" && typeof ctx.ui.custom === "function";
	if (!canUseCustomTui) {
		const plainDetail = params.details ?? params.infoLines?.join("\n");
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

	await openTabbedSplitWorkspace(
		ctx,
		() => ({
			title: params.title,
			headerBadge: params.headerBadge,
			summarySegments: params.summarySegments,
			infoLines: params.infoLines,
			listRows: params.listRows,
			sections: [
				{
					id: "main",
					title: params.title,
					items: normalized.map((item) => ({
						id: item.value,
						label: item.label,
						value: item.valueBadge,
						valueTone: item.valueTone,
						hint: item.hint,
						hintTone: item.hintTone,
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

// ───────────────────────── /fusion config 路由与界面设置面板（3 分区单栏固定列表） ─────────────────────────

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

/** 打开 3 分区固定高度单栏路由与界面设置面板 */
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
		const errCount = cfg.redecision.redecideOnConsecutiveToolErrors;
		const reviewSteps = cfg.redecision.periodicReviewSteps;
		const errValues = Array.from(new Set(["0", "1", "2", "3", "4", "5", String(errCount)]));
		const stepValues = Array.from(new Set(["0", "4", "8", "12", "16", "24", String(reviewSteps)]));

		const makeItem = (params: {
			id: string;
			label: string;
			value: string;
			valueTone?: DetailTone;
			hint: string;
			onToggle: () => void | Promise<void>;
			allowSpace?: boolean;
		}): WorkspaceItem => ({
			id: params.id,
			label: params.label,
			value: params.value,
			valueTone: params.valueTone,
			hint: params.hint,
			allowSpace: params.allowSpace ?? true,
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

		return {
			title: "Pi-Fusion 设置",
			headerBadge,
			listRows: 6,
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
							hint: "关闭后跳过分类器，始终派发默认回退模型",
							onToggle: () => savePatch({ enabled: !cfg.enabled }),
						}),
						makeItem({
							id: "mode",
							label: "运行模式",
							value: cfg.mode,
							valueTone: cfg.mode === "observe" ? "warning" : "success",
							hint: "auto 按决策切换；observe 仅记录推荐并派发默认模型",
							onToggle: () => savePatch({ mode: cfg.mode === "auto" ? "observe" : "auto" }),
						}),
						makeItem({
							id: "classifier",
							label: "决策分类器",
							value: formatClassifierChoice(cfg),
							valueTone: "text",
							hint: `auto 自动发现 · 共 ${classifierChoices.length} 个可选项`,
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
							hint: "auto 分类器 · passthrough 透传 · profile-default 默认",
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
							hint: activeScope === "project" ? "写入 .pi/fusion-router.json" : "写入 ~/.pi/agent/fusion-router.json",
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
							hint: "工具调用返回后优先保持当前模型，保护上下文缓存",
							onToggle: () => savePatch({ redecision: { stickyDuringToolLoop: !cfg.redecision.stickyDuringToolLoop } }),
						}),
						makeItem({
							id: "redecideOnTaskShift",
							label: "新消息重新决策",
							value: boolLabel(cfg.redecision.redecideOnTaskShift),
							valueTone: boolTone(cfg.redecision.redecideOnTaskShift),
							hint: "收到新用户消息时重新评估模型；关闭后沿用当前模型",
							onToggle: () => savePatch({ redecision: { redecideOnTaskShift: !cfg.redecision.redecideOnTaskShift } }),
						}),
						makeItem({
							id: "protectThinkingSignature",
							label: "思考签名保护",
							value: boolLabel(cfg.redecision.protectThinkingSignature),
							valueTone: boolTone(cfg.redecision.protectThinkingSignature),
							hint: "本轮已产生思考块时锁定周期复查，防止丢失推理签名",
							onToggle: () =>
								savePatch({ redecision: { protectThinkingSignature: !cfg.redecision.protectThinkingSignature } }),
						}),
						makeItem({
							id: "redecideOnConsecutiveToolErrors",
							label: "连续工具报错阈值",
							value: errCount > 0 ? `${errCount} 次` : "关闭",
							valueTone: errCount > 0 ? "text" : "dim",
							hint: "连续报错达阈值后重新选路（0 关 · 1~5）",
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
							hint: "工具循环每满步数重新评估一次模型（0 关 · 4~24）",
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
							hint: "记录限流、超时等故障并执行指数退避冷却",
							onToggle: () => savePatch({ health: { enabled: !cfg.health.enabled } }),
						}),
						makeItem({
							id: "autoFailover",
							label: "故障自动转移",
							value: boolLabel(cfg.health.autoFailover),
							valueTone: boolTone(cfg.health.autoFailover),
							hint: "可重试故障时自动切换至下一个健康备用模型",
							onToggle: () => savePatch({ health: { autoFailover: !cfg.health.autoFailover } }),
						}),
						makeItem({
							id: "showStatusBar",
							label: "底部状态栏显示",
							value: boolLabel(cfg.ui.showStatusBar),
							valueTone: boolTone(cfg.ui.showStatusBar),
							hint: "在底部状态栏展示当前激活的模型与思考强度",
							onToggle: () => savePatch({ ui: { showStatusBar: !cfg.ui.showStatusBar } }),
						}),
						makeItem({
							id: "notifyOnSwitch",
							label: "切换模型通知",
							value: boolLabel(cfg.ui.notifyOnSwitch),
							valueTone: boolTone(cfg.ui.notifyOnSwitch),
							hint: "动态路由切换物理模型时弹出提示消息",
							onToggle: () => savePatch({ ui: { notifyOnSwitch: !cfg.ui.notifyOnSwitch } }),
						}),
						makeItem({
							id: "notifyOnFailover",
							label: "故障转移通知",
							value: boolLabel(cfg.ui.notifyOnFailover),
							valueTone: boolTone(cfg.ui.notifyOnFailover),
							hint: "触发故障冷却并自动转移时弹出告警消息",
							onToggle: () => savePatch({ ui: { notifyOnFailover: !cfg.ui.notifyOnFailover } }),
						}),
					],
				},
			],
		};
	});
}
