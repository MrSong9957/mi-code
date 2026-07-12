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
 * 按显示宽度折行（混合策略：英文优先按空格断行，CJK/无空格按字符级断行）。
 *
 * 用 StyledChar（每个字符带完整样式信息）做断行，断行时每行自动带上正确 SGR 码——
 * 颜色状态不跨行污染（第1行有 reset，第2行有 re-open）。
 *
 * @param text 单行文本（不含 \n，可能含 ANSI）
 * @param usableWidth 可用宽度（getUsableWidth(cols)）
 * @returns 折行后的字符串数组（每行 displayWidth ≤ usableWidth）
 */
export function wrapLine(text: string, usableWidth: number): string[] {
  if (text === '') return [''];

  // tokenize → styledChars：每个 char 携带完整 styles 数组
  const tokens = tokenize(text);
  const chars = styledCharsFromTokens(tokens);

  const lines: StyledChar[][] = [];
  let currentLine: StyledChar[] = [];
  let currentWidth = 0;
  // 上一个空格的位置（单词边界候选断行点）。-1 表示当前行无空格。
  let lastSpaceIdx = -1;

  for (let ci = 0; ci < chars.length; ci++) {
    const char = chars[ci]!;
    const w = stringWidth(char.value);

    // 超宽：需要断行（仅当当前行有内容时）
    if (currentWidth + w > usableWidth && currentLine.length > 0) {
      // 优先在上一个空格处断行（单词边界）。
      // 但只有当空格"足够靠后"时才用它——空格前的内容(beforeSpace)应占行的一定比例。
      // 否则空格太靠前（如 "❯ 是手动 千文..." 空格在 index 5，beforeSpace 仅8列）
      // 会导致第一行很短，后面空一大截。阈值 30%：beforeSpace > usableWidth * 0.3。
      const beforeSpaceWidth = lastSpaceIdx >= 0
        ? currentLine.slice(0, lastSpaceIdx).reduce((s, c) => s + stringWidth(c.value), 0)
        : 0;
      if (lastSpaceIdx >= 0 && beforeSpaceWidth > usableWidth * 0.3) {
        // 空格处断行：空格前内容作为当前行，空格后内容移到下一行
        // 空格本身丢弃（不进入下一行，避免前导空格）
        const beforeSpace = currentLine.slice(0, lastSpaceIdx);
        const afterSpace = currentLine.slice(lastSpaceIdx + 1);
        // 去掉 beforeSpace 尾部连续空格
        let trimEnd = beforeSpace.length;
        while (trimEnd > 0 && beforeSpace[trimEnd - 1]!.value === ' ') trimEnd--;
        const trimmed = beforeSpace.slice(0, trimEnd);
        lines.push(trimmed);
        currentLine = [...afterSpace, char];
        currentWidth = afterSpace.reduce((s, c) => s + stringWidth(c.value), 0) + w;
        // 下一行的 lastSpaceIdx 需要在 afterSpace 中重新找（同样只记 ASCII 边界）
        lastSpaceIdx = -1;
        for (let i = 0; i < afterSpace.length; i++) {
          if (afterSpace[i]!.value === ' ') {
            const prev = afterSpace[i - 1];
            const next = afterSpace[i + 1];
            const prevAscii = prev && /[ -~]/.test(prev.value);
            const nextAscii = next && /[ -~]/.test(next.value);
            if (prevAscii && nextAscii) lastSpaceIdx = i;
          }
        }
      } else {
        // 无空格（CJK/超长token）或空格太靠前：直接在当前字符前断行
        lines.push(currentLine);
        // 如果当前字符是空格，丢弃它（避免下一行前导空格）
        if (char.value === ' ') {
          currentLine = [];
          currentWidth = 0;
        } else {
          currentLine = [char];
          currentWidth = w;
        }
        lastSpaceIdx = -1;
      }
    } else {
      // 不超宽：加入当前行
      // 记录空格位置（单词边界候选）
      // 只在空格前后都是 ASCII 字符时记录——CJK 文本中的空格不是单词边界，
      // 在 CJK 空格处断行会导致当前行没铺满（用户看到的"后半截空了一大片"）。
      if (char.value === ' ') {
        const prevChar = currentLine[currentLine.length - 1];
        const prevIsAscii = prevChar && prevChar.value && /[ -~]/.test(prevChar.value);
        const nextChar = chars[ci + 1];
        const nextIsAscii = nextChar && nextChar.value && /[ -~]/.test(nextChar.value);
        if (prevIsAscii && nextIsAscii) {
          lastSpaceIdx = currentLine.length;
        }
      }
      currentLine.push(char);
      currentWidth += w;
    }
  }

  // 最后一行
  if (currentLine.length > 0 || lines.length === 0) {
    lines.push(currentLine);
  }

  return lines.map(styledCharsToStringSafe);
}
