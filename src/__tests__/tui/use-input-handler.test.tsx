// src/__tests__/tui/use-input-handler.test.tsx
// useInputHandler：Ink useInput 键事件 → input-store 操作

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { createInputStore, type InputStore } from '../../tui/state/input-store.js';
import { useInputHandler } from '../../tui/input/use-input-handler.js';
import { createSpinnerStore, type SpinnerStore } from '../../tui/state/spinner-store.js';
import { resetPasteState } from '../../tui/input/paste-handler.js';

/** 用 input-store 渲染一个 probe，把当前 text 显示出来。
 *  onExit 可选，传给 useInputHandler。 */
function InputProbe({
  store,
  onExit,
  onTab,
  onToggleOverlay,
  overlayVisible,
  spinnerStore,
  onAbortStream,
  onRewindLastTurn,
}: {
  store: InputStore;
  onExit?: () => void;
  onTab?: (text: string) => void;
  onToggleOverlay?: () => void;
  overlayVisible?: () => boolean;
  spinnerStore?: SpinnerStore;
  onAbortStream?: () => void;
  onRewindLastTurn?: () => void;
}): React.ReactElement {
  useInputHandler(
    store, onExit, onTab, onToggleOverlay, overlayVisible,
    undefined, undefined, undefined,
    spinnerStore, onAbortStream, onRewindLastTurn,
  );
  const text = store.getState().text;
  return React.createElement(Text, {}, `text="${text}"`);
}

