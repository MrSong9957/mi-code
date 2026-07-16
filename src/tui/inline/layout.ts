// src/tui/inline/layout.ts
// Layout Layer：纯函数布局计算，无 stdout.write / 无 ANSI cursor / 无副作用。
//
// Phase 2：把"计算显示内容"从"执行终端写入"分离。
// 此模块负责所有布局纯计算（wordWrap / border 生成 / footer 拼接 / 行数 / 光标定位参数），
// Renderer 只消费 LayoutResult 写 stdout。
//
// 设计原则：
// - 输入：messages / input / status / terminal width / render state
// - 输出：LayoutResult（已组装的行数组 + 行数 + 光标参数）
// - 禁止：stdout.write / cursorUp / EL / DL / 任何终端副作用

import { wrapLine, getUsableWidth } from '../state/wrap-line.js';
import { layoutInputCursor } from '../state/layout-cursor.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import { MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { computeInputViewport } from '../state/input-viewport.js';
import { renderFinalizedLine, wrapStreamingText, wrapThinkingText, displayWidth } from './text-layout.js';
import sliceAnsi from 'slice-ansi';
import type { FormattedLine } from '../../ui/types.js';
import type { SuggestionItem } from '../../commands/suggestion-data.js';
import { getTheme } from '../../utils/theme.js';
import { resolveSGR, RESET as THEME_RESET } from '../../utils/theme-resolve.js';

const PROMPT = '❯ ';
const CONTINUATION_INDENT = '  ';

/**
 * footer 布局输入参数（由组件层从 status/spinner/input 组装）。
 * 不含 ANSI cursor 操作，只含"要显示什么"。
 */
export interface FooterInput {
  input: string;
  cursor: number;
  status: string;
  cols: number;
  /** 终端行数(用于下拉菜单动态高度)。0 或未传时回退到默认上限。 */
  rows?: number;
  suggestions: SuggestionItem[];
  dropdownIndex: number;
  viewportTop: number;
  /** spinner 行 ANSI（显示在 footer border 上方的预留位）。
   *  null/undefined = 无 spinner（预留位留空）。始终保留 2 行（间距 + spinner 位）。 */
  spinnerLine?: string | null;
  /** Select 界面(交互式选择器)。可见时替换整个 footer(标题+列表+提示)。 */
  selectView?: SelectView | null;
}

/** Select 界面布局数据(预渲染 ANSI 行) */
export interface SelectView {
  /** 标题行 ANSI(如 "Select model") */
  title: string;
  /** 选项行 ANSI(已含高亮/dim) */
  items: string[];
  /** 快捷键提示行 ANSI(如 "↑↓ navigate · Enter confirm · Esc cancel") */
  hint: string;
}

/**
 * footer 布局结果：已组装的完整 footer + 行数 + 光标定位参数。
 *
 * - lines：完整 footer 行序（border / 输入行 / suggestion / border / status），
 *          每行已 wordWrap + 截断到 usableWidth，可直接写入 stdout。
 * - height：footer 物理行数（= lines.length）。
 * - cursorToTop：光标所在物理行到 footer 块顶的距离（供 Renderer cursorUp 定位）。
 * - cursorCol：光标在物理行内的列（0-based，供 Renderer CHA 1-based 定位）。
 */
export interface FooterLayout {
  lines: string[];
  height: number;
  cursorToTop: number;
  cursorCol: number;
  /** usableWidth（cols - 1），供 Renderer CHA 钳位光标列 */
  usableWidth: number;
  /** Select 界面标志:每次 writeFooter 前先 commitFooter 清屏再 appendLine(避免覆写错位) */
  isSelect?: boolean;
}

/**
 * 完整布局结果：一帧渲染的全部计算结果。
 *
 * - newLines：新增固化消息行（已 renderFinalizedLine 转 ANSI）。
 * - streamingLines：流式草稿行（已 wrapStreamingText/wrapThinkingText 转 ANSI），null=不流式。
 * - footer：footer 布局结果。
 */
export interface LayoutResult {
  newLines: string[];
  streamingLines: string[] | null;
  footer: FooterLayout;
}

/**
 * 组装 footer status 文本（context bar + mode/model/dir/branch）。
 *
 * 纯函数：输入 statusData → 输出已上色的 status 字符串。
 * 由组件层调用（需要 statusData + spinner 数据），结果传给 layoutFooter。
 */

/**
 * 计算 footer 布局：border / 输入行 wordWrap / suggestion 截断 / status wordWrap / 光标定位。
 *
 * 纯函数：输入 footer 数据 + cols → 输出完整 footer 行序 + 光标参数。
 * 无 stdout.write，无副作用。
 */
