// src/tui/inline/InlineApp.tsx
// Inline 模式的根组件：统一控制所有 stdout 写入顺序。
// 物理本质：Logo → 消息 → Footer，全部在一个 useEffect 中按序写入，
// 消除多个 useEffect 竞争 stdout 导致的覆盖问题。

import React, { useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { InlineRenderer } from './InlineRenderer.js';
import { InlineGridRenderer } from './grid-renderer.js';
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
  /** grid 渲染器：footer 双缓冲 + 绝对坐标定位（resize 免疫） */
  gridRenderer: InlineGridRenderer;
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

let logoRendered = false;

export function InlineApp({
  messages,
  status: _status,
  logo,
  renderer,
  gridRenderer,
  messagesStore,
  inputStore,
  statusStore,
  spinnerStore,
  completionStore,
  overlayStore,
  cols,
}: InlineAppProps): React.ReactElement {
  // 消息渲染账本（uuid → 已渲染行数）已迁移到 renderer.state.renderedLines（Phase 1 统一状态）。
  /** 上次 effect 看到的末条消息 finalized 状态，用于检测 streaming→finalized 转换 */
  const prevLastFinalizedRef = useRef<boolean | undefined>(undefined);
  /** 上次 effect 看到的 cols，用于检测 resize 触发显式 footer 清除 */
  const prevColsRef = useRef<number>(cols);

  // Logo 同步写入（首次渲染时），确保在所有 useEffect 之前出现在 stdout
  if (!logoRendered) {
    logoRendered = true;
    const lines = [
      ` ▐▛███▜▌   MiCode v${logo.version}`,
      '▝▜█████▛▘  TypeScript CLI · Node.js Runtime',
      `  ▘▘ ▝▝    ${logo.dir}`,
    ];
    for (const line of lines) {
      renderer.appendLine(colorizeLogo(line));
    }
  }

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
      // 主屏的 scrollback 和 footer 进入 overlay 前是什么样，退出后还是什么样。
      overlayWasVisibleRef.current = false;
      renderer.exitOverlay();
    }
  }, [overlay, renderer]); // cols 不在依赖：resize 不主动重画（ConPTY 兼容性，见主 effect 注释）

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

    // ── 0. Resize 检测：cols 变化 → gridRenderer 清旧 footer + 下一帧全量重画 ──
    if (cols !== prevColsRef.current) {
      gridRenderer.clearForResize();
      prevColsRef.current = cols;
    }

    // ── 1. 收集新增固化行（渲染账本在 renderer.state.renderedLines）──
    const finalizedMessages = messages.filter(m => m.finalized);
    const state = renderer.state;
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
      return;
    }

    const last = messages[messages.length - 1];
    const isStreamingNow = last && !last.finalized && last.streamingText !== undefined;

    // 状态转换信号（用于 commit 内部决定 commitFooter/erase/clearStreamingHeight 调用）
    const justFinalized = prevLastFinalizedRef.current === false && !isStreamingNow;
    const needEraseDraft = (justFinalized || (hasNewFinalized && prevLastFinalizedRef.current === false));

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

    // ── 4. 新消息/流式转换时：先擦旧 footer 让位 ──
    // gridRenderer.clearForResize 擦掉旧 footer 区域（CUP + ED），
    // 让光标回到旧 footer 顶，appendLine 从该位置写新消息（把旧内容推进 scrollback）。
    // 流式草稿的 eraseStreamingLines 也在 commit 内部处理（需要 footer 已擦）。
    if (hasNewFinalized || justFinalized || needEraseDraft) {
      gridRenderer.clearForResize();
    }

    // ── 5. 提交：commit 负责 appendLine + 流式草稿（不含 footer）──
    renderer.commit({
      newLines,
      streamingLines,
      footer: footerLayout,
      hasNewFinalized,
      transitions: { justFinalized, needEraseDraft },
    });

    // ── 6. Footer 由 gridRenderer 用双缓冲 + 绝对坐标渲染 ──
    const rows = process.stdout.rows ?? 24;
    gridRenderer.commitFooter(footerLayout, rows, cols);
  }, [messages, renderer, gridRenderer, inputText, cursor, statusData, spinner, logo, streamingText, overlay.visible, dropdownVisible, dropdownCandidates, dropdownIndex, cols]);

  // 卸载时清理 footer（生命周期清理，非内容渲染——属于 Renderer 生命周期管理）
  useEffect(() => {
    return () => { gridRenderer.dispose(); };
  }, [gridRenderer]);

  // 返回空元素——所有渲染通过 stdout 副作用完成
  return <></>;
}