describe('useInputHandler（键事件 → store）', () => {
  it('可打印字符 → insert', () => {
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('hi');
    expect(store.getState().text).toBe('hi');
  });

  it('Backspace → backspace', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().moveCursorToEnd();
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\x7f'); // DEL = Backspace
    expect(store.getState().text).toBe('ab');
  });

  it('左/右方向键 → moveCursor', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\x1b[D'); // 左
    expect(store.getState().cursor).toBe(2);
    stdin.write('\x1b[C'); // 右
    expect(store.getState().cursor).toBe(3);
  });

  it('Home/End 风格：Ctrl+A 到首，Ctrl+E 到尾', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\x01'); // Ctrl+A
    expect(store.getState().cursor).toBe(0);
    stdin.write('\x05'); // Ctrl+E
    expect(store.getState().cursor).toBe(5);
  });

  it('回车 → submit（触发 onSubmit，清空）', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    store.getState().insert('hello');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\r'); // CR = 回车
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(store.getState().text).toBe('');
  });

  it('空回车不触发 submit', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\r');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('同一文本短时间内重复回车只触发一次 submit（去重）', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    store.getState().insert('hello');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\r');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 快速重新输入相同文本并回车——应被去重
    store.getState().insert('hello');
    stdin.write('\r');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('鼠标 SGR 序列不触发 submit（inline 模式防误判）', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    store.getState().insert('hello');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    // 鼠标释放事件（SGR 格式）：\x1b[<0;col;rowm
    stdin.write('\x1b[<0;5;10m');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(store.getState().text).toBe('hello');
  });

  it('bracketed paste 结束符不触发 submit', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    store.getState().insert('test');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    // bracketed paste 结束标记：\x1b[201~（Ink 拆分处理，\x1b 被过滤，其余可能作为字符插入）
    stdin.write('\x1b[201~');
    expect(onSubmit).not.toHaveBeenCalled();
    // 关键：submit 未触发，文本可能含残留字符但不影响功能
  });

  it('Ctrl+C → 调用 onExit 回调（退出），不改 store', () => {
    const onExit = vi.fn();
    const store = createInputStore();
    store.getState().insert('abc');
    const { stdin } = render(React.createElement(InputProbe, { store, onExit }));
    stdin.write('\x03'); // Ctrl+C
    expect(onExit).toHaveBeenCalledTimes(1);
    // Ctrl+C 不应改动输入文本
    expect(store.getState().text).toBe('abc');
  });

  it('ESC + spinner active → 调 onAbortStream', () => {
    vi.useFakeTimers();
    const spinnerStore = createSpinnerStore();
    spinnerStore.getState().start('thinking');
    const onAbortStream = vi.fn();
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, {
      store, spinnerStore, onAbortStream,
    }));
    stdin.write('\x1b'); // ESC(ink 缓冲 ~20ms,需推进定时器 flush)
    vi.advanceTimersByTime(30);
    expect(onAbortStream).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ESC + spinner inactive → 不调 onAbortStream', () => {
    vi.useFakeTimers();
    const spinnerStore = createSpinnerStore();
    const onAbortStream = vi.fn();
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, {
      store, spinnerStore, onAbortStream,
    }));
    stdin.write('\x1b');
    vi.advanceTimersByTime(30);
    expect(onAbortStream).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('双击 ESC(400ms 内)→ 调 onRewindLastTurn', () => {
    vi.useFakeTimers();
    const spinnerStore = createSpinnerStore();
    spinnerStore.getState().start('thinking');
    const onAbortStream = vi.fn();
    const onRewindLastTurn = vi.fn();
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, {
      store, spinnerStore, onAbortStream, onRewindLastTurn,
    }));
    stdin.write('\x1b'); // 第一次 ESC
    vi.advanceTimersByTime(30); // flush 第一次
    // 立即第二次(在 400ms 窗口内)
    stdin.write('\x1b');
    vi.advanceTimersByTime(30); // flush 第二次
    expect(onAbortStream).toHaveBeenCalledTimes(1);
    expect(onRewindLastTurn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('两次 ESC 超出 400ms → 只中断不撤回', () => {
    vi.useFakeTimers();
    const spinnerStore = createSpinnerStore();
    spinnerStore.getState().start('thinking');
    const onAbortStream = vi.fn();
    const onRewindLastTurn = vi.fn();
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, {
      store, spinnerStore, onAbortStream, onRewindLastTurn,
    }));
    stdin.write('\x1b');
    vi.advanceTimersByTime(30); // flush 第一次
    // 推进 450ms 超出 400ms 窗口
    vi.advanceTimersByTime(450);
    stdin.write('\x1b');
    vi.advanceTimersByTime(30); // flush 第二次
    expect(onAbortStream).toHaveBeenCalledTimes(2); // 两次都触发中断
    expect(onRewindLastTurn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('useInputHandler（多行编辑键绑定）', () => {
  it('Ctrl+J → insertNewline（多行换行）', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\n'); // Ctrl+J 在多数终端是 \n
    expect(store.getState().text).toBe('hello\n');
    expect(store.getState().cursor).toBe(6);
  });

  it('Ctrl+J 连续 3 次 → 3 个换行（无上限）', () => {
    const store = createInputStore();
    store.getState().insert('a');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\n\n\n');
    expect(store.getState().text).toBe('a\n\n\n');
  });

  it('上方向键 → moveCursorUp（跨行上移）', () => {
    const store = createInputStore();
    store.getState().insert('line1\nline2');
    store.getState().moveCursorToEnd(); // 在 line2 末尾（cursor=11）
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\x1b[A'); // 上
    // 从 line2 col5 上移到 line1 col5（line1 长5，钳到末尾=5，索引5）
    expect(store.getState().cursor).toBe(5);
  });

  it('下方向键 → moveCursorDown（跨行下移）', () => {
    const store = createInputStore();
    store.getState().insert('line1\nline2');
    store.getState().moveCursorTo(3); // line1 col3
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\x1b[B'); // 下
    // 下移到 line2 col3（索引 6+3=9）
    expect(store.getState().cursor).toBe(9);
  });

  it('Ctrl+U → deleteToLineStart（删光标到行首）', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    store.getState().moveCursorTo(3); // hel|lo
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\x15'); // Ctrl+U
    expect(store.getState().text).toBe('lo');
    expect(store.getState().cursor).toBe(0);
  });

  it('Ctrl+U 连续按 → 逐行删除到空（核心契约）', () => {
    const store = createInputStore();
    store.getState().insert('aaa\nbbb\nccc');
    store.getState().moveCursorToEnd();
    const { stdin } = render(React.createElement(InputProbe, { store }));
    // 连续按 Ctrl+U 直到空
    let presses = 0;
    while (store.getState().text !== '' && presses < 20) {
      stdin.write('\x15');
      presses++;
    }
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
  });

  it('Home/End → moveCursorToStart/End（多行）', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorToEnd();
    const { stdin } = render(React.createElement(InputProbe, { store }));
    // Home（\x1b[H）→ 到首
    stdin.write('\x1b[H');
    expect(store.getState().cursor).toBe(0);
    // End（\x1b[F）→ 到末
    stdin.write('\x1b[F');
    expect(store.getState().cursor).toBe(7);
  });
});

describe('useInputHandler（鼠标序列不得污染输入框）', () => {
  // 鼠标 SGR 序列经 Ink useInput 时，parseKeypress 把整个 \x1b[<...> 当作 sequence
  // （name=""），会落到 insert 分支把转义码当文本插入。必须在 insert 前拦截含控制字符的 input。
  const mouseSeqs = [
    ['左键按下', '\x1b[<0;10;5M'],
    ['释放', '\x1b[<0;10;5m'],
    ['滚轮上', '\x1b[<64;10;5M'],
    ['滚轮下', '\x1b[<65;10;5M'],
    ['拖拽', '\x1b[<32;10;6M'],
  ];
  for (const [label, seq] of mouseSeqs) {
    it(`鼠标${label}序列不写入输入框`, () => {
      const store = createInputStore();
      const { stdin } = render(React.createElement(InputProbe, { store }));
      stdin.write(seq);
      expect(store.getState().text, `鼠标${label}序列不应被 insert`).toBe('');
    });
  }

  it('连续多个鼠标事件后输入框仍空', () => {
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\x1b[<0;10;5M');
    stdin.write('\x1b[<32;10;6M');
    stdin.write('\x1b[<64;10;7M');
    stdin.write('\x1b[<0;10;8m');
    expect(store.getState().text).toBe('');
  });

  it('正常可打印字符仍能输入（不误伤）', () => {
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('hi');
    expect(store.getState().text).toBe('hi');
  });
});

describe('useInputHandler: TAB 路由', () => {
  it('TAB → 调 onTab(text)，不插入 \\t', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    const onTab = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, { store, onTab }));
    stdin.write('\t');
    expect(onTab).toHaveBeenCalledTimes(1);
    expect(onTab).toHaveBeenCalledWith('hello');
    expect(store.getState().text).toBe('hello'); // 未插入 \t
  });

  it('未传 onTab 时 TAB 静默忽略（不崩）', () => {
    const store = createInputStore();
    store.getState().insert('hi');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\t');
    expect(store.getState().text).toBe('hi'); // 仍未插入 \t
  });
});

