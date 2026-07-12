// src/tui/state/input-viewport.ts
// 输入框视口窗口计算：固定高度 + 光标居中 + 边界钳位。
//
// 物理本质：多行文本上的「取景器」。
// 文本可能任意长（用户 Ctrl+J 插入任意多个 \n），但 footer 固定只显示 MAX_VISIBLE_INPUT_LINES 行。
// 光标是相机焦点，视口跟着光标走，光标始终落在窗口中央偏上。
// 历史区大小永远稳定（不被输入撑动）——这是与旧「动态 footer 高度」设计的根本区别。
//
// 复用至上：不造新滚动算法，直接组合 scroll-state.ts 的 computeScrollState + clampScrollTop
// （与历史消息列表、下拉菜单同一套钳位逻辑，单一真理源）。

import { computeScrollState, clampScrollTop } from '../components/scroll-state.js';
import stringWidth from 'string-width';

/** Footer 输入框固定显示的最大行数。超过则启用视口滚动。 */
export const MAX_VISIBLE_INPUT_LINES = 5;

export interface InputViewport {
  /** 输入文本总行数 */
  totalLines: number;
  /** 视口高度（固定 = MAX_VISIBLE_INPUT_LINES） */
  maxVisibleLines: number;
  /** 视口顶部在总行数中的索引（0-based）。切片区间 [viewportTop, viewportTop + maxVisibleLines) */
  viewportTop: number;
  /** 最大滚动上限 = max(0, totalLines - maxVisibleLines) */
  maxScroll: number;
}

/**
 * 计算输入框视口窗口。
 *
 * 算法（光标居中滚动，对齐下拉菜单 InlineRenderer.ts:62-67 同款公式）：
 *   1. maxScroll = max(0, total - maxVisible)
 *   2. 居中起点 = cursorLine - floor(maxVisible / 2)
 *   3. viewportTop = clamp(居中起点, 0, maxScroll)
 *
 * 不变量（由 clampScrollTop 保证）：
 *   - viewportTop ∈ [0, maxScroll]
 *   - 光标始终在 [viewportTop, viewportTop + maxVisibleLines) 内
 *
 * @param totalLines 输入文本总行数（input.split('\n').length）
 * @param cursorLine 光标所在行（0-based，相对输入区第 0 行；来自 cursorScreenPos().y）
 * @param maxVisibleLines 视口高度（默认 MAX_VISIBLE_INPUT_LINES）
 */
export function computeInputViewport(
  totalLines: number,
  cursorLine: number,
  maxVisibleLines: number = MAX_VISIBLE_INPUT_LINES,
): InputViewport {
  const state = computeScrollState({ total: totalLines, visibleRows: maxVisibleLines, scrollTop: 0 });
  const centered = cursorLine - Math.floor(maxVisibleLines / 2);
  const viewportTop = clampScrollTop(centered, state.maxScroll);
  return {
    totalLines,
    maxVisibleLines,
    viewportTop,
    maxScroll: state.maxScroll,
  };
}

/**
 * 计算单行文本按终端宽度折算后的物理行数（CJK 感知）。
 *
 * 物理本质：终端原生会按列宽自动折行，CJK 占 2 列。应用层不做 word wrap（不改输入文本），
 * 但必须按物理行数记账（footerHeight），否则覆写时 cursorUp 不够 → border 残影。
 *
 * 算法（贪婪字符级折行，对齐 InlineApp.tsx foldLine）：
 *   - 首行 budget = cols - firstLinePrefix（如 prompt '❯ ' 占 2 列）
 *   - 后续行 budget = cols
 *   - 逐字符累加 stringWidth，超出 budget 则换行
 *   - 至少 1 行（空文本也算 1 行）
 *
 * @param line 单行文本（不含 \n）
 * @param cols 终端列数
 * @param firstLinePrefix 首行前缀占的列数（prompt 或续行缩进），默认 0
 */
export function physicalLineCount(text: string, cols: number, firstLinePrefix: number = 0): number {
  const lines = text.split('\n');
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 每行都有前缀（首行 prompt，续行缩进），宽度都是 firstLinePrefix。
    const budget = Math.max(1, cols - firstLinePrefix);
    const width = stringWidth(line);
    total += Math.max(1, Math.ceil(width / budget));
  }
  return total;
}

/**
 * 计算光标所在物理行（0-based，相对整个输入文本的物理行）。
 *
 * 用于光标定位：footerHeight 按物理行算账后，光标上移量也必须按物理行算。
 *
 * 算法：逐逻辑行消费码点，累计物理行；定位到光标所在逻辑行后，再在该行内按 budget 折算。
 *
 * @param text 完整输入文本（可能多行）
 * @param cursor 光标码点索引（0-based）
 * @param cols 终端列数
 * @param promptWidth 首行 prompt 宽度（续行缩进与 prompt 等宽，故统一用此值）
 */
