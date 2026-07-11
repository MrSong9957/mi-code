// src/tui/input/use-input-handler.ts
// Ink useInput 键事件 → input-store 操作的桥
//
// 物理本质：键盘按键的「翻译器」。
// Ink 的 useInput 把原始 stdin 字节解析成 (input: string, key: Key)，
// 本 hook 再翻译成 input-store 的原语（insert/backspace/move/submit）。
//
// 斜杠命令自动补全（Claude Code Portal 模式）：
// - 输入 / 时自动弹出下拉菜单（通过 DropdownContext）
// - 继续输入实时过滤候选
// - 上下箭头选择，Enter 确认，Esc 关闭
// - 下拉菜单与输入框分离渲染，通过 Context 传数据

import { useInput, type Key } from 'ink';
import type { InputStore } from '../state/input-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import { useDropdown } from '../state/dropdown-context.js';

export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
  onTab?: (text: string) => void,
  onToggleOverlay?: () => void,
  overlayVisible?: () => boolean,
  onPageScroll?: (direction: 'up' | 'down') => void,
  completionStore?: CompletionStore,
): void {
  const dropdown = useDropdown();

  useInput((input: string, key: Key) => {
    const s = store.getState();

    // 覆盖层激活时：只处理关闭键（q / Ctrl+O / Esc / Ctrl+C），其余吞掉
    if (overlayVisible?.()) {
      if (key.ctrl && input === 'c') { onExit?.(); return; }
      if (input === 'q' || (key.ctrl && input === 'o') || key.escape) {
        onToggleOverlay?.();
        return;
      }
      return;
    }

    // Ctrl+C：退出
    if (key.ctrl && input === 'c') {
      onExit?.();
      return;
    }

    // Ctrl+O：切换覆盖层
    if (key.ctrl && input === 'o') {
      onToggleOverlay?.();
      return;
    }

    // PageUp/PageDown：翻屏滚动
    if (key.pageUp) { onPageScroll?.('up'); return; }
    if (key.pageDown) { onPageScroll?.('down'); return; }

    // ─────────── 斜杠命令补全拦截（Claude Code Portal 模式）───────────
    if (dropdown.visible) {
      // Esc：关闭补全
      if (key.escape) {
        dropdown.hide();
        completionStore?.getState().hide();
        return;
      }

      // 上箭头：向上选择候选
      if (key.upArrow) {
        dropdown.prev();
        completionStore?.getState().cyclePrev();
        return;
      }

      // 下箭头：向下选择候选
      if (key.downArrow) {
        dropdown.next();
        completionStore?.getState().cycle();
        return;
      }

      // Enter：选中项写入 input，关闭补全
      if (key.return) {
        const selected = dropdown.selected();
        dropdown.hide();
        completionStore?.getState().hide();
        if (selected) {
          store.getState().setText('/' + selected);
        }
        return;
      }

      // TAB：循环选择候选
      if (key.tab) {
        dropdown.next();
        const selected = dropdown.selected();
        if (selected) {
          store.getState().setText('/' + selected);
        }
        completionStore?.getState().cycle();
        const sel = completionStore?.getState().selected();
        if (sel) {
          store.getState().setText('/' + sel);
        }
        return;
      }

      // 退格：如果退格后 text 不再以 / 开头，关闭补全
      if (key.backspace || input === '\x7f' || input === '\x08') {
        s.backspace();
        const newText = store.getState().text;
        if (!newText.startsWith('/')) {
          dropdown.hide();
          completionStore?.getState().hide();
        } else {
          dropdown.show(newText.slice(1));
          completionStore?.getState().filter(newText.slice(1));
        }
        return;
      }

      // 其它字符：插入后重新过滤
      if (input !== '' && !key.ctrl && !key.meta) {
        s.insert(input);
        const newText = store.getState().text;
        if (newText.startsWith('/')) {
          dropdown.show(newText.slice(1));
          completionStore?.getState().filter(newText.slice(1));
        } else {
          dropdown.hide();
          completionStore?.getState().hide();
        }
        return;
      }

      // 其它按键（方向键等）：吞掉
      return;
    }

    // ─────────── 非补全状态 ───────────

    // TAB：路由给 onTab（模式切换 or 补全）
    if (key.tab) {
      onTab?.(s.text);
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
    if (key.leftArrow) { s.moveCursorLeft(); return; }
    if (key.rightArrow) { s.moveCursorRight(); return; }

    // Ctrl+J：多行换行
    if (key.ctrl && input === 'j') {
      s.insertNewline();
      return;
    }

    // 上/下箭头：跨行移动
    if (key.upArrow) { s.moveCursorUp(); return; }
    if (key.downArrow) { s.moveCursorDown(); return; }

    // Home / End
    if (key.home) { s.moveCursorToStart(); return; }
    if (key.end) { s.moveCursorToEnd(); return; }

    // Ctrl+A / Ctrl+E
    if (key.ctrl && input === 'a') { s.moveCursorToStart(); return; }
    if (key.ctrl && input === 'e') { s.moveCursorToEnd(); return; }

    // 可打印字符：插入后检测是否触发补全
    const isMouseOrControlSeq = input.includes('\x1b') || /^\[<\d+;\d+;\d+[Mm]/.test(input);
    if (input !== '' && !key.ctrl && !key.meta && !key.escape && !isMouseOrControlSeq) {
      s.insert(input);
      // 插入后检测：如果 text 变成 / 开头，触发补全
      const newText = store.getState().text;
      if (newText === '/') {
        dropdown.show('');
        completionStore?.getState().filter('');
      }
    }
  });
}
