// src/tui/input/mouse-wheel.ts
// SGR 鼠标滚轮解析（charter §核心模块 1）
//
// 物理本质：把终端的鼠标转义序列翻译成「向上/向下滚」信号。
// SGR 鼠标编码（DEC 1006）：\x1b[<button;col;rowM 或 m
//   - M = 按下/动作，m = 释放
//   - button：0/1/2 = 左/中/右键，64 = 滚轮上，65 = 滚轮下
//   - 修饰键叠加位：Shift=4, Alt=8, Ctrl=16（如 Ctrl+滚轮上 = 64+16=80）
//
// 本期只识别滚轮（button 基位 64/65），返回 'up'/'down'；其它返回 null。
// 鼠标按下/拖拽（selection）留待后续期。

/** SGR 鼠标序列正则：\x1b[<button;col;row(M|m)
 *  含控制字符 \x1b（终端转义序列固有），eslint no-control-regex 不适用 */
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export type WheelDirection = 'up' | 'down';

/** 解析 data，识别鼠标滚轮方向；非滚轮序列返回 null */
export function parseMouseWheel(data: string): WheelDirection | null {
  const m = SGR_MOUSE_RE.exec(data);
  if (!m) return null;
  const button = parseInt(m[1]!, 10);
  const action = m[4]; // 'M' = 按下，'m' = 释放
  // 只处理按下动作（滚轮只有按下，无释放）
  if (action !== 'M') return null;
  // button 基位：屏蔽修饰键（& 64），64=上，65=下
  const base = button & 64;
  if (base === 64) {
    // 65 = 下（64+1），其它 64 系 = 上
    return (button & 1) === 1 ? 'down' : 'up';
  }
  return null;
}
