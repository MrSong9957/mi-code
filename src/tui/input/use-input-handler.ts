// src/tui/input/use-input-handler.ts
// Ink useInput 键事件 → input-store 操作的桥
//
// 物理本质：键盘按键的「翻译器」。
// Ink 的 useInput 把原始 stdin 字节解析成 (input: string, key: Key)，
// 本 hook 再翻译成 input-store 的原语（insert/backspace/move/submit）。
//
// 斜杠命令自动补全（单一数据源：completionStore）：
// - 输入 / 时自动弹出下拉菜单（completionStore.filter）
// - 继续输入实时过滤候选
// - 上下箭头选择（cycle/cyclePrev），Enter 确认，Esc 关闭
// - 数据源必须是 completionStore（而非 React Context）——因为本 hook 在
//   DropdownProvider 之外执行（ConnectedApp 函数体内调用），Context 拿到的是 no-op stub。

import { useRef } from 'react';
import { useInput, type Key } from 'ink';
import type { InputStore } from '../state/input-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectStore } from '../state/select-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';

export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
  onTab?: (text: string) => void,
  onToggleOverlay?: () => void,
  overlayVisible?: () => boolean,
  onPageScroll?: (direction: 'up' | 'down') => void,
  completionStore?: CompletionStore,
  selectStore?: SelectStore,
  spinnerStore?: SpinnerStore,
  onAbortStream?: () => void,
  onRewindLastTurn?: () => void,
): void {
  const DOUBLE_ESC_WINDOW_MS = 400;
  const lastEscAtRef = useRef(0);

  useInput((input: string, key: Key) => {
    const s = store.getState();
    const completion = completionStore?.getState();

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

    // ─────────── Select 界面拦截(交互式选择器)───────────
    if (selectStore && selectStore.getState().visible) {
      if (key.escape) { selectStore.getState().close(); return; }
      if (key.upArrow) { selectStore.getState().cyclePrev(); return; }
      if (key.downArrow) { selectStore.getState().cycle(); return; }
      if (key.return) { selectStore.getState().confirm(); return; }
      // 其余键都吞掉(Select 界面不接受文字输入)
      return;
    }

    // ─────────── 斜杠命令补全拦截（completionStore 单一数据源）───────────
    if (completion?.visible) {
      // Esc：关闭补全
      if (key.escape) {
        completionStore!.getState().hide();
        return;
      }

      // 上箭头：向上选择候选
      if (key.upArrow) {
        completionStore!.getState().cyclePrev();
        return;
      }

      // 下箭头：向下选择候选
      if (key.downArrow) {
        completionStore!.getState().cycle();
        return;
      }

      // Enter：选中项写入 input + 尾空格(方便直接输参数),关闭补全
      if (key.return) {
        const selected = completionStore!.getState().selected();
        completionStore!.getState().hide();
        if (selected) {
          store.getState().setText('/' + selected + ' ');
        }
        return;
      }

      // TAB：选中当前高亮项 + 尾空格,关闭补全(对标 Claude Code:选中后直接输参数)
      if (key.tab) {
        const sel = completionStore!.getState().selected();
        completionStore!.getState().hide();
        if (sel) {
          store.getState().setText('/' + sel + ' ');
        }
        return;
      }

      // 退格：如果退格后 text 不再以 / 开头，关闭补全
      if (key.backspace || input === '\x7f' || input === '\x08') {
        s.backspace();
        const newText = store.getState().text;
        if (!newText.startsWith('/')) {
          completionStore!.getState().hide();
        } else {
          completionStore!.getState().filter(newText.slice(1));
        }
        return;
      }

      // 其它字符：插入后重新过滤
      if (input !== '' && !key.ctrl && !key.meta) {
        s.insert(input);
        const newText = store.getState().text;
        if (newText.startsWith('/')) {
          completionStore!.getState().filter(newText.slice(1));
        } else {
          completionStore!.getState().hide();
        }
        return;
      }

      // 其它按键（方向键等）：吞掉
      return;
    }

    // ─────────── ESC 中断/撤回(在 completion 之后,普通编辑之前)───────────
    if (key.escape) {
      const now = Date.now();
      const isRunning = spinnerStore?.getState().active ?? false;
      // 窗口内第二次 ESC → 撤回(无论此时 isRunning 与否:第一次已触发 abort,
      // spinnerStore.active 可能还在过渡中,用时间戳判定更可靠)
      if (now - lastEscAtRef.current <= DOUBLE_ESC_WINDOW_MS && lastEscAtRef.current !== 0) {
        onRewindLastTurn?.();
        lastEscAtRef.current = 0;
        return;
      }
      // 第一次 ESC(或窗口外的单次):若有任务运行 → 中断
      if (isRunning) {
        onAbortStream?.();
      }
      lastEscAtRef.current = now;
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
    // Ctrl+U：删除光标到行首（Unix 行编辑标准键，不跨行）
    if (key.ctrl && input === 'u') { s.deleteToLineStart(); return; }

    // 可打印字符：插入后检测是否触发补全
    const isMouseOrControlSeq = input.includes('\x1b') || /^\[<\d+;\d+;\d+[Mm]/.test(input);
    if (input !== '' && !key.ctrl && !key.meta && !key.escape && !isMouseOrControlSeq) {
      s.insert(input);
      // 插入后检测：如果 text 变成 / 开头，触发补全
      const newText = store.getState().text;
      if (newText === '/') {
        completionStore?.getState().filter('');
      }
    }
  });
}
