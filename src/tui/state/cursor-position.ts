// src/tui/state/cursor-position.ts
// 光标屏幕坐标工具：把 (input, cursor, prompt) 映射到屏幕 {x, y}
//
// 物理本质：文本「码点索引」→ 终端「显示列/行」的翻译器。
// CJK 全角字符（汉字/emoji）在终端占 2 列，但 JS 码点计数只算 1。
// 旧 Ink Footer 把码点索引当列用，导致中文输入时光标落在字符中间（回归 bug）。
//
// 算法（对齐 Ink useCursor README 官方推荐 + 旧 renderer.ts:computeInputCursorPos）：
//   1. cursor 视为码点索引（与 input-store 一致）
//   2. 按行分割；逐行消费码点，定位光标所在行 y
//   3. 当前行「光标之前」的文本用 stringWidth 量显示宽度
//   4. x = promptWidth + 行内显示宽度（续行也有 prompt 宽度的缩进对齐）
//
// 注意：续行的缩进由 Footer/InlineRenderer 渲染负责（不写入 input 文本），
// 续行前缀 CONTINUATION_INDENT（与 promptWidth 等宽），故所有行 x 都加 promptWidth。

import stringWidth from 'string-width';

export interface ScreenPos {
  /** 屏幕列（0-based，不含 prompt 时为 0） */
  x: number;
  /** 行偏移（0-based，相对输入区第 0 行） */
  y: number;
}

/**
 * 计算 (input, cursor) 在屏幕上的 (x, y)。
 * @param input 完整输入文本（可能多行）
 * @param cursor 码点索引（0-based，[0, text.length]）
 * @param prompt 第 0 行的 prompt 字符串（如 '❯ '），仅影响第 0 行 x 偏移
 */
export function cursorScreenPos(input: string, cursor: number, prompt: string): ScreenPos {
  const lines = input.split('\n');
  // 把 cursor 钳到合法范围
  const cpLen = [...input].length;
  const c = Math.max(0, Math.min(cursor, cpLen));

  const promptWidth = stringWidth(prompt);
  let remaining = c;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineCpLen = [...line].length;
    if (remaining <= lineCpLen) {
      // 光标在第 i 行
      const beforeCursor = [...line].slice(0, remaining).join('');
      const lineOffset = stringWidth(beforeCursor);
      const x = promptWidth + lineOffset;
      return { x, y: i };
    }
    remaining -= lineCpLen + 1; // +1 跳过 \n
  }
  // 理论不可达（cursor 已钳到末尾），兜底返回最后一行末尾
  const lastIdx = lines.length - 1;
  const lastLine = lines[lastIdx] ?? '';
  const x = promptWidth + stringWidth(lastLine);
  return { x, y: lastIdx };
}
