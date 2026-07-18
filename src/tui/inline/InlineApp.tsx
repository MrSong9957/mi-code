// src/tui/inline/InlineApp.tsx
// Inline 模式的根组件：统一控制所有 stdout 写入顺序。
// 物理本质：Logo → 消息 → Footer，全部在一个 useEffect 中按序写入，
// 消除多个 useEffect 竞争 stdout 导致的覆盖问题。
//
// 渲染模型（统一管线）：所有写入都通过 renderer.commit()，
// 内部用 cursorUp 全行覆写 + \n 推进（活跃区在 BSU/ESU 原子块内）。
// 固化消息用 \n 推进自然进 scrollback；草稿+footer 用 cursorUp 覆写。
// logo 首次渲染和 resize 清屏通过 frame.prefix 折叠进 commit 的单次 write。
// commit() 是唯一 stdout 出口——无直接 stdout.write 调用。

import React, { useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { InlineRenderer } from './InlineRenderer.js';
import { colorizeLogo, colorizeStatus, RESET } from './colors.js';
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import { layoutFooter } from './layout.js';
import { buildSpinnerLines } from './SpinnerLine.js';
import { computeSpinnerVisible } from './spinner-visibility.js';
import { displayWidth } from './text-layout.js';
import { getTheme } from '../../utils/theme.js';
import { resolveSGR as themeSGR } from '../../utils/theme-resolve.js';
import { selectSpinnerView } from '../state/spinner-view.js';
import { renderFinalizedLine, wrapStreamingTextTrimmed, wrapThinkingTextTrimmed } from './text-layout.js';
import { useThrottledStreamingText } from './use-throttled-streaming-text.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { FormattedLine } from '../../ui/types.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectStore } from '../state/select-store.js';
import type { SelectionStore } from '../state/selection-store.js';
import type { OverlayStore } from '../state/overlay-store.js';

export interface InlineAppProps {
  messages: TuiMessage[];
  status: StatusBarData;
  logo: LogoData;
  renderer: InlineRenderer;
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  selectStore: SelectStore;
  selectionStore: SelectionStore;
  overlayStore: OverlayStore;
  /** 终端列宽（由 ConnectedApp 经 useTerminalSize 订阅后透传）。
   *  resize 时此 prop 变化 → 渲染 effect 依赖触发 → footer 重绘 + wordWrap 重算。 */
  cols: number;
  /** 终端行数(用于下拉菜单动态高度计算)。 */
  rows: number;
}

/** 构建 logo 3 行的 ANSI 字符串（含 \n），供 prefix 使用 */
function buildLogoAnsi(logo: LogoData): string[] {
  return [
    colorizeLogo(` ▐▛███▜▌   MiCode v${logo.version}`) + '\n',
    colorizeLogo('▝▜█████▛▘  TypeScript CLI · Node.js Runtime') + '\n',
    colorizeLogo(`  ▘▘ ▝▝    ${logo.dir}`) + '\n',
  ];
}

function stripAnsi(value: string): string {
  return value.split('\x1b[').map((part, index) => {
    if (index === 0) return part;
    const terminator = part.indexOf('m');
    return terminator >= 0 ? part.slice(terminator + 1) : part;
  }).join('');
}

/** 组装 Select 界面的 ANSI 行(标题 + 选项列表 + 快捷键提示) */
function buildSelectView(
  title: string,
  options: readonly { value: string; label: string; description?: string }[],
  selectedIndex: number,
  cols: number,
): { title: string; items: string[]; hint: string } {
  const theme = getTheme();
  const suggestionSGR = themeSGR(theme, 'suggestion');
  const SELECT_LEFT_PAD = 2;

  // 命令名列宽度:最长 label + padding,上限终端 40%
  const labelMaxWidth = Math.min(
    Math.max(...options.map(o => displayWidth(o.label)), 0) + 3,
    Math.floor(cols * 0.4),
  );

  const items: string[] = options.map((opt, i) => {
    const isSelected = i === selectedIndex;
    const labelPad = ' '.repeat(Math.max(0, labelMaxWidth - displayWidth(opt.label)));
    const desc = opt.description ?? '';
    if (isSelected) {
      // 选中:主题色整行
      return `${' '.repeat(SELECT_LEFT_PAD)}${suggestionSGR}> ${opt.label}${labelPad}  ${desc}${RESET}`;
    }
    // 未选中:命令名正常,描述 dim
    const dimDesc = desc ? `\x1b[2m${labelPad}  ${desc}\x1b[0m` : labelPad;
    return `${' '.repeat(SELECT_LEFT_PAD)}${opt.label}${dimDesc}`;
  });

  return {
    title: `${' '.repeat(SELECT_LEFT_PAD)}\x1b[1m${title}\x1b[0m`,
    items,
    hint: `${' '.repeat(SELECT_LEFT_PAD)}\x1b[2m↑↓ navigate · Enter confirm · Esc cancel\x1b[0m`,
  };
}