export function layoutFooter(fi: FooterInput): FooterLayout {
  const { input, cursor: cursorPos, status, cols, rows, suggestions, dropdownIndex, viewportTop, spinnerLine, selectView } = fi;

  // ── Select 模式:替换整个 footer(标题 + 列表 + 提示) ──
  // 不渲染预留位/border/输入框/status。footerHeight 自动管理,退出时 cursorUp 覆写自动擦除。
  if (selectView) {
    const usableWidth = getUsableWidth(cols);
    const lines: string[] = [
      sliceAnsi(selectView.title, 0, usableWidth),
      '',
      ...selectView.items.map(item => sliceAnsi(item, 0, usableWidth)),
      '',
      sliceAnsi(selectView.hint, 0, usableWidth),
    ];
    return {
      lines,
      height: lines.length,
      // Select 模式无输入框,光标定位不需要(光标隐藏)
      cursorToTop: 0,
      cursorCol: 0,
      usableWidth,
      isSelect: true,
    };
  }

  const inputLines = input.split('\n');
  const usableWidth = getUsableWidth(cols);
  const border = '─'.repeat(usableWidth);

  // 算光标所在逻辑行号
  const { y: cursorAbsLine } = cursorScreenPos(input, cursorPos, PROMPT);

  // 视口切片
  const visibleInputLines = inputLines.slice(
    viewportTop,
    viewportTop + MAX_VISIBLE_INPUT_LINES,
  );

  // suggestion 可见窗口（居中滚动）
  // 动态高度:终端行数 - 预留(输入框区域 ~5 行:预留位2 + border1 + 输入1 + 留白1)
  // 上限不硬编码,让菜单占满可用空间(对标 Claude Code 的"半屏"效果)
  const SUGGESTION_RESERVE = 5; // 输入框+border+预留位+留白
  const maxByTerminal = rows ? Math.max(1, rows - SUGGESTION_RESERVE) : 8;
  const maxVisible = Math.min(suggestions.length, maxByTerminal);
  const startIndex = Math.max(0, Math.min(
    dropdownIndex - Math.floor(maxVisible / 2),
    suggestions.length - maxVisible,
  ));
  const visibleSuggestions = suggestions.slice(startIndex, startIndex + maxVisible);

  // 命令名列宽度:所有可见候选的最大宽度 + padding,上限终端 40%(对标 Claude Code)
  const SUGGESTION_LEFT_PAD = 2; // paddingX={2}
  const nameMaxWidth = Math.min(
    Math.max(...visibleSuggestions.map(s => displayWidth('/' + s.name)), 0) + 3,
    Math.floor(usableWidth * 0.4),
  );
  const theme = getTheme();
  const suggestionSGR = resolveSGR(theme, 'suggestion');
  const suggestionLines: string[] = visibleSuggestions.map((item, i) => {
    const actualIndex = startIndex + i;
    const isSelected = actualIndex === dropdownIndex;

    // 命令名列:固定宽度对齐
    const nameStr = '/' + item.name;
    const namePad = ' '.repeat(Math.max(0, nameMaxWidth - displayWidth(nameStr)));
    const nameCol = nameStr + namePad;

    // 描述:参数提示 + 描述,截断到剩余宽度
    const argPart = item.argHint ? `${item.argHint} ` : '';
    const fullDesc = `${argPart}${item.description}`.replace(/\s+/g, ' ').trim();
    const descReserved = SUGGESTION_LEFT_PAD + nameMaxWidth + 2; // 左pad + 命令名列 + 2空格分隔
    const maxDescWidth = Math.max(0, usableWidth - descReserved);
    const desc = fullDesc ? fullDesc.slice(0, maxDescWidth) : '';

    const separator = desc ? '  ' : '';

    if (isSelected) {
      // 选中:整行 suggestion 主题色(对标 Claude Code,无箭头无背景色)
      return `${' '.repeat(SUGGESTION_LEFT_PAD)}${suggestionSGR}${nameCol}${separator}${desc}${THEME_RESET}`;
    }
    // 未选中:命令名正常色,描述 dim
    const dimDesc = desc ? `\x1b[2m${separator}${desc}\x1b[0m` : '';
    return `${' '.repeat(SUGGESTION_LEFT_PAD)}${nameCol}${dimDesc}`;
  });

  // 组装完整行序：预留位(2行) / border / 输入行(s) / [下拉行(s)] / [border / 状态]
  //
  // 下拉菜单可见时(对标 Claude Code footer 替换):
  // - 保留下 border(输入框边框始终可见)
  // - 不渲染状态行 → suggestion 替换状态行区域,占据 border 下方全部空间
  // - 终端原生滚动让菜单保持视野内
  //
  // 无下拉菜单时:正常渲染 border + 状态行
  // 预留位:spinner 可见时 2 行(1 间距 + 1 spinner),不可见时 1 行(仅间距)
  const lines: string[] = spinnerLine ? ['', spinnerLine, border] : ['', border];
  const wrappedInputCounts: number[] = [];
  for (let i = 0; i < visibleInputLines.length; i++) {
    const absLine = viewportTop + i;
    const prefix = absLine === 0 ? PROMPT : CONTINUATION_INDENT;
    const wrapped = wrapLine(prefix + visibleInputLines[i]!, usableWidth);
    wrappedInputCounts.push(wrapped.length);
    lines.push(...wrapped);
  }
  lines.push(border); // 下 border 始终渲染(输入框边框)
  for (const sl of suggestionLines) {
    lines.push(sliceAnsi(sl, 0, usableWidth));
  }
  // suggestion 可见时不渲染状态行(footer 替换模式)
  if (suggestionLines.length === 0) {
    const wrappedStatus = wrapLine(status, usableWidth);
    lines.push(...wrappedStatus);
  }

  // 光标物理行/列计算（纯函数，结果供 Renderer 写 cursorUp/CHA）
  // 预留位行数:spinner 可见时 2 行,不可见时 1 行
  const reserveRows = spinnerLine ? 2 : 1;
  let cursorPhysLine0 = reserveRows + 1; // 跳过预留位 + 顶部 border
  let cursorColInPhysLine = 0;
  for (let i = 0; i < visibleInputLines.length; i++) {
    const absLine = viewportTop + i;
    const prefix = absLine === 0 ? PROMPT : CONTINUATION_INDENT;
    if (absLine === cursorAbsLine) {
      const lines2 = input.split('\n');
      let off = 0;
      for (let j = 0; j < absLine; j++) off += [...lines2[j]!].length + 1;
      const cursorCpOffset = Math.max(0, cursorPos - off);
      const layout = layoutInputCursor(lines2[absLine]!, cursorCpOffset, prefix, usableWidth);
      cursorPhysLine0 += layout.row;
      cursorColInPhysLine = layout.col;
      break;
    }
    cursorPhysLine0 += wrappedInputCounts[i]!;
  }

  return {
    lines,
    height: lines.length,
    cursorToTop: cursorPhysLine0,
    cursorCol: cursorColInPhysLine,
    usableWidth,
  };
}