export function physicalLineOfCursor(text: string, cursor: number, cols: number, promptWidth: number): number {
  const lines = text.split('\n');
  const c = Math.max(0, Math.min(cursor, [...text].length));
  let physLine = 0;
  let remaining = c;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineCpLen = [...line].length;
    if (remaining <= lineCpLen) {
      // 光标在第 i 逻辑行：在该行内按 budget 折算物理行偏移
      const budget = Math.max(1, cols - promptWidth);
      const beforeCursor = [...line].slice(0, remaining).join('');
      const colInLine = stringWidth(beforeCursor);
      return physLine + Math.floor(colInLine / budget);
    }
    // 光标在后续行：累加本逻辑行的物理行数
    const budget = Math.max(1, cols - promptWidth);
    const width = stringWidth(line);
    physLine += Math.max(1, Math.ceil(width / budget));
    remaining -= lineCpLen + 1; // +1 跳过 \n
  }
  return physLine;
}

/** simulateTerminalWrap 返回的折行结果 */
export interface TerminalWrapResult {
  /** 总物理行数（≥1） */
  physRows: number;
  /** 光标（文本末尾）所在物理行（0-based） */
  cursorRow: number;
  /** 光标在当前物理行内的列（0-based，含 prompt 前缀的累计列） */
  cursorCol: number;
}

/**
 * @deprecated DECAWM OFF 后不再需要终端折行模拟。
 * 用 `wrapLine`（src/tui/state/wrap-line.ts）替代——应用层自己做 wordWrap，
 * physical rows = application wrapped rows，不依赖终端 DECAWM 行为。
 * 本函数表达的是"猜测终端折行"的错误模型，保留仅供旧测试参考。
 *
 * 精确模拟终端折行，返回物理行数 + 光标位置。
 *
 * 物理本质：终端逐字符放置，CJK（2列）放不下当前行剩余空间时**留空换行**（不劈字）。
 * 简单的 ceil(width/cols) 不考虑留空，对 CJK 不准——每折一次行光标可能差 1 列，
 * 累积导致光标定位偏移（用户看到的"光标在文字中间"）。
 *
 * 算法（逐码点放置）：
 *   - 首行 budget = cols - promptWidth（prompt 占位）
 *   - 续行 budget = cols（无前缀）
 *   - 逐字符累加 stringWidth，col + w > budget 时换行（col 归零，rows++）
 *   - 光标在最后一个字符之后
 *
 * @param text 单行文本（不含 \n）。多行需调用方逐行处理。
 * @param cols 终端列数
 * @param promptWidth 首行前缀宽度（prompt/缩进），续行无前缀
 */
export function simulateTerminalWrap(text: string, cols: number, promptWidth: number): TerminalWrapResult {
  const chars = [...text];
  const firstBudget = Math.max(1, cols - promptWidth);
  let row = 0;
  let col = promptWidth; // 首行从 prompt 之后开始放
  let budget = firstBudget;
  // col 是当前物理行已占的列数（含 prompt，范围 [promptWidth..cols]）
  // 用 contentCol 跟踪不含 prompt 的内容列，便于判断 budget
  let contentCol = 0;
  for (let i = 0; i < chars.length; i++) {
    // 跳过 ANSI 转义序列：\x1b[...<letter>（SGR 颜色码等，零显示宽度）。
    // 不跳过的话，[、数字、字母会被 stringWidth 算成 1 列，导致含颜色的行
    // physRows 虚高 → footerHeight 偏大 → cursorUp 偏移 → 光标漂移。
    if (chars[i] === '\x1b') {
      let j = i + 1;
      // CSI 序列：\x1b[ + params(0-9;) + 终止字母
      if (chars[j] === '[') {
        j++;
        while (j < chars.length && /[0-9;]/.test(chars[j]!)) j++;
        if (j < chars.length && /[A-Za-z]/.test(chars[j]!)) j++;
      } else {
        // OSC 等其他序列：跳到 BEL 或 ST(\x1b\)
        while (j < chars.length && chars[j] !== '\x07' && chars[j] !== '\x1b') j++;
        if (j < chars.length && chars[j] === '\x07') j++;
      }
      i = j - 1; // for 循环会 i++，故 -1
      continue;
    }
    const w = stringWidth(chars[i]!);
    if (contentCol + w > budget) {
      // 放不下：留空当前行剩余空间，换行
      row++;
      contentCol = 0;
      budget = cols; // 续行满宽
      col = 0;
    }
    contentCol += w;
    col += w;
  }
  // cursorCol：光标在当前物理行的列（0-based，含 prompt 偏移）。
  // 首行 col 含 promptWidth 起始；续行 col 从 0 开始。
  const cursorCol = col;
  return {
    physRows: row + 1,
    cursorRow: row,
    cursorCol,
  };
}