export function InlineApp({
  messages,
  logo,
  renderer,
  inputStore,
  statusStore,
  spinnerStore,
  completionStore,
  selectStore,
  overlayStore,
  cols,
  rows,
}: InlineAppProps): React.ReactElement {
  /** 上次 effect 看到的末条消息 finalized 状态，用于检测 streaming→finalized 转换 */
  const prevLastFinalizedRef = useRef<boolean | undefined>(undefined);
  /** 上次 effect 看到的 cols，用于检测 resize → 清屏重画 */
  const prevColsRef = useRef<number>(cols);
  /** logo 是否已输出（首次 effect 时输出，之后不再重复） */
  const logoRenderedRef = useRef(false);
  /** 上次 effect 看到的 Select 可见状态,用于检测 Select 开关切换 → forceFooterReset */
  const prevSelectVisibleRef = useRef(false);

  // 订阅 store 状态
  const inputText = useStore(inputStore, (s) => s.text);
  const cursor = useStore(inputStore, (s) => s.cursor);
  const statusData = useStore(statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));
  const spinnerState = useStore(spinnerStore);
  const spinnerView = useMemo(
    () => selectSpinnerView(spinnerState),
    [spinnerState],
  );
  // overlay（ctrl+o 备用屏）：visible 时渲染覆盖层，替代正常输出
  const overlay = useStore(overlayStore, useShallow((s) => ({
    visible: s.visible, title: s.title, lines: s.lines,
  })));
  /** 追踪 overlay 上一帧的 visible 状态（检测 打开→关闭 转换，触发重绘） */
  const overlayWasVisibleRef = useRef(false);
  // 下拉菜单状态（单一数据源：completionStore；渲染合并到 renderFooter 的原子块）
  const dropdownVisible = useStore(completionStore, (s) => s.visible);
  const dropdownCandidates = useStore(completionStore, (s) => s.candidates);
  const dropdownIndex = useStore(completionStore, (s) => s.index);
  // Select 界面(交互式选择器):visible 时替换整个 footer
  const selectVisible = useStore(selectStore, (s) => s.visible);
  const selectTitle = useStore(selectStore, (s) => s.title);
  const selectOptions = useStore(selectStore, (s) => s.options);
  const selectIndex = useStore(selectStore, (s) => s.index);

  // overlay 渲染：visible 时进备用屏显示内容（最高优先级，独立 effect）
  useEffect(() => {
    if (overlay.visible) {
      // 打开：进入备用屏（终端自动保存主屏）+ 渲染 overlay 内容
      const textLines = overlay.lines.map(l => {
        const clean = stripAnsi(l.content);
        return clean;
      });
      renderer.renderOverlay(overlay.title, textLines, cols);
      overlayWasVisibleRef.current = true;
    } else if (overlayWasVisibleRef.current) {
      // 关闭：退出备用屏（\x1b[?1049l）——终端自动恢复主屏内容，零重绘。
      overlayWasVisibleRef.current = false;
      renderer.exitOverlay();
    }
  }, [overlay, renderer]); // cols 不在依赖：resize 不主动重画（ConPTY 兼容性）

  // 末条消息的流式文本（驱动逐字渲染）
  const lastMsg = messages[messages.length - 1];
  // 节流：多个 token 在 cooldown（32ms）内合并，只 flush 最新值到渲染层。
  // 对标 Claude Code 机制四（Ink throttle + React batching 合并多 token 到一帧）。
  // finalize（undefined）走立即同步，绕过节流，保证固化行及时进 scrollback。
  const realStreamingText = lastMsg?.streamingText;
  const streamingText = useThrottledStreamingText(realStreamingText);

  // 统一写入：已固化新消息 → 流式覆写 → Footer
  useEffect(() => {
    // overlay 打开时：主渲染 effect 跳过（不与 overlay 竞争 stdout）
    if (overlay.visible) {
      prevColsRef.current = cols;
      return;
    }

    // ── 0. 构建前置输出（prefix）：logo 首次渲染 / resize 清屏+logo ──
    const prefix: string[] = [];

    // logo 首次渲染（折叠进 commit 的单次 write）
    if (!logoRenderedRef.current) {
      logoRenderedRef.current = true;
      prefix.push(...buildLogoAnsi(logo));
    }

    // Resize 检测：cols 变化 → 清屏 + 重置状态 + 全量重画
    // cursorUp 全行覆写模式在 reflow 后无法自纠正（footerHeight/lastStreamingHeight
    // 和屏幕实际行数不一致 → cursorUp 距离算错 → 堆叠）。
    // Claude Code 也在 resize 后清屏重画（log-update.ts:142 fullResetSequence）。
    if (cols !== prevColsRef.current) {
      prevColsRef.current = cols;
      // 清屏 + 清 scrollback + 光标归位（\x1b[3J 防止多次 resize 累积重复内容）
      prefix.push('\x1b[2J\x1b[3J\x1b[H\n');
      // 重写 logo
      prefix.push(...buildLogoAnsi(logo));
      // 重置渲染状态：让所有已固化消息变成 pending → 重新 appendLine
      renderer.state.renderedLines.clear();
      renderer.state.footerHeight = 0;
      renderer.state.lastStreamingHeight = 0;
      renderer.state.cursorToTop = 0;
      // 重置流式状态（下一帧从头开始）
      prevLastFinalizedRef.current = undefined;
    }

    // ── 1. 收集新增固化行（渲染账本在 renderer.state.renderedLines）──
    const finalizedMessages = messages.filter(m => m.finalized);
    const state = renderer.state;
    const last = messages[messages.length - 1];
    const isStreamingNow = last && !last.finalized && last.streamingText !== undefined;

    // 状态转换信号（用于 commit 内部决定 commitFooter/erase/clearStreamingHeight 调用）
    const justFinalized = prevLastFinalizedRef.current === false && !isStreamingNow;
    const needEraseDraft = justFinalized;

    const pendingLines: { role: string; line: FormattedLine }[] = [];
    for (const msg of finalizedMessages) {
      const rendered = state.getRenderedLineCount(msg.uuid);
      for (let i = rendered; i < msg.lines.length; i++) {
        pendingLines.push({ role: msg.role, line: msg.lines[i]! });
      }
    }
    const hasNewFinalized = pendingLines.length > 0;
    const hasAnyContent = messages.length > 0 || inputText.length > 0;

    // 无消息且无输入时，不绘制 footer（避免首次启动时多余的空 footer）
    if (!hasAnyContent && !hasNewFinalized && state.renderedCount === 0 && !streamingText) {
      // 首次启动只有 logo 时，仍需 flush prefix（logo）
      if (prefix.length > 0) {
        renderer.commit({
          prefix,
          newLines: [],
          streamingLines: null,
          footer: layoutFooter({
            input: '', cursor: 0, status: '', cols,
            suggestions: [], dropdownIndex: 0, viewportTop: 0,
          }),
          hasNewFinalized: false,
          transitions: { justFinalized: false, needEraseDraft: false },
        });
      }
      return;
    }

    // ── 2. 构建 Frame 数据（组件层只负责"渲染什么"，不含调用顺序）──
    // 新增固化行 → ANSI（renderFinalizedLine 负责 style + 折行）
    const newLines: string[] = [];
    for (const { role, line } of pendingLines) {
      const rendered = renderFinalizedLine(role, line, cols);
      for (const r of rendered) newLines.push(r);
    }
    // 更新渲染账本（每个消息已渲染行数）
    for (const msg of finalizedMessages) {
      state.setRenderedLineCount(msg.uuid, msg.lines.length);
    }

    // 流式草稿 → ANSI（trimmed 版：只显示完整行，对标 Claude Code 机制二）
    // 守卫 streamingText !== undefined：cooldown 中 throttled 值可能滞后于真实状态，
    // 用旧值渲染不冲突；但 isStreamingNow（基于 messages 真实状态）为 true 时
    // 若 throttled 尚未 flush，跳过草稿绘制避免用过期 undefined。
    let draftLines: string[] | null = null;
    if (isStreamingNow && streamingText !== undefined) {
      draftLines = last.role === 'thinking'
        ? wrapThinkingTextTrimmed(streamingText, cols)
        : wrapStreamingTextTrimmed(streamingText, cols);
    }
    // 更新流式状态标志（供下一帧检测转换）
    prevLastFinalizedRef.current = !isStreamingNow;

    // Footer 数据组装（statusText + 视口；spinner 不在 footer 内）
    const barWidth = 10;
    const pct = Math.max(0, Math.min(1, statusData.contextPct));
    const filled = Math.round(pct * barWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
    const pctLabel = `${Math.round(pct * 100)}%`;
    const statusText = colorizeStatus({
      mode: statusData.mode,
      model: statusData.model,
      dir: statusData.dir,
      branch: statusData.branch,
      context: `${bar} ${pctLabel}`,
    });

    // spinner 可见性：纯函数判定（见 spinner-visibility.ts）。
    // 关键：assistant 正文固化(finalized)后立即隐藏，不等 stopSpinner——
    // 否则在 finalize→stop 窗口内会闪烁一帧残影。
    const spinnerVisible = computeSpinnerVisible({
      spinnerActive: spinnerView.active,
      isStreamingNow,
      streamingText,
      lastRole: last?.role ?? '',
      lastFinalized: last?.finalized ?? false,
    });
    const spinnerLines = spinnerVisible
      ? buildSpinnerLines(spinnerView, cols)
      : [];

    // 草稿区只含文本（thinking/正文 trimmed），不含 spinner——spinner 在 footer 预留位。
    const streamingLines = draftLines;

    const suggestions = (dropdownVisible && dropdownCandidates.length > 0) ? dropdownCandidates : [];
    const totalInputLines = inputText.split('\n').length;
    const cursorLine = cursorScreenPos(inputText, cursor, '❯ ').y;
    const vp = computeInputViewport(totalInputLines, cursorLine, MAX_VISIBLE_INPUT_LINES);

    // ── 3. footer 布局计算（含顶部 2 行预留位 + spinner）──
    // Select 可见时:组装 selectView(替换整个 footer),不传 suggestions/spinner/input
    const selectView = selectVisible && selectOptions.length > 0
      ? buildSelectView(selectTitle, selectOptions, selectIndex, cols)
      : null;

    const footerLayout = layoutFooter({
      input: inputText, cursor, status: statusText, cols, rows,
      suggestions, dropdownIndex, viewportTop: vp.viewportTop,
      spinnerLines,
      selectView,
    });

    // ── 4. commit：一个 BSU/ESU 原子块处理全部渲染 ──
    // commit 是唯一 stdout 出口：prefix（logo/clear）+ appendLine（固化）+
    // rewriteStreamingLines（草稿+spinner 统一覆写）+ writeFooter（footer 覆写）→ 一次 write

    // 检测 Select 开关切换 → forceFooterReset(擦除旧 footer,避免高度不一致覆写错位)
    const selectToggled = prevSelectVisibleRef.current !== selectVisible;
    prevSelectVisibleRef.current = selectVisible;

    renderer.commit({
      prefix: prefix.length > 0 ? prefix : undefined,
      newLines,
      streamingLines,
      footer: footerLayout,
      hasNewFinalized,
      transitions: { justFinalized, needEraseDraft, forceFooterReset: selectToggled },
    });
  // cols 在依赖数组：resize 时 effect 重跑，footer 用新 cols 布局（border 自适应）。
  }, [messages, renderer, inputText, cursor, statusData, spinnerView, logo, streamingText, overlay.visible, dropdownVisible, dropdownCandidates, dropdownIndex, selectVisible, selectTitle, selectOptions, selectIndex, cols]);

  // 返回空元素——所有渲染通过 stdout 副作用完成
  return <></>;
}
