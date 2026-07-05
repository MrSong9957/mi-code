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

    // 其它控制序列（Tab/Esc/PageUp 等）本期忽略；可打印字符才 insert
    if (input !== '' && !key.ctrl && !key.meta && !key.escape && !key.tab) {
      s.insert(input);
    }
  });
}
