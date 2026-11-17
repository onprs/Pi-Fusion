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

// ───────────────────────── 横向分区双栏工作台组件 ─────────────────────────

/** 面板双栏自适应阈值：达到该列宽时启用左右分栏，窄窗口自动退化为上下紧凑分区 */
const SPLIT_LAYOUT_MIN_WIDTH = 72;
const MAX_LEFT_VISIBLE_ROWS = 10;
const MAX_RIGHT_VISIBLE_ROWS = 16;

export interface WorkspaceItem {
	id: string;
	label: string;
	/** 左栏右侧对齐显示的当前值摘要 */
	value?: string;
	/** 光标选中该项时右栏显示的标题 */
	detailTitle?: string;
	/** 光标选中该项时右栏显示的多行内容 */
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
	/** 该分区默认的右栏多行内容 */
	detailLines?: string[];
}

export interface WorkspaceViewSpec {
	title: string;
	/** 顶栏标题行右侧对齐显示的摘要徽章 */
	headerRight?: string;
	/** 顶栏横向状态摘要条（宽屏单行并排，窄屏自动折行对齐） */
	bannerLines?: string[];
	sections: WorkspaceSection[];
}

interface ThemeLike {
	fg: (color: "accent" | "muted" | "dim" | "warning" | "error" | "success" | "text", text: string) => string;
	bold: (text: string) => string;
}

function padRightVisible(text: string, targetWidth: number): string {
	const clipped = visibleWidth(text) > targetWidth ? truncateToWidth(text, targetWidth, "…") : text;
	const pad = Math.max(0, targetWidth - visibleWidth(clipped));
	return clipped + " ".repeat(pad);
}

function renderLeftItemRow(
	item: WorkspaceItem,
	isSelected: boolean,
	colWidth: number,
	theme: ThemeLike,
): string {
	const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
	const innerWidth = Math.max(4, colWidth - 2);

	if (!item.value) {
		const rawLabel = truncateToWidth(item.label, innerWidth, "…");
		const styled = isSelected ? theme.fg("accent", theme.bold(rawLabel)) : rawLabel;
		return padRightVisible(prefix + styled, colWidth);
	}

	const minGap = 2;
	const maxLabelW = Math.max(6, Math.min(visibleWidth(item.label), Math.floor(innerWidth * 0.68)));
	const labelPart = truncateToWidth(item.label, maxLabelW, "…");
	const labelW = visibleWidth(labelPart);
	const remainingForValue = Math.max(0, innerWidth - labelW - minGap);
	const valuePart = remainingForValue > 0 ? truncateToWidth(item.value, remainingForValue, "…") : "";
	const valueW = visibleWidth(valuePart);
	const gapSpaces = " ".repeat(Math.max(1, innerWidth - labelW - valueW));

	const styledLabel = isSelected ? theme.fg("accent", theme.bold(labelPart)) : labelPart;
	const styledValue = isSelected ? theme.fg("accent", valuePart) : theme.fg("muted", valuePart);
	return padRightVisible(`${prefix}${styledLabel}${gapSpaces}${styledValue}`, colWidth);
}

function renderDetailColumn(
	title: string | undefined,
	rawLines: readonly string[],
	colWidth: number,
	theme: ThemeLike,
): string[] {
	const safeWidth = Math.max(10, colWidth);
	const out: string[] = [];
	if (title) {
		out.push(truncateToWidth(theme.fg("accent", theme.bold(title)), safeWidth, "…"));
	}
	for (const raw of rawLines) {
		for (const sub of raw.split("\n")) {
			if (!sub.trim()) {
				out.push("");
				continue;
			}
			const wrapped = wrapTextWithAnsi(theme.fg("muted", sub), safeWidth);
			for (const wLine of wrapped) {
				out.push(truncateToWidth(wLine, safeWidth, "…"));
			}
		}
	}
	if (out.length > MAX_RIGHT_VISIBLE_ROWS) {
		const omitted = out.length - (MAX_RIGHT_VISIBLE_ROWS - 1);
		return [
			...out.slice(0, MAX_RIGHT_VISIBLE_ROWS - 1),
			truncateToWidth(theme.fg("dim", `… 其余 ${omitted} 行`), safeWidth, "…"),
		];
	}
	return out;
}

