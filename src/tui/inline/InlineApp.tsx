// src/tui/inline/InlineApp.tsx
// Inline 模式的根组件：统一控制所有 stdout 写入顺序。
// 物理本质：Logo → 消息 → Footer，全部在一个 useEffect 中按序写入，
// 消除多个 useEffect 竞争 stdout 导致的覆盖问题。

import React, { useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { InlineRenderer } from './InlineRenderer.js';
import { colorizeLogo, colorizeStatus, colorizeStyled, RESET, magentaBright, redBright, cyanBright } from './colors.js';
import { sgr } from './ansi-utils.js';
import { highlightLine } from './token-highlight.js';
import { SPINNER_FRAMES } from '../state/spinner-store.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { FormattedLine } from '../../ui/types.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';
import type { OverlayStore } from '../state/overlay-store.js';

/** ● 前缀（assistant 流式首行，白色——和正文统一） */
const STREAM_PREFIX = '● ';
/** 续行缩进（与 ● 后内容对齐：● 占 1 列 + 空格 1 列 = 2 列） */
const CONTINUATION_INDENT = '  ';

/**
 * 计算字符串的显示宽度（CJK 全角=2，其余=1）。
 * 复用 strip-ansi 去除 ANSI 序列后按码点判断。
 */
function displayWidth(text: string): number {
  // 去 ANSI 序列
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK 统一表意、全角标点等 → 2 列（简化判定：常见 CJK 区间）
    if (
      (code >= 0x1100 && code <= 0x115f) ||  // 韩文
      (code >= 0x2e80 && code <= 0x303e) ||  // CJK 部首/标点
      (code >= 0x3040 && code <= 0x33bf) ||  // 假名/谚文/注音
      (code >= 0x3400 && code <= 0x4dbf) ||  // CJK 扩展 A
      (code >= 0x4e00 && code <= 0xa4cf) ||  // CJK 统一表意
      (code >= 0xac00 && code <= 0xd7af) ||  // 韩文音节
      (code >= 0xf900 && code <= 0xfaff) ||  // CJK 兼容表意
      (code >= 0xfe30 && code <= 0xfe6f) ||  // CJK 兼容形式
      (code >= 0xff01 && code <= 0xff60) ||  // 全角 ASCII/标点
      (code >= 0xffe0 && code <= 0xffe6) ||  // 全角符号
      (code >= 0x20000 && code <= 0x3fffd)   // CJK 扩展 B-F
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * 把流式 assistant 文本折行，返回带样式的行数组（供 rewriteStreamingLines）。
 *
 * 物理本质：排版工人的「折纸」——把一长条文本按终端宽度折成多行。
 * 首行带 ● 前缀（白色），续行缩进 2 空格对齐。正文白底为主，文件路径/命令/包名蓝色，**bold** 加粗。
 *
 * @param text 流式累积的全文（已含 ● 前缀，由 pipeline-adapter 的 appendStreamingMarkdown 加）
 * @param cols 终端列宽
 * @returns 已上色的行数组（不含 \n）
 *
 * 注意：text 已由 pipeline-adapter 加了 ● 前缀（fullText = prefix + text），
 * 所以这里直接折行 + 上色，不再重复加前缀。
 */
export function wrapStreamingText(text: string, cols: number): string[] {
  // text 可能已含 ● 前缀（来自 adapter 的 fullText = '● ' + raw）
  // 统一处理：去掉已有前缀再重新加，保证首行前缀一致
  const raw = text.startsWith(STREAM_PREFIX) ? text.slice(STREAM_PREFIX.length) : text;

  // 列宽：首行减去前缀宽度（● + 空格 = 2 列），续行减去缩进宽度（2 列对齐 ● 后内容）
  const firstLineBudget = Math.max(1, cols - STREAM_PREFIX.length);
  const contLineBudget = Math.max(1, cols - CONTINUATION_INDENT.length);

  // 按已有的换行符先拆段，再按列宽折每段
  const paragraphs = raw.split('\n');
  const result: string[] = [];
  let isFirstLine = true;

  paragraphs.forEach((para) => {
    const budget = isFirstLine ? firstLineBudget : contLineBudget;
    const lines = foldLine(para, budget);
    lines.forEach((l) => {
      if (isFirstLine) {
        // 首行：● 前缀（白色）+ 高亮正文（白底蓝标）
        result.push(STREAM_PREFIX + highlightLine(l));
        isFirstLine = false;
      } else {
        // 续行：缩进 2 空格对齐 ● 后内容 + 高亮正文
        result.push(CONTINUATION_INDENT + highlightLine(l));
      }
    });
  });

  // 空文本兜底：至少一行 ●
  if (result.length === 0) {
    result.push(STREAM_PREFIX);
  }
  return result;
}

/**
 * 把流式 thinking 文本折行，返回灰色 dim 的行数组（供 rewriteStreamingLines）。
 *
 * 物理本质：草稿纸上的铅笔字——灰色 dim，2 空格缩进，无 ● 前缀。
 * 思考过程实时流式显示，结束后折叠为 Thought for Ns 摘要行。
 *
 * @param text 流式累积的思考全文
 * @param cols 终端列宽
 * @returns 已上色（dim）的行数组（不含 \n）
 */
export function wrapThinkingText(text: string, cols: number): string[] {
  if (text === '') return [colorizeStyled('  ', { dim: true })];
  const indent = '  '; // 2 空格缩进
  const budget = Math.max(1, cols - indent.length);
  const paragraphs = text.split('\n');
  const result: string[] = [];
  paragraphs.forEach((para) => {
    const lines = foldLine(para, budget);
    lines.forEach((l) => {
      result.push(colorizeStyled(indent + l, { dim: true }));
    });
  });
  return result.length > 0 ? result : [colorizeStyled(indent, { dim: true })];
}

/**
 * 把单条已固化的 FormattedLine 渲染成终端字符串数组（供 InlineRenderer.appendLine 逐行写入）。
 *
 * 物理本质：贴砖——补齐缩进 → 上色。assistant 长文本额外按终端宽度折行（续行缩进 2 空格）。
 *
 * 本函数从 InlineApp 的固化渲染循环抽出，是**唯一事实源**——测试直接调用它验证样式契约，
 * 而非在测试里复制逻辑（避免假测试）。
 *
 * @param role 消息角色（决定是否折行：仅 assistant 长文本折行）
 * @param line 已格式化的渲染行
 * @param cols 终端列宽
 * @returns 已上色、已折行的字符串数组（不含 \n）
 */
export function renderFinalizedLine(role: string, line: FormattedLine, cols: number): string[] {
  const leading = line.content.length - line.content.trimStart().length;
  const pad = leading < line.indent ? ' '.repeat(line.indent - leading) : '';
  const fullContent = pad + line.content;

  // assistant 正文行（● 前缀 + 长文本）：按终端宽度折行，白底蓝标高亮。
  // 其他行（thinking 摘要、⎿ 工具结果、system）用各自的语义样式。
  if (role === 'assistant' && line.content.startsWith(STREAM_PREFIX)
      && displayWidth(fullContent) > cols) {
    return wrapStreamingText(fullContent, cols);
  }
  // assistant 正文（短行）：白底蓝标（去掉品红 brand 样式）
  if (role === 'assistant' && line.content.startsWith(STREAM_PREFIX)) {
    return [STREAM_PREFIX + highlightLine(line.content.slice(STREAM_PREFIX.length))];
  }
  return [colorizeStyled(fullContent, line.style)];
}

/**
 * 把单行文本按显示宽度折成多行（CJK 感知）。
 * 在预算处断行，不拆分 CJK 字符（按字符完整断）。
 */
function foldLine(text: string, budget: number): string[] {
  if (text === '') return [''];
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const ch of text) {
    const chWidth = displayWidth(ch);
    if (currentWidth + chWidth > budget && current !== '') {
      lines.push(current);
      current = ch;
      currentWidth = chWidth;
    } else {
      current += ch;
      currentWidth += chWidth;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [''];
}

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
}

let logoRendered = false;

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
}: InlineAppProps): React.ReactElement {
  // renderedLinesRef 追踪「每个已固化消息已渲染到第几行」（uuid → 已渲染行数）。
  // 用 Map 而非消息计数：pipeline 的 ensureGap 会给已渲染过的消息「追加」行
  // （如 thinking_summary 消息在 assistant 首 delta 时被 appendLine 续接 gap 空行），
  // 按消息计数会跳过这些新增行；按行追踪则每次 effect 补写每个消息的新增行。
  const renderedLinesRef = useRef<Map<string, number>>(new Map());
  /** 上次 effect 看到的末条消息 finalized 状态，用于检测 streaming→finalized 转换 */
  const prevLastFinalizedRef = useRef<boolean | undefined>(undefined);

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
  const completionVisible = useStore(completionStore, (s) => s.visible);
  // overlay（ctrl+o 备用屏）：visible 时渲染覆盖层，替代正常输出
  const overlay = useStore(overlayStore, useShallow((s) => ({
    visible: s.visible, title: s.title, lines: s.lines,
  })));
  /** 追踪 overlay 上一帧的 visible 状态（检测 打开→关闭 转换，触发重绘） */
  const overlayWasVisibleRef = useRef(false);

  // overlay 渲染：visible 时进备用屏显示内容（最高优先级，独立 effect）
  useEffect(() => {
    const cols = process.stdout.columns ?? 80;

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
  }, [overlay, renderer]);

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
    const cols = process.stdout.columns ?? 80;

    // overlay 打开时：主渲染 effect 跳过（不与 overlay 竞争 stdout）
    if (overlay.visible) return;

    // ── 1. 已固化的新消息：增量追加写入 ──
    // 遍历所有已固化消息，对每个只渲染「上次之后新增的行」。
    // 这样 pipeline 给已渲染消息追加行（如 ensureGap 给 thinking_summary 续接 gap 空行）
    // 时，新增行也会被补写到 stdout。
    const finalizedMessages = messages.filter(m => m.finalized);
    const renderedMap = renderedLinesRef.current;
    // 收集每个消息待渲染的新增行（按消息顺序）
    const pendingLines: { role: string; line: FormattedLine }[] = [];
    for (const msg of finalizedMessages) {
      const rendered = renderedMap.get(msg.uuid) ?? 0;
      for (let i = rendered; i < msg.lines.length; i++) {
        pendingLines.push({ role: msg.role, line: msg.lines[i]! });
      }
    }
    const hasNewFinalized = pendingLines.length > 0;
    const hasAnyContent = messages.length > 0 || inputText.length > 0;

    // 无消息且无输入时，不绘制 footer（避免首次启动时多余的空 footer）
    if (!hasAnyContent && !hasNewFinalized && renderedMap.size === 0 && !streamingText) {
      return;
    }

    const last = messages[messages.length - 1];
    const isStreamingNow = last && !last.finalized && last.streamingText !== undefined;

    // 流式→固化转换检测：上一帧在流式，本帧不在流式 → 刚固化
    const justFinalized = prevLastFinalizedRef.current === false && !isStreamingNow;
    // 上一帧在流式（thinking），本帧有新固化消息（Thought for）——即使 assistant 已开始流式，
    // 也需要先擦除 thinking 草稿再写固化内容。覆盖 justFinalized 漏掉的同批次场景。
    const needEraseDraft = (justFinalized || (hasNewFinalized && prevLastFinalizedRef.current === false));

    // 转换时：先 commit footer（清除 footer 让光标回到草稿下方），
    // 再 eraseStreamingLines（擦除草稿行，让 appendLine 从草稿原位置写固化内容）。
    // 顺序关键：必须先 commit footer（否则光标在 footer 内，erase 的 cursorUp 会算错）。
    if (justFinalized || hasNewFinalized) {
      renderer.commitFooter();
    }
    if (needEraseDraft) {
      // 物理擦除流式草稿行（lastStreamingHeight → 0）。
      // 之后 appendLine 从草稿原位置写入固化内容（Thought for + gap），
      // 再之后流式 rewriteStreamingLines 是首次追加模式（height=0），不覆盖已写入内容。
      renderer.eraseStreamingLines();
    }

    // 逐行渲染新增的固化行（尊重每行 FormattedLine 的 style + indent）
    // 块间空行 gap 由 block-pipeline 的 openModelBlock/ensureGap 负责。
    for (const { role, line } of pendingLines) {
      const rendered = renderFinalizedLine(role, line, cols);
      for (const r of rendered) {
        renderer.appendLine(r);
      }
    }
    // 更新每个消息的已渲染行数
    for (const msg of finalizedMessages) {
      renderedMap.set(msg.uuid, msg.lines.length);
    }
    // 更新每个消息的已渲染行数
    for (const msg of finalizedMessages) {
      renderedMap.set(msg.uuid, msg.lines.length);
    }

    // ── 2. 流式文本：覆写草稿行（逐字显示）──
    // assistant → 白底蓝标（wrapStreamingText）；thinking → 灰色 dim（wrapThinkingText）
    if (isStreamingNow) {
      // 流式中：先 commit footer（清除 footer，让光标回到草稿正下方），
      // 否则 rewriteStreamingLines 的 cursorUp 会算错位置（光标在 footer 内而非草稿下）。
      // needEraseDraft 时已在上面 commit 过 + erase 过，跳过。
      if (!justFinalized && !needEraseDraft) {
        renderer.commitFooter();
      }
      // 仅在固化→流式转换时清零草稿高度。
      // 转换路径（thinking 结束 → assistant 开始）：上面已 appendLine 写入固化内容
      // （Thought for + gap），草稿区必须从追加模式重新开始，否则 rewriteStreamingLines
      // 的 cursorUp 会覆写刚写入的固化行。eraseStreamingLines 已把 height 设 0，这里追加保险。
      //
      // 连续流式 delta（非转换路径）绝不能清零——lastStreamingHeight 是覆写状态机的
      // 记忆：首次 delta 追加后 height=1，后续 delta 据 height cursorUp 回顶部逐行擦写。
      // 若每次 delta 都清零，rewriteStreamingLines 永远走「首次追加」分支，
      // 导致每个 delta 的完整文本向下堆叠（用户症状：流式内容逐行重复而非原地更新）。
      if (justFinalized || needEraseDraft) {
        renderer.clearStreamingHeight();
      }
      const displayLines = last.role === 'thinking'
        ? wrapThinkingText(last.streamingText!, cols)
        : wrapStreamingText(last.streamingText!, cols);
      renderer.rewriteStreamingLines(displayLines);
      prevLastFinalizedRef.current = false;
    } else {
      prevLastFinalizedRef.current = true;
    }

    // ── 3. 绘制 Footer（含 spinner 状态）──
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
    // spinner 行：active 时显示 braille 帧 + label。
    // 用 cyanBright（青色）+ bold 区别于状态栏其他段，更独特显眼。
    // stalled（3s 无 token）时转红色警示。
    // 放在状态栏首段（footer 高度恒定，避免 topLine 抖动导致覆写错乱）。
    let spinnerLine = '';
    if (spinner.active) {
      const frame = SPINNER_FRAMES[spinner.frameIndex % SPINNER_FRAMES.length];
      const color = spinner.stalled ? redBright : cyanBright;
      const bold = sgr('1');
      spinnerLine = `${bold}${color}${frame} ${spinner.label}${RESET}`;
    }
    const completionLine = completionVisible ? '...' : '';
    const fullStatus = [spinnerLine, statusText, completionLine].filter(Boolean).join(' │ ');
    renderer.renderFooter(inputText, cursor, fullStatus, cols);
  }, [messages, renderer, inputText, cursor, statusData, spinner, completionVisible, logo, streamingText, overlay.visible]);

  // 卸载时 commit footer
  useEffect(() => {
    return () => { renderer.commitFooter(); };
  }, [renderer]);

  // 返回空元素——所有渲染通过 stdout 副作用完成
  return <></>;
}
