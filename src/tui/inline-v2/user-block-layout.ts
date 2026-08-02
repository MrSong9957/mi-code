// src/tui/inline-v2/user-block-layout.ts
//
// 用户输入块的纯布局函数：把原始用户文本（可能含制表符、CJK、emoji ZWJ、
// 组合字符、多逻辑行）按可用显示宽度折成物理行，并在首行按需前缀 '❯ '。
//
// 物理本质：排版工人的「分拣」——把用户提交的一坨文本摊平成终端可显示的行。
// 与 wrap-line.ts 的 wrapLineWithSpans 协作：本模块负责逻辑行切分、制表符展开、
// prompt 前缀决策与前导空格保留；wrapLineWithSpans 负责单行的字符级/单词级断行。
//
// 关键契约（由测试锁定）：
// - 制表符仅在渲染结果展开为 4 空格，源串不被修改（renderCopy 纯函数）。
// - 逻辑空行保留为空物理行（不丢、不合并）。
// - 前导空格必须保留：wrap-line 共享 wrapper 会在窄宽下吞掉前导空格，
//   故本模块用 wrapUserLinePreservingLeadingSpaces 自行处理前导空格。
// - prompt '❯ ' 仅当首逻辑行能与首个 grapheme 一起塞进 localWidth 时才显示
//   （首逻辑行为空时退化为「prefix 自身能合法容纳」）。
// - 不可分 grapheme（CJK/emoji/组合序列）允许溢出，但不与其它字符合并。

import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { wrapLineWithSpans } from '../state/wrap-line.js';

/** 用户输入提示前缀（绿色加粗 ❯ + 空格），渲染时拼到首物理行首。 */
export const USER_PROMPT = '❯ ';
const USER_PROMPT_WIDTH = stringWidth(USER_PROMPT);
/** 制表符渲染宽度（与 4 列对齐，仅作用于渲染结果）。 */
const TAB_RENDERING = '    ';

/**
 * 把非有限/非正宽度钳到 1，避免 wrapLineWithSpans 内部 Math.max(1, ...) 之外
 * 的下游计算出现 NaN/0 除法或丢字。NaN/负数/0 一律视作 1 列可用。
 */
function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

/**
 * 制表符展开副本：仅用于渲染路径，源串不被修改。
 * \t → 4 空格（与 TAB_RENDERING 一致）。
 */
function renderCopy(text: string): string {
  return text.replaceAll('\t', TAB_RENDERING);
}

/** 取文本的首个 grapheme（CJK 字符/emoji ZWJ 序列/组合字符均为一个 grapheme）。 */
function firstGrapheme(text: string): string | undefined {
  return styledCharsFromTokens(tokenize(text))[0]?.value;
}

/**
 * 判定首逻辑行是否应前缀 '❯ '：
 * - 存在正文首 grapheme：USER_PROMPT_WIDTH + 首 grapheme 宽度 <= width。
 * - 无正文首 grapheme（首逻辑行为空）：prefix 自身能合法容纳即可（USER_PROMPT_WIDTH <= width）。
 */
function shouldShowPromptForFirstLine(firstLine: string, width: number): boolean {
  const grapheme = firstGrapheme(firstLine);
  return grapheme === undefined
    ? USER_PROMPT_WIDTH <= width
    : USER_PROMPT_WIDTH + stringWidth(grapheme) <= width;
}

/**
 * 折行单逻辑行，保留前导空格（wrap-line 共享 wrapper 会吞前导空格，故本模块自行处理）。
 *
 * 策略：把行切成 [前导空格段, 正文段]。先把前导空格按当前可用宽度切成若干物理行
 * （只有当切完后还有正文要放，或前导空格仍有富余时才切），再把正文交给
 * wrapLineWithSpans 折行，并尽量把剩余前导空格与正文首物理行合并；当合并后会溢出
 * 且正文首 grapheme 不可分时，强制把剩余空格独占一行（避免与宽 grapheme 合并溢出）。
 */