/**
 * 打开横向分区双栏工作台：
 * - TUI 模式下：顶部紧凑状态条 + 横向分区标签栏（多分区时） + 左右双栏（左栏操作项、右栏实时详情卡片），窄屏自动上下排布
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

		// 单分区时直接展示该分区的项目列表；多分区时支持在分区列表与分区内操作列表之间切换
		if (firstSpec.sections.length <= 1) {
			for (;;) {
				const spec = buildSpec();
				const sec = spec.sections[0];
				if (!sec || sec.items.length === 0) return;
				const detailText = sec.detailLines?.join("\n") ?? spec.bannerLines?.join("\n");
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
			const banner = spec.bannerLines?.join("\n");
			const rootHeader = banner ? `${spec.title}\n${banner}` : spec.title;
			const sectionLabels = spec.sections.map((sec) => `${sec.title}（${sec.items.length} 项）`);
			const pickedSec = await ctx.ui.select(rootHeader, sectionLabels);
			if (!pickedSec) return;
			currentSectionIdx = Math.max(0, sectionLabels.indexOf(pickedSec));

			for (;;) {
				const innerSpec = buildSpec();
				const sec = innerSpec.sections[currentSectionIdx];
				if (!sec) break;
				const detailLines = sec.items[0]?.detailLines ?? sec.detailLines;
				const secHeader = detailLines && detailLines.length > 0
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
			if (options?.initialItemId) {
				const sec = spec.sections[sectionIndex];
				const foundItem = sec?.items.findIndex((i) => i.id === options.initialItemId) ?? -1;
				if (sec && foundItem >= 0) selectedBySection.set(sec.id, foundItem);
			}

			let busy = false;
			let tabHitRanges: Array<{ startCol: number; endCol: number; index: number }> = [];
			let listRowOffset = 0;
			let listVisibleStart = 0;
			let listVisibleEnd = 0;
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
					const safeWidth = Math.max(20, width);
					const lines: string[] = [];
					const themeAdapter: ThemeLike = {
						fg: (c, t) => theme.fg(c, t),
						bold: (t) => theme.bold(t),
					};

					lines.push(...topBorder.render(safeWidth));

					// 顶栏标题与右侧徽章同排展示，窄屏自动换行
					const leftTitle = ` ${theme.fg("accent", theme.bold(spec.title))}`;
					if (spec.headerRight) {
						const rightBadge = `${theme.fg("muted", spec.headerRight)} `;
						const gap = safeWidth - visibleWidth(leftTitle) - visibleWidth(rightBadge);
						if (gap >= 2) {
							lines.push(`${leftTitle}${" ".repeat(gap)}${rightBadge}`);
						} else {
							lines.push(truncateToWidth(leftTitle, safeWidth, "…"));
							lines.push(truncateToWidth(` ${theme.fg("muted", spec.headerRight)}`, safeWidth, "…"));
						}
					} else {
						lines.push(truncateToWidth(leftTitle, safeWidth, "…"));
					}
					if (spec.bannerLines) {
						const innerBannerWidth = Math.max(10, safeWidth - 2);
						for (const bLine of spec.bannerLines) {
							for (const wrapped of wrapTextWithAnsi(theme.fg("muted", bLine), innerBannerWidth)) {
								lines.push(truncateToWidth(` ${wrapped}`, safeWidth, "…"));
							}
						}
					}

					// 多分区横向标签栏
					tabHitRanges = [];
					const hasTabs = spec.sections.length > 1;
					if (hasTabs) {
						lines.push(theme.fg("dim", "─".repeat(safeWidth)));
						let tabLine = " ";
						let colCursor = 1;
						for (let i = 0; i < spec.sections.length; i++) {
							const s = spec.sections[i]!;
							const isActive = i === sectionIndex;
							const rawTab = isActive ? `▸ [${i + 1} ${s.title}]` : `  ${i + 1} ${s.title}  `;
							const tabW = visibleWidth(rawTab);
							if (colCursor + tabW > safeWidth - 1) break;
							tabHitRanges.push({ startCol: colCursor, endCol: colCursor + tabW, index: i });
							tabLine += isActive ? theme.fg("accent", theme.bold(rawTab)) : theme.fg("muted", rawTab);
							colCursor += tabW;
							if (i < spec.sections.length - 1 && colCursor + 2 < safeWidth) {
								tabLine += theme.fg("dim", " │");
								colCursor += 2;
							}
						}
						lines.push(truncateToWidth(tabLine, safeWidth, "…"));
						lines.push(theme.fg("dim", "─".repeat(safeWidth)));
					} else {
						lines.push("");
					}

					const sec = getActiveSection();
					if (!sec || sec.items.length === 0) {
						lines.push(truncateToWidth(` ${theme.fg("muted", "暂无可用项目")}`, safeWidth, "…"));
						lines.push(...bottomBorder.render(safeWidth));
						return lines;
					}

					const selIdx = getSelectedIndex(sec);
					const selItem = sec.items[selIdx];
					const detailTitle = selItem?.detailTitle ?? sec.detailTitle ?? "详情预览";
					const detailSource = selItem?.detailLines ?? sec.detailLines ?? [];

					const isSplit = safeWidth >= SPLIT_LAYOUT_MIN_WIDTH;
					const leftWidth = isSplit
						? Math.min(46, Math.max(30, Math.floor((safeWidth - 3) * 0.43)))
						: safeWidth - 1;
					lastLeftWidth = leftWidth;
					const rightWidth = isSplit ? Math.max(20, safeWidth - 3 - leftWidth) : safeWidth - 2;

					// 渲染左栏项目（带可视窗口滚动）
					const startIdx = Math.max(
						0,
						Math.min(selIdx - Math.floor(MAX_LEFT_VISIBLE_ROWS / 2), sec.items.length - MAX_LEFT_VISIBLE_ROWS),
					);
					const endIdx = Math.min(startIdx + MAX_LEFT_VISIBLE_ROWS, sec.items.length);
					listVisibleStart = startIdx;
					listVisibleEnd = endIdx;
					listRowOffset = lines.length;

					const leftRows: string[] = [];
					for (let i = startIdx; i < endIdx; i++) {
						leftRows.push(renderLeftItemRow(sec.items[i]!, i === selIdx, leftWidth, themeAdapter));
					}
					if (startIdx > 0 || endIdx < sec.items.length) {
						leftRows.push(
							padRightVisible(theme.fg("dim", `  (${selIdx + 1}/${sec.items.length})`), leftWidth),
						);
					}

					const rightRows = renderDetailColumn(detailTitle, detailSource, rightWidth, themeAdapter);

					if (isSplit) {
						const divider = ` ${theme.fg("dim", "│")} `;
						const bodyHeight = Math.max(leftRows.length, rightRows.length, 5);
						const blankLeft = " ".repeat(leftWidth);
						for (let r = 0; r < bodyHeight; r++) {
							const lCell = leftRows[r] ?? blankLeft;
							const rCell = rightRows[r] ?? "";
							lines.push(truncateToWidth(`${lCell}${divider}${rCell}`, safeWidth, ""));
						}
					} else {
						for (const row of leftRows) {
							lines.push(truncateToWidth(row, safeWidth, "…"));
						}
						lines.push(theme.fg("dim", "─".repeat(safeWidth)));
						for (const row of rightRows) {
							lines.push(truncateToWidth(` ${row}`, safeWidth, "…"));
						}
					}

					const footerHint = hasTabs
						? ` ←→/Tab/1-${spec.sections.length} 切换分区 • ↑↓ 选择 • Enter/Space 操作 • Esc 返回`
						: " ↑↓ 选择 • Enter 确认 • Esc 返回";
					lines.push(theme.fg("dim", "─".repeat(safeWidth)));
					lines.push(truncateToWidth(theme.fg("dim", footerHint), safeWidth, "…"));
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
					if (spec.sections.length > 1 && event.y === listRowOffset - 2) {
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
					const pageIdx = getSelectPageIndex(kb, data, curIdx, sec.items.length, MAX_LEFT_VISIBLE_ROWS);
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

// ───────────────────────── 单分区双栏选择面板辅助 ─────────────────────────

export interface MenuPanelItem {
	value: string;
	label: string;
	valueBadge?: string;
	detailTitle?: string;
	detailLines?: string[];
}

/**
 * 展示单分区左右双栏选择面板（左栏选项列表，右栏实时详情卡片；非 TUI 下回退至 ctx.ui.select）
 */
