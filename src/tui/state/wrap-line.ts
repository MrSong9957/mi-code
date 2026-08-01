// src/tui/state/wrap-line.ts
//
// 应用层 wordWrap：按显示宽度折行，替代终端 DECAWM 自动折行。
//
// 物理本质：排版工人的「折纸」——把一长条文本按终端宽度折成多行。
// DECAWM OFF 后终端不自动折行，应用必须自己切行。
// 切出来的行数 = 物理行数（physical rows = application wrapped rows），完全可控。
//
// 混合策略（ChatGPT 建议）：
// - 英文优先按空格断行（不劈单词，空格本身丢弃不进入下一行）
// - CJK/无空格 token 按字符级断行（CJK 无天然空格，必须字符级）
//
// ANSI 处理：用 @alcalzone/ansi-tokenize 拆 token stream，保留 SGR 样式。
// 不 strip/re-slice——SGR 码跟着 token 走，颜色状态不污染。

import { tokenize, styledCharsFromTokens, styledCharsToString, type StyledChar } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';

/**
 * 统一可用宽度（留 1 安全列防 wrap pending state）。
 * 所有 footer 内容（border/input/status/suggestion）统一用此值。
 */
export function getUsableWidth(cols: number): number {
  return Math.max(1, cols - 1);
}

/**
 * 把 StyledChar 数组转成字符串（保留 ANSI 样式）。
 * styledCharsToString 自动在每个字符前输出其样式 SGR 码，颜色状态不跨行污染。
 */
function styledCharsToStringSafe(chars: StyledChar[]): string {
  return styledCharsToString(chars);
}

/**
 * 光标列映射：源 cursor offset（相对本逻辑行）→ 本物理行内显示列（不含前缀）。
 * 在 wrapping 断行过程中逐可见字符累计生成，覆盖被丢弃空格（空格不计显示列）。
 * cursorVisibleCol 查询此映射，禁止从 row.text + source offset 反推。
 */
export type CursorColMap = Record<number, number>;

/** wrapLineWithSpans 产出的单个物理行 span。 */
export interface WrappedSpan {
  /** 该物理行的可渲染文本（含 ANSI 样式，已 styledCharsToStringSafe，不含前缀） */
  text: string;
  /** 该物理行覆盖的源码点区间起始（相对传入逻辑行的码点索引，含） */
  charStart: number;
  /** 该物理行覆盖的源码点区间结束（相对传入逻辑行的码点索引，不含） */
  charEnd: number;
  /** 折行种类：本 span 是逻辑行首物理行='none'，软折续行='soft' */
  breakKind: 'none' | 'soft';
  /**
   * 光标列映射：cursor offset（相对本逻辑行）→ 本物理行内显示列（不含前缀）。
   * 断行过程中逐可见字符累计 stringWidth 生成。被丢弃空格的 srcOffset 是 key，
   * 但其显示列 = 前一可见字符的列（空格不计显示列）。
   */
  cursorColMap: CursorColMap;
}

/** 带 srcOffset 的 StyledChar（用于断行记账，offset = 该字符在源逻辑行的码点索引）。 */
interface StyledCharWithOffset {
  ch: StyledChar;
  srcOffset: number;
}

/** 计算一组 char 的显示宽度之和。 */
function widthOf(chars: StyledCharWithOffset[]): number {
  return chars.reduce((s, c) => s + stringWidth(c.ch.value), 0);
}

/** trimEnd 连续空格（带 offset）：去掉尾部连续空格字符。 */
function trimEndWithOffsets(chars: StyledCharWithOffset[]): StyledCharWithOffset[] {
  let end = chars.length;
  while (end > 0 && chars[end - 1]!.ch.value === ' ') end--;
  return chars.slice(0, end);
}

/**
 * 对已确定归属某物理行的 chars 重建 cursorColMap：逐可见字符累计 stringWidth 填列。
 * 返回该行累计显示宽度（= 行末 cursor 列）。
 * colMap 初始应已含 { [行首 srcOffset]: 0 }。
 */
function rebuildColumns(chars: StyledCharWithOffset[], colMap: CursorColMap): number {
  let running = 0;
  for (const { ch, srcOffset } of chars) {
    running += stringWidth(ch.value);
    colMap[srcOffset + 1] = running;
  }
  return running;
}

