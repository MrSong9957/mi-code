// src/__tests__/tui/use-input-handler.test.tsx
// useInputHandler：Ink useInput 键事件 → input-store 操作

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { createInputStore, type InputStore } from '../../tui/state/input-store.js';
import { useInputHandler } from '../../tui/input/use-input-handler.js';

/** 用 input-store 渲染一个 probe，把当前 text 显示出来。
 *  onExit 可选，传给 useInputHandler。 */
function InputProbe({
  store,
  onExit,
  onTab,
  onToggleOverlay,
  overlayVisible,
}: {
  store: InputStore;
  onExit?: () => void;
  onTab?: (text: string) => void;
  onToggleOverlay?: () => void;
  overlayVisible?: () => boolean;
}): React.ReactElement {
  useInputHandler(store, onExit, onTab, onToggleOverlay, overlayVisible);
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
});