function wrapUserLinePreservingLeadingSpaces(
  line: string,
  firstWidthRaw: number,
  continuationWidthRaw: number,
): string[] {
  const firstWidth = Math.max(1, firstWidthRaw);
  const continuationWidth = Math.max(1, continuationWidthRaw);
  const leadingSpaces = line.match(/^ */u)?.[0] ?? '';
  if (leadingSpaces === '') {
    return wrapLineWithSpans(line, firstWidth, continuationWidth).map((span) => span.text);
  }

  const body = line.slice(leadingSpaces.length);
  const rows: string[] = [];
  let remainingSpaces = leadingSpaces;
  let currentWidth = firstWidth;

  // 切前导空格段：每轮切 currentWidth 列空格。仅当「切完仍有富余」或「后面还有正文」
  // 时才切，避免在最后一轮把恰好放得下的空格强行多切一行。
  while (
    remainingSpaces.length >= currentWidth
    && (remainingSpaces.length > currentWidth || body !== '')
  ) {
    rows.push(remainingSpaces.slice(0, currentWidth));
    remainingSpaces = remainingSpaces.slice(currentWidth);
    currentWidth = continuationWidth;
  }

  if (body === '') {
    // 纯空格行：剩余空格作为最后一行（rows 已有切出来的段则补尾，否则整段输出）。
    if (remainingSpaces !== '' || rows.length === 0) rows.push(remainingSpaces);
    return rows;
  }

  // 正文首 grapheme：用于判定「剩余空格 + 首 grapheme」是否会溢出。
  const bodyFirstGrapheme = firstGrapheme(body);
  if (
    remainingSpaces !== ''
    && bodyFirstGrapheme !== undefined
    && stringWidth(remainingSpaces) + stringWidth(bodyFirstGrapheme) > currentWidth
  ) {
    // 合并会溢出且首 grapheme 不可分：剩余空格独占一行，正文从续宽重新折行。
    rows.push(remainingSpaces);
    remainingSpaces = '';
    currentWidth = continuationWidth;
  }

  const wrappedBody = wrapLineWithSpans(
    body,
    currentWidth - remainingSpaces.length,
    continuationWidth,
  ).map((span) => span.text);
  rows.push(remainingSpaces + (wrappedBody[0] ?? ''));
  rows.push(...wrappedBody.slice(1));
  return rows;
}

/**
 * 判定是否应在渲染结果首行前缀 '❯ '。
 * 规则与 layoutUserBlockRows 内部一致：首逻辑行存在正文 grapheme 看其宽度，
 * 首逻辑行为空时看 prefix 自身是否合法容纳。
 */
export function shouldShowUserPrompt(text: string, width: number): boolean {
  const normalized = renderCopy(text);
  const firstLine = normalized.split('\n', 1)[0] ?? '';
  return shouldShowPromptForFirstLine(firstLine, safeWidth(width));
}

/**
 * 把用户文本摊平为物理行数组（纯函数，不修改源串）。
 *
 * 步骤：
 * 1. renderCopy：制表符展开为 4 空格（仅作用于副本）。
 * 2. 按宽度判定 prompt 是否显示。
 * 3. 逐逻辑行折行：
 *    - 首逻辑行：可用首宽 = localWidth - USER_PROMPT_WIDTH（显示 prompt 时）或 localWidth。
 *    - 其它逻辑行：首宽 = localWidth。
 * 4. 仅在「首逻辑行 + 首物理行 + 显示 prompt」处前缀 '❯ '。
 */
export function layoutUserBlockRows(text: string, width: number): string[] {
  const normalized = renderCopy(text);
  const localWidth = safeWidth(width);
  const logicalLines = normalized.split('\n');
  const showPrompt = shouldShowPromptForFirstLine(logicalLines[0] ?? '', localWidth);
  const rows: string[] = [];

  for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex += 1) {
    const line = logicalLines[lineIndex]!;
    const isFirstLogicalLine = lineIndex === 0;
    const firstWidth = isFirstLogicalLine && showPrompt
      ? localWidth - USER_PROMPT_WIDTH
      : localWidth;
    const wrappedRows = wrapUserLinePreservingLeadingSpaces(line, firstWidth, localWidth);

    wrappedRows.forEach((wrappedRow, rowIndex) => {
      const prefix = isFirstLogicalLine && rowIndex === 0 && showPrompt
        ? USER_PROMPT
        : '';
      rows.push(prefix + wrappedRow);
    });
  }

  return rows;
}
