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

import React, { useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { InlineRenderer } from './InlineRenderer.js';
import { colorizeLogo, colorizeStatus, RESET, magentaBright, redBright, cyanBright } from './colors.js';
import { sgr } from './ansi-utils.js';
import { SPINNER_FRAMES } from '../state/spinner-store.js';
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import { layoutFooter } from './layout.js';
import { renderFinalizedLine, wrapStreamingText, wrapThinkingText } from './text-layout.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { FormattedLine } from '../../ui/types.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
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
  selectionStore: SelectionStore;
  overlayStore: OverlayStore;
  /** 终端列宽（由 ConnectedApp 经 useTerminalSize 订阅后透传）。
   *  resize 时此 prop 变化 → 渲染 effect 依赖触发 → footer 重绘 + wordWrap 重算。 */
  cols: number;
}

/** 构建 logo 3 行的 ANSI 字符串（含 \n），供 prefix 使用 */
function buildLogoAnsi(logo: LogoData): string[] {
  return [
    colorizeLogo(` ▐▛███▜▌   MiCode v${logo.version}`) + '\n',
    colorizeLogo('▝▜█████▛▘  TypeScript CLI · Node.js Runtime') + '\n',
    colorizeLogo(`  ▘▘ ▝▝    ${logo.dir}`) + '\n',
  ];
}

export function InlineApp({
  messages,
  status: _status,
  logo,
  renderer,
  messagesStore,
  inputStore,
  statusStore,
  spinnerStore,
  completionStore,
  overlayStore,
  cols,
}: InlineAppProps): React.ReactElement {
  /** 上次 effect 看到的末条消息 finalized 状态，用于检测 streaming→finalized 转换 */
  const prevLastFinalizedRef = useRef<boolean | undefined>(undefined);
  /** 上次 effect 看到的 cols，用于检测 resize → 清屏重画 */
  const prevColsRef = useRef<number>(cols);
  /** logo 是否已输出（首次 effect 时输出，之后不再重复） */
  const logoRenderedRef = useRef(false);

  // 订阅 store 状态
  const inputText = useStore(inputStore, (s) => s.text);
  const cursor = useStore(inputStore, (s) => s.cursor);
  const statusData = useStore(statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));
  // spinner 完整状态：label/frameIndex/stalled（驱动状态栏动画）
  const spinner = useStore(spinnerStore, useShallow((s) => ({
    active: s.active, label: s.label, frameIndex: s.frameIndex, stalled: s.stalled,
  })));
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

  // overlay 渲染：visible 时进备用屏显示内容（最高优先级，独立 effect）
  useEffect(() => {
    if (overlay.visible) {
      // 打开：进入备用屏（终端自动保存主屏）+ 渲染 overlay 内容
      const textLines = overlay.lines.map(l => {
        const clean = l.content.replace(/\x1b\[[0-9;]*m/g, '');
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

  // 驱动 spinner 动画（inline 模式没挂载 Spinner.tsx，需自行 setInterval 推进帧）
  useEffect(() => {
    if (!spinner.active) return;
    const id = setInterval(() => { spinnerStore.getState().tick(); }, 120);
    return () => clearInterval(id);
  }, [spinner.active, spinnerStore]);

  // 末条消息的流式文本（驱动逐字渲染）
  const lastMsg = messages[messages.length - 1];
  const streamingText = lastMsg?.streamingText;

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

    // 流式草稿 → ANSI（wrapStreamingText / wrapThinkingText）
    const streamingLines = isStreamingNow
      ? (last.role === 'thinking'
          ? wrapThinkingText(last.streamingText!, cols)
          : wrapStreamingText(last.streamingText!, cols))
      : null;
    // 更新流式状态标志（供下一帧检测转换）
    prevLastFinalizedRef.current = !isStreamingNow;

    // Footer 数据组装（statusText + spinner + 视口）
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
    let spinnerLine = '';
    if (spinner.active) {
      const frame = SPINNER_FRAMES[spinner.frameIndex % SPINNER_FRAMES.length];
      const color = spinner.stalled ? redBright : cyanBright;
      const bold = sgr('1');
      spinnerLine = `${bold}${color}${frame} ${spinner.label}${RESET}`;
    }
    const fullStatus = [spinnerLine, statusText].filter(Boolean).join(' │ ');
    const suggestions = (dropdownVisible && dropdownCandidates.length > 0) ? dropdownCandidates : [];
    const totalInputLines = inputText.split('\n').length;
    const cursorLine = cursorScreenPos(inputText, cursor, '❯ ').y;
    const vp = computeInputViewport(totalInputLines, cursorLine, MAX_VISIBLE_INPUT_LINES);

    // ── 3. footer 布局计算（纯函数，Phase 2 抽离到 layout.ts）──
    const footerLayout = layoutFooter({
      input: inputText, cursor, status: fullStatus, cols,
      suggestions, dropdownIndex, viewportTop: vp.viewportTop,
    });

    // ── 4. commit：一个 BSU/ESU 原子块处理全部渲染 ──
    // commit 是唯一 stdout 出口：prefix（logo/clear）+ appendLine（固化）+
    // rewriteStreamingLines（草稿覆写）+ writeFooter（footer 覆写）→ 一次 write
    renderer.commit({
      prefix: prefix.length > 0 ? prefix : undefined,
      newLines,
      streamingLines,
      footer: footerLayout,
      hasNewFinalized,
      transitions: { justFinalized, needEraseDraft },
    });
  // cols 在依赖数组：resize 时 effect 重跑，footer 用新 cols 布局（border 自适应）。
  }, [messages, renderer, inputText, cursor, statusData, spinner, logo, streamingText, overlay.visible, dropdownVisible, dropdownCandidates, dropdownIndex, cols]);

  // 返回空元素——所有渲染通过 stdout 副作用完成
  return <></>;
}