describe('useInputHandler: Ctrl+O 覆盖层', () => {
  it('Ctrl+O → 调 onToggleOverlay', () => {
    const store = createInputStore();
    const onToggle = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, {
      store, onToggleOverlay: onToggle,
    }));
    stdin.write('\x0f'); // Ctrl+O 字节
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('overlay 激活时：普通按键被吞（不 insert）', () => {
    const store = createInputStore();
    const onToggle = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, {
      store,
      onToggleOverlay: onToggle,
      overlayVisible: () => true, // 模拟 overlay 已开
    }));
    stdin.write('x'); // 普通字符
    expect(store.getState().text).toBe(''); // 被吞，未 insert
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('overlay 激活时：q 关闭（调 onToggleOverlay）', () => {
    const store = createInputStore();
    const onToggle = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, {
      store,
      onToggleOverlay: onToggle,
      overlayVisible: () => true,
    }));
    stdin.write('q');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('overlay 激活时：Esc 关闭', () => {
    vi.useFakeTimers();
    const store = createInputStore();
    const onToggle = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, {
      store,
      onToggleOverlay: onToggle,
      overlayVisible: () => true,
    }));
    stdin.write('\x1b'); // ESC（ink 缓冲 20ms 后才 flush，需推进定时器）
    vi.advanceTimersByTime(30);
    expect(onToggle).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // bracketed paste → 占位符 的集成测试已迁移到 paste-inline-integration.test.tsx
  // （用 Ink 官方 usePaste 真实流程，而非手动模拟 paste-state）

  it('Ctrl+C 正常退出', () => {
    resetPasteState();
    const store = createInputStore();
    const onExit = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, { store, onExit }));
    stdin.write('\x03');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(store.getState().text).toBe('');
  });
});
