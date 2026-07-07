// src/tui/selection/word-boundary.ts
// 词边界识别：双击选词用。
//
// 物理本质：以 col 为中心，向左右「吞噬」连续的词字符，直到撞到非词字符。
// 词字符 = 字母 / 数字 / 下划线 / 中文/日文/韩文（CJK 统一表意）。
// 非词字符 = 空白 / 标点 / ANSI 前缀符（●⎿❯）。
//
// col 单位：码点索引（不是显示列）。
// 调用方需先把 SGR 鼠标的显示列转成码点索引（见 selection-store.selectWordAt）。
// 设计权衡：在码点空间做词边界比在显示列空间简单（不需 stringWidth 表），
// 调用方一次转换即可。

/** 判断字符是否为「词字符」 */
function isWordChar(ch: string): boolean {
  if (ch === '_') return true;
  // ASCII 字母数字
  if (/[a-zA-Z0-9]/.test(ch)) return true;
  // CJK 统一表意 + 日文假名 + 韩文（常见中日韩范围）
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x4e00 && code <= 0x9fff) return true; // CJK 统一表意
  if (code >= 0x3040 && code <= 0x30ff) return true; // 平假名+片假名
  if (code >= 0xac00 && code <= 0xd7af) return true; // 韩文音节
  if (code >= 0x3400 && code <= 0x4dbf) return true; // CJK 扩展 A
  return false;
}

/**
 * 以 col（码点索引）为中心，向左右扩展到词边界。
 * @param content 行完整文本
 * @param col     码点索引（0-based；调用方从显示列转换）
 * @returns {start,end} 码点索引区间（end 不含端点）；col 落在非词字符上返回 [col,col]
 */
export function findWordBounds(
  content: string,
  col: number,
): { start: number; end: number } {
  if (content === '') return { start: 0, end: 0 };
  const codepoints = [...content];
  const len = codepoints.length;
  // 钳 col 到 [0, len-1]
  const c = Math.max(0, Math.min(col, len - 1));
  const chAt = codepoints[c]!;
  if (!isWordChar(chAt)) {
    return { start: c, end: c };
  }
  // 向左扩展
  let start = c;
  while (start > 0 && isWordChar(codepoints[start - 1]!)) {
    start--;
  }
  // 向右扩展
  let end = c + 1;
  while (end < len && isWordChar(codepoints[end]!)) {
    end++;
  }
  return { start, end };
}