/**
 * 计算一帧的完整布局。
 *
 * 纯函数：输入 messages/input/footer 数据 + cols + render state（账本）→ 输出 LayoutResult。
 *
 * 注意：此函数会读写 render state 的 renderedLines 账本（getRenderedLineCount/setRenderedLineCount），
 * 但不写 stdout——账本是数据层操作，不是终端副作用。
 *
 * @param finalizeUpdates 若提供，函数会把更新后的行数写入此数组（供调用方 set 到 state）。
 *        这样保持"计算"和"写账本"分离——但 Phase 2 暂不强制，直接在 state 上读写。
 */
export interface LayoutInput {
  messages: { uuid: string; finalized: boolean; lines: FormattedLine[]; role: string }[];
  /** 末条流式消息（null=无流式） */
  streamingMsg: { role: string; streamingText: string } | null;
  /** footer 输入数据 */
  footer: FooterInput;
  /** terminal width */
  cols: number;
  /** render state（读 renderedLines 账本） */
  state: { getRenderedLineCount(uuid: string): number; setRenderedLineCount(uuid: string, n: number): void };
}

export function layoutFrame(input: LayoutInput): LayoutResult {
  const { messages, streamingMsg, footer, cols, state } = input;

  // ── 1. 新增固化行 → ANSI ──
  const finalizedMessages = messages.filter(m => m.finalized);
  const pendingLines: { role: string; line: FormattedLine }[] = [];
  for (const msg of finalizedMessages) {
    const rendered = state.getRenderedLineCount(msg.uuid);
    for (let i = rendered; i < msg.lines.length; i++) {
      pendingLines.push({ role: msg.role, line: msg.lines[i]! });
    }
  }
  const newLines: string[] = [];
  for (const { role, line } of pendingLines) {
    const rendered = renderFinalizedLine(role, line, cols);
    for (const r of rendered) newLines.push(r);
  }
  // 更新账本
  for (const msg of finalizedMessages) {
    state.setRenderedLineCount(msg.uuid, msg.lines.length);
  }

  // ── 2. 流式草稿 → ANSI ──
  const streamingLines = streamingMsg
    ? (streamingMsg.role === 'thinking'
        ? wrapThinkingText(streamingMsg.streamingText, cols)
        : wrapStreamingText(streamingMsg.streamingText, cols))
    : null;

  // ── 3. footer 布局 ──
  const footerLayout = layoutFooter(footer);

  return { newLines, streamingLines, footer: footerLayout };
}

/**
 * 计算 footer viewportTop（输入框视口居中滚动）。
 * 纯函数，供组件层在调 layoutFrame 前算好 viewportTop。
 */
export function computeFooterViewportTop(input: string, cursor: number): number {
  const totalInputLines = input.split('\n').length;
  const cursorLine = cursorScreenPos(input, cursor, PROMPT).y;
  return computeInputViewport(totalInputLines, cursorLine, MAX_VISIBLE_INPUT_LINES).viewportTop;
}
