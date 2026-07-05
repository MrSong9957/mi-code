// src/tui/input/use-input-handler.ts
// Ink useInput 键事件 → input-store 操作的桥
//
// 物理本质：键盘按键的「翻译器」。
// Ink 的 useInput 把原始 stdin 字节解析成 (input: string, key: Key)，
// 本 hook 再翻译成 input-store 的原语（insert/backspace/move/submit）。
// 替代旧 src/index.ts:449 的手写 handleInput 字节调度（旧代码自己解析 UTF-8 + 转义序列）。
//
// 键映射（对齐旧实现 + readline 惯例）：
// - 可打印字符 → insert(input)
// - Backspace / Delete → backspace / deleteForward
// - ←/→ → moveCursorLeft / Right
// - Ctrl+A / Ctrl+E → 行首 / 行尾（readline 风格）
// - Home / End → 行首 / 行尾
// - 回车 (return) → submit（触发 onSubmit，清空）
// - Ctrl+C → onExit()（退出）
//
// ⚠️ 重要：Ink 的 useInput 对 Ctrl+letter 把 input 设为「字母名」而非控制字节。
// 例如 Ctrl+A → input='a' + key.ctrl=true（不是 input='\x01'）。
// 这是 parseKeypress + use-input.js 的既定契约（Ctrl+C 检查是 input==='c' && key.ctrl）。
// 故本 handler 一律用「input===字母 && key.ctrl」判断 Ctrl 组合键。

import { useInput, type Key } from 'ink';
import type { InputStore } from '../state/input-store.js';

export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
): void {
  useInput((input: string, key: Key) => {
    const s = store.getState();

    // Ctrl+C：退出（最高优先级，不改输入）
    if (key.ctrl && input === 'c') {
      onExit?.();
      return;
    }

    // 回车：提交
    if (key.return) {
      s.submit();
      return;
    }

    // 退格 / 删除
    if (key.backspace || input === '\x7f' || input === '\x08') {
      s.backspace();
      return;
    }
    if (key.delete) {
      s.deleteForward();
      return;
    }

    // 方向键
    if (key.leftArrow) {
      s.moveCursorLeft();
      return;
    }
    if (key.rightArrow) {
      s.moveCursorRight();
      return;
    }

    // Home / End
    if (key.home) {
      s.moveCursorToStart();
      return;
    }
    if (key.end) {
      s.moveCursorToEnd();
      return;
    }

    // Ctrl+A / Ctrl+E（readline 行首/行尾）
    if (key.ctrl && input === 'a') {
      s.moveCursorToStart();
      return;
    }
    if (key.ctrl && input === 'e') {
      s.moveCursorToEnd();
      return;
    }

    // 其它控制序列（Tab/Esc/PageUp 等）本期忽略；可打印字符才 insert。
    // ⚠️ 鼠标 SGR 序列（\x1b[<button;col;rowM|m）的受害者防御：
    // Ink 的 parseKeypress 不识别鼠标，会把整段 \x1b[<...> 当作 sequence（name=""），
    // 经 useInput 以 input 形式送达——且 Ink 会先剥离开头的 \x1b（use-input.js
    // 的 "strip escape prefix" 逻辑），所以到达这里的 input 形如 "[<0;10;5M"。
    // 若不拦截会把这些残码当文本插入输入框（表现为鼠标左右键/滚轮在输入框输出乱码）。
    // 拒绝仍含 \x1b 或匹配 SGR 鼠标残码模式（\[<digits;digits;digits>M|m）的 input；
    // 正常可打印字符（含多字节 UTF-8）绝不匹配，故不误伤。
    const isMouseOrControlSeq = input.includes('\x1b') || /^\[<\d+;\d+;\d+[Mm]/.test(input);
    if (input !== '' && !key.ctrl && !key.meta && !key.escape && !key.tab && !isMouseOrControlSeq) {
      s.insert(input);
    }
  });
}