/**
 * 断行核心：按显示宽度折行，产出带源码点区间与 cursorColMap 的 spans。
 * 首物理行用 firstWidth，续物理行用 contWidth；两者入算法前钳到至少 1。
 *
 * 算法（与原 wrapLine 同款混合策略，仅增 offset/colMap 记账，不改断行判定）：
 * - 英文优先在上一个 ASCII 边界空格处断行（空格丢弃，不进下一行）；
 * - CJK/无空格 token 字符级断行。
 */
function wrapCore(line: string, firstWidthRaw: number, contWidthRaw: number): WrappedSpan[] {
  const firstWidth = Math.max(1, firstWidthRaw);
  const contWidth = Math.max(1, contWidthRaw);

  // 空文本特例：1 span，空区间。
  if (line === '') {
    return [{ text: '', charStart: 0, charEnd: 0, breakKind: 'none', cursorColMap: { 0: 0 } }];
  }

  const tokens = tokenize(line);
  const chars: StyledCharWithOffset[] = styledCharsFromTokens(tokens).map((ch, i) => ({ ch, srcOffset: i }));

  const spans: WrappedSpan[] = [];
  let currentLine: StyledCharWithOffset[] = [];
  let currentWidth = 0;
  let lastSpaceIdx = -1; // 上一个 ASCII 边界空格在 currentLine 中的下标；-1 表示当前行无

  let lineStart = 0;            // 当前物理行起始 srcOffset
  let lineWidth = firstWidth;   // 当前物理行可用宽度
  let colMap: CursorColMap = { [lineStart]: 0 };
  let runningCol = 0;

  const flushSpan = (charEnd: number, breakKind: 'none' | 'soft', visibleChars: StyledCharWithOffset[]): void => {
    spans.push({
      text: styledCharsToStringSafe(visibleChars.map(c => c.ch)),
      charStart: lineStart,
      charEnd,
      breakKind,
      cursorColMap: colMap,
    });
  };

  for (let ci = 0; ci < chars.length; ci++) {
    const char = chars[ci]!;
    const w = stringWidth(char.ch.value);

    // 超宽：需要断行（仅当当前行有内容时）
    if (currentWidth + w > lineWidth && currentLine.length > 0) {
      const beforeSpaceWidth = lastSpaceIdx >= 0
        ? widthOf(currentLine.slice(0, lastSpaceIdx))
        : 0;

      if (lastSpaceIdx >= 0 && beforeSpaceWidth > lineWidth * 0.3) {
        // 空格处断行：空格前内容作为当前行，空格后内容移到下一行；空格本身丢弃。
        const beforeSpace = currentLine.slice(0, lastSpaceIdx);
        const afterSpace = currentLine.slice(lastSpaceIdx + 1);
        // 去掉 beforeSpace 尾部连续空格
        const visibleBefore = trimEndWithOffsets(beforeSpace);
        const visibleWidth = widthOf(visibleBefore);

        // nextLineChars = [...afterSpace, char]；nextLineStart 取其首字符（兼容 afterSpace 为空）
        const nextLineChars = [...afterSpace, char];
        const nextLineStart = nextLineChars[0]!.srcOffset;

        // visibleEnd = 最后保留可见字符 srcOffset+1；无保留则 lineStart
        const visibleEnd = visibleBefore.length > 0
          ? visibleBefore.at(-1)!.srcOffset + 1
          : lineStart;

        // 从第一个被隐藏字符前的 cursor(visibleEnd) 到下一行起点前(nextLineStart)，
        // 全部映射到前一行可见末列(visibleWidth)。
        for (let offset = visibleEnd; offset <= nextLineStart; offset++) {
          colMap[offset] = visibleWidth;
        }

        flushSpan(nextLineStart, spans.length === 0 ? 'none' : 'soft', visibleBefore);

        // 下一行独立建立 colMap/runningCol（基于 nextLineChars，不从旧 runningCol 继承）
        lineStart = nextLineStart;
        currentLine = nextLineChars;
        currentWidth = widthOf(nextLineChars);
        lineWidth = contWidth;
        colMap = { [lineStart]: 0 };
        runningCol = rebuildColumns(nextLineChars, colMap);
        lastSpaceIdx = -1;
        // 重新在 nextLineChars 中找 ASCII 边界空格（仅 ASCII 之间才算单词边界）
        for (let i = 0; i < nextLineChars.length; i++) {
          if (nextLineChars[i]!.ch.value === ' ') {
            const prev = nextLineChars[i - 1];
            const next = nextLineChars[i + 1];
            const prevAscii = prev && /[ -~]/.test(prev.ch.value);
            const nextAscii = next && /[ -~]/.test(next.ch.value);
            if (prevAscii && nextAscii) lastSpaceIdx = i;
          }
        }
      } else {
        // 无空格（CJK/超长 token）或空格太靠前：直接在当前字符前断行（字符级）
        // 折行点 cursor（归下一行，Step 6 契约）：在前一行 colMap 记当前 runningCol
        colMap[ci] = runningCol;

        // 若 currentChar 是空格，丢弃它（避免下一行前导空格，对齐旧 wrapLine L98-100 行为）。
        // 空格归前一行区间（charEnd = ci+1 含空格），下一行从空格后一位（ci+1）起。
        if (char.ch.value === ' ') {
          // 行末边界(ci+1=下一行起点)归前一行可见末列(runningCol),与空格分支 nextLineStart 一致
          colMap[ci + 1] = runningCol;
          flushSpan(ci + 1, spans.length === 0 ? 'none' : 'soft', currentLine);
          lineStart = ci + 1;
          currentLine = [];
          currentWidth = 0;
          colMap = { [lineStart]: 0 };
          runningCol = 0;
        } else {
          flushSpan(ci, spans.length === 0 ? 'none' : 'soft', currentLine);
          const charWidth = stringWidth(char.ch.value);
          lineStart = char.srcOffset;
          currentLine = [char];
          currentWidth = w;
          colMap = {
            [lineStart]: 0,
            [lineStart + 1]: charWidth,
          };
          runningCol = charWidth;
        }
        lineWidth = contWidth;
        lastSpaceIdx = -1;
      }
    } else {
      // 不超宽：加入当前行；记录 ASCII 边界空格位置（单词边界候选）
      if (char.ch.value === ' ') {
        const prevChar = currentLine[currentLine.length - 1];
        const prevIsAscii = prevChar && prevChar.ch.value && /[ -~]/.test(prevChar.ch.value);
        const nextChar = chars[ci + 1];
        const nextIsAscii = nextChar && nextChar.ch.value && /[ -~]/.test(nextChar.ch.value);
        if (prevIsAscii && nextIsAscii) {
          lastSpaceIdx = currentLine.length;
        }
      }
      currentLine.push(char);
      currentWidth += w;
      runningCol += w;
      colMap[char.srcOffset + 1] = runningCol;
    }
  }

  // 最后一行
  if (currentLine.length > 0 || spans.length === 0) {
    // 末行 cursor 列 = runningCol（已在循环中填入末字符 srcOffset+1）
    flushSpan(chars[chars.length - 1]!.srcOffset + 1, spans.length === 0 ? 'none' : 'soft', currentLine);
  }

  return spans;
}

/**
 * 按显示宽度折行，产出带源码点区间与 cursorColMap 的 spans。
 * 首物理行与续物理行可用不同宽度（支持首行 prompt 扣宽）。
 *
 * @param line 单逻辑行文本（不含 \n，可能含 ANSI）
 * @param firstLineWidth 首物理行可用显示宽度
 * @param continuationWidth 续物理行可用显示宽度（钳到至少 1）
 */
export function wrapLineWithSpans(
  line: string,
  firstLineWidth: number,
  continuationWidth: number,
): WrappedSpan[] {
  return wrapCore(line, firstLineWidth, continuationWidth);
}

/**
 * 按显示宽度折行（混合策略：英文优先按空格断行，CJK/无空格按字符级断行）。
 *
 * 兼容包装：首行=续行同宽，返回纯文本数组（旧行为）。
 *
 * @param text 单行文本（不含 \n，可能含 ANSI）
 * @param usableWidth 可用宽度（getUsableWidth(cols)）
 * @returns 折行后的字符串数组（每行 displayWidth ≤ usableWidth）
 */
export function wrapLine(text: string, usableWidth: number): string[] {
  return wrapLineWithSpans(text, usableWidth, usableWidth).map(span => span.text);
}
