// src/__tests__/tui\use-input-handler-completion.test.tsx
// 回归测试：斜杠命令下拉菜单的键盘交互（completionStore 单一数据源）。
//
// 物理本质：键盘 hook 必须读写 completionStore（而非 React Context），
// 因为 useInputHandler 在 DropdownProvider 之外执行，Context 拿到的是 no-op stub。
//
// 反作弊：所有断言读 store.getState()（真实副作用），不读 hook 返回值。

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { createInputStore, type InputStore } from '../../tui/state/input-store.js';
import { createCompletionStore, type CompletionStore } from '../../tui/state/completion-store.js';
import { useInputHandler } from '../../tui/input/use-input-handler.js';

/** Probe：挂载 hook，显示当前 input 文本。completionStore 必传。 */
function InputProbe({
  store,
  completionStore,
  onExit,
  onTab,
  onToggleOverlay,
  overlayVisible,
}: {
  store: InputStore;
  completionStore: CompletionStore;
  onExit?: () => void;
  onTab?: (text: string) => void;
  onToggleOverlay?: () => void;
  overlayVisible?: () => boolean;
}): React.ReactElement {
  useInputHandler(store, onExit, onTab, onToggleOverlay, overlayVisible, undefined, completionStore);
  const text = store.getState().text;
  return React.createElement(Text, {}, `text="${text}"`);
}

describe('useInputHandler: 斜杠命令下拉菜单（completionStore 单一数据源）', () => {
  it('输入 / → completionStore.visible=true 且 candidates 非空', () => {
    const store = createInputStore();
    const completionStore = createCompletionStore();
    const { stdin } = render(React.createElement(InputProbe, { store, completionStore }));
    stdin.write('/');
    const s = completionStore.getState();
    expect(s.visible).toBe(true);
    expect(s.candidates.length).toBeGreaterThan(0);
  });

  it('输入 /xxx（无匹配）→ completionStore.visible=false', () => {
    const store = createInputStore();
    const completionStore = createCompletionStore();
    const { stdin } = render(React.createElement(InputProbe, { store, completionStore }));
    stdin.write('/zzz');
    expect(completionStore.getState().visible).toBe(false);
  });

  it('↓ 箭头 → completionStore.index 从 0 递增', () => {
    const store = createInputStore();
    const completionStore = createCompletionStore();
    const { stdin } = render(React.createElement(InputProbe, { store, completionStore }));
    stdin.write('/'); // 触发下拉，index=0
    expect(completionStore.getState().index).toBe(0);
    stdin.write('\x1b[B'); // ↓
    expect(completionStore.getState().index).toBe(1);
  });

  it('↑ 箭头 → completionStore.index 循环回退（从 0 回到末位）', () => {
    const store = createInputStore();
    const completionStore = createCompletionStore();
    const { stdin } = render(React.createElement(InputProbe, { store, completionStore }));
    stdin.write('/');
    expect(completionStore.getState().index).toBe(0);
    stdin.write('\x1b[A'); // ↑
    const s = completionStore.getState();
    // index=0 时 ↑ 循环到末位
    expect(s.index).toBe(s.candidates.length - 1);
    expect(s.index).toBeGreaterThan(0);
  });

  it('Enter → 写回 input 为 /<selected> 并关闭下拉', () => {
    vi.useFakeTimers();
    const store = createInputStore();
    const completionStore = createCompletionStore();
    const { stdin } = render(React.createElement(InputProbe, { store, completionStore }));
    stdin.write('/');
    const selectedName = completionStore.getState().candidates[0];
    expect(selectedName).toBeTruthy();
    stdin.write('\r'); // Enter
    vi.advanceTimersByTime(30);
    expect(store.getState().text).toBe('/' + selectedName);
    expect(completionStore.getState().visible).toBe(false);
    vi.useRealTimers();
  });

  it('Esc → 关闭下拉（visible=false），不写回 input', () => {
    vi.useFakeTimers();
    const store = createInputStore();
    const completionStore = createCompletionStore();
    const { stdin } = render(React.createElement(InputProbe, { store, completionStore }));
    stdin.write('/');
    expect(completionStore.getState().visible).toBe(true);
    stdin.write('\x1b'); // Esc
    vi.advanceTimersByTime(30);
    expect(completionStore.getState().visible).toBe(false);
    // input 仍是 '/'（未写回候选）
    expect(store.getState().text).toBe('/');
    vi.useRealTimers();
  });

  it('Backspace 退掉 / → 关闭下拉', () => {
    const store = createInputStore();
    const completionStore = createCompletionStore();
    const { stdin } = render(React.createElement(InputProbe, { store, completionStore }));
    stdin.write('/'); // 开启下拉
    expect(completionStore.getState().visible).toBe(true);
    stdin.write('\x7f'); // Backspace，text 变空
    expect(completionStore.getState().visible).toBe(false);
    expect(store.getState().text).toBe('');
  });

  it('输入 /c → 候选实时过滤（全部以 c 开头）', () => {
    // ink-testing-library 每个 stdin.write 是一次 useInput 调用（非逐字符），
    // 故用两次 write 模拟真实逐字符输入：先 / 开启，再 c 过滤。
    const store = createInputStore();
    const completionStore = createCompletionStore();
    const { stdin } = render(React.createElement(InputProbe, { store, completionStore }));
    stdin.write('/');  // 开启下拉
    expect(completionStore.getState().visible).toBe(true);
    stdin.write('c');  // 过滤
    const { candidates } = completionStore.getState();
    expect(candidates.length).toBeGreaterThan(0);
    for (const name of candidates) {
      expect(name.startsWith('c')).toBe(true);
    }
  });
});