export async function selectMenuPanel(
	ctx: ExtensionContext,
	params: {
		title: string;
		details?: string;
		detailTitle?: string;
		items: readonly (string | MenuPanelItem)[];
		initialValue?: string;
	},
): Promise<string | undefined> {
	if (!ctx.hasUI || params.items.length === 0) return undefined;

	const normalized: MenuPanelItem[] = params.items.map((entry) =>
		typeof entry === "string" ? { value: entry, label: entry } : entry,
	);

	const canUseCustomTui = ctx.mode === "tui" && typeof ctx.ui.custom === "function";
	if (!canUseCustomTui) {
		const header = params.details ? `${params.title}\n${params.details}` : params.title;
		const labels = normalized.map((item) => (item.valueBadge ? `${item.label}：${item.valueBadge}` : item.label));
		const picked = await ctx.ui.select(header, labels);
		if (!picked) return undefined;
		const matched = normalized[labels.indexOf(picked)] ?? normalized.find((i) => i.value === picked || i.label === picked);
		return matched?.value;
	}

	let selectedResult: string | undefined;
	const defaultLines = params.details ? params.details.split("\n") : [];

	await openTabbedSplitWorkspace(
		ctx,
		() => ({
			title: params.title,
			sections: [
				{
					id: "main",
					title: params.title,
					detailTitle: params.detailTitle ?? "当前信息",
					detailLines: defaultLines,
					items: normalized.map((item) => ({
						id: item.value,
						label: item.label,
						value: item.valueBadge,
						detailTitle: item.detailTitle,
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

// ───────────────────────── /fusion config 路由与界面设置面板（3 分区双栏） ─────────────────────────

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

function scopeDisplayLabel(scope: "global" | "project"): string {
	return scope === "project" ? "项目配置 (.pi)" : "全局配置 (~/.pi)";
}

function cycleChoice<T extends string>(current: T, choices: readonly T[]): T {
	const idx = choices.indexOf(current);
	return choices[(idx + 1) % choices.length]!;
}

/** 打开 3 分区双栏路由与界面设置面板 */
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

	const buildOverviewLines = (cfg: FusionRouterConfig): string[] => [
		`总开关：${boolLabel(cfg.enabled)}   运行模式：${cfg.mode}`,
		`分类器：${formatClassifierChoice(cfg)}`,
		`思考模式：${cfg.thinkingMode}`,
		`粘性保持：${boolLabel(cfg.redecision.stickyDuringToolLoop)}   新消息重决策：${boolLabel(cfg.redecision.redecideOnTaskShift)}`,
		`签名保护：${boolLabel(cfg.redecision.protectThinkingSignature)}   报错阈值：${cfg.redecision.redecideOnConsecutiveToolErrors}   周期复查：${cfg.redecision.periodicReviewSteps}`,
		`健康追踪：${boolLabel(cfg.health.enabled)}   故障转移：${boolLabel(cfg.health.autoFailover)}`,
		`状态栏：${boolLabel(cfg.ui.showStatusBar)}   切换通知：${boolLabel(cfg.ui.notifyOnSwitch)}   故障通知：${boolLabel(cfg.ui.notifyOnFailover)}`,
		`保存位置：${scopeDisplayLabel(activeScope)}`,
	];

	await openTabbedSplitWorkspace(ctx, () => {
		const cfg = callbacks.getConfig();
		const overview = buildOverviewLines(cfg);
		const errValues = Array.from(new Set(["0", "1", "2", "3", "4", "5", String(cfg.redecision.redecideOnConsecutiveToolErrors)]));
		const stepValues = Array.from(new Set(["0", "4", "8", "12", "16", "24", String(cfg.redecision.periodicReviewSteps)]));

		const makeItem = (params: {
			id: string;
			label: string;
			value: string;
			desc: string;
			onToggle: () => void | Promise<void>;
			allowSpace?: boolean;
		}): WorkspaceItem => ({
			id: params.id,
			label: params.label,
			value: params.value,
			allowSpace: params.allowSpace ?? true,
			detailTitle: params.label,
			detailLines: [params.desc, "", "── 当前配置速览 ──", ...overview],
			onActivate: async () => {
				await params.onToggle();
			},
		});

		return {
			title: "Pi-Fusion 路由策略与界面设置",
			headerRight: `[${cfg.enabled ? `已启用 • ${cfg.mode}` : "已停用"}]  保存：${scopeDisplayLabel(activeScope)}`,
			bannerLines: [`分类器：${formatClassifierChoice(cfg)}  │  思考模式：${cfg.thinkingMode}`],
			sections: [
				{
					id: "core",
					title: "核心选路",
					items: [
						makeItem({
							id: "enabled",
							label: "路由器总开关",
							value: boolLabel(cfg.enabled),
							desc: "关闭后始终派发默认回退模型，跳过分类器选路。",
							onToggle: () => savePatch({ enabled: !cfg.enabled }),
						}),
						makeItem({
							id: "mode",
							label: "运行模式",
							value: cfg.mode,
							desc: "auto 自动按决策结果派发；observe 记录推荐结果但派发默认模型。",
							onToggle: () => savePatch({ mode: cfg.mode === "auto" ? "observe" : "auto" }),
						}),
						makeItem({
							id: "classifier",
							label: "决策分类器",
							value: formatClassifierChoice(cfg),
							desc: "选择专用决策模型，auto 按内置优先级自动发现。",
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
							desc: "auto 由分类器决定；passthrough 透传当前选择；profile-default 使用模型默认档位。",
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
							desc: "切换后续修改写入全局配置还是当前项目配置。",
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
							desc: "工具调用返回后优先保持当前模型，保护上下文缓存。",
							onToggle: () => savePatch({ redecision: { stickyDuringToolLoop: !cfg.redecision.stickyDuringToolLoop } }),
						}),
						makeItem({
							id: "redecideOnTaskShift",
							label: "新消息重新决策",
							value: boolLabel(cfg.redecision.redecideOnTaskShift),
							desc: "收到新用户消息时重新评估模型；关闭后保持当前会话模型。",
							onToggle: () => savePatch({ redecision: { redecideOnTaskShift: !cfg.redecision.redecideOnTaskShift } }),
						}),
						makeItem({
							id: "protectThinkingSignature",
							label: "思考签名保护",
							value: boolLabel(cfg.redecision.protectThinkingSignature),
							desc: "当前轮次已产生思考内容时避免切换模型，保留完整推理上下文。",
							onToggle: () =>
								savePatch({ redecision: { protectThinkingSignature: !cfg.redecision.protectThinkingSignature } }),
						}),
						makeItem({
							id: "redecideOnConsecutiveToolErrors",
							label: "连续工具报错阈值",
							value: String(cfg.redecision.redecideOnConsecutiveToolErrors),
							desc: "连续多少次工具报错后触发重新选路（0 表示关闭）。",
							onToggle: () => {
								const next = Number(cycleChoice(String(cfg.redecision.redecideOnConsecutiveToolErrors), errValues));
								savePatch({ redecision: { redecideOnConsecutiveToolErrors: next } });
							},
						}),
						makeItem({
							id: "periodicReviewSteps",
							label: "周期复查步数",
							value: String(cfg.redecision.periodicReviewSteps),
							desc: "工具循环每执行多少步重新评估一次模型（0 表示关闭）。",
							onToggle: () => {
								const next = Number(cycleChoice(String(cfg.redecision.periodicReviewSteps), stepValues));
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
							desc: "记录限流、超时等上游故障并对异常模型执行指数退避冷却。",
							onToggle: () => savePatch({ health: { enabled: !cfg.health.enabled } }),
						}),
						makeItem({
							id: "autoFailover",
							label: "故障自动转移",
							value: boolLabel(cfg.health.autoFailover),
							desc: "请求遇到可重试故障时自动切换至健康的备用模型。",
							onToggle: () => savePatch({ health: { autoFailover: !cfg.health.autoFailover } }),
						}),
						makeItem({
							id: "showStatusBar",
							label: "底部状态栏显示",
							value: boolLabel(cfg.ui.showStatusBar),
							desc: "在底部状态栏展示当前激活的模型与思考强度。",
							onToggle: () => savePatch({ ui: { showStatusBar: !cfg.ui.showStatusBar } }),
						}),
						makeItem({
							id: "notifyOnSwitch",
							label: "切换模型通知",
							value: boolLabel(cfg.ui.notifyOnSwitch),
							desc: "模型发生切换时弹出提示消息。",
							onToggle: () => savePatch({ ui: { notifyOnSwitch: !cfg.ui.notifyOnSwitch } }),
						}),
						makeItem({
							id: "notifyOnFailover",
							label: "故障转移通知",
							value: boolLabel(cfg.ui.notifyOnFailover),
							desc: "发生故障冷却并自动转移时弹出告警消息。",
							onToggle: () => savePatch({ ui: { notifyOnFailover: !cfg.ui.notifyOnFailover } }),
						}),
					],
				},
			],
		};
	});
}
