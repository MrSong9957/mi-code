// src/__tests__/tui/ctrl-j-multiline-contract.test.tsx
// Ctrl+J 多行输入完整契约回归测试。
//
// 锁定原始 bug 的完整契约（任何一条破坏都应失败）：
//   Ctrl+J → 不 submit → 插入 "\n" → cursor 正确后移 → 输入仍处于编辑态 → 最终 TUI 显示为两行
//
// 字节层：真实终端 Ctrl+J 发送字节 0x0a（= "\n"）。
// 回调层：Ink useInput 的 inputParser 把 0x0a 规范化为 { input:'j', key.ctrl:true }，
//         useInputHandler 据 key.ctrl && input==='j' 分流到 insertNewline（不进 submit 分支）。
// 本测试用 ink-testing-library 的 stdin.write('\n') 模拟真实字节 0x0a。

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { createInputStore } from '../../tui/state/input-store.js';
import { useInputHandler } from '../../tui/input/use-input-handler.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

/** 渲染 probe，挂载 useInputHandler，显示当前 text + cursor。store 直接持有 onSubmit。 */
function InputProbe({ store }: { store: ReturnType<typeof createInputStore> }): React.ReactElement {
  useInputHandler(
    store,
    undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    createSpinnerStore(), undefined, undefined, undefined,
  );
  const s = store.getState();
  return React.createElement(Text, {}, `text="${s.text}" cursor=${s.cursor}`);
}

describe('Ctrl+J 多行输入完整契约', () => {
  it('Ctrl+J 插入 \\n,cursor 后移,不触发 submit,输入仍编辑态', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    store.getState().insert('abc');  // 初始输入,cursor 在末尾(=3)

    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\n');  // 真实 Ctrl+J = 0x0a = \n

    const s = store.getState();
    expect(s.text).toBe('abc\n');      // 契约 1:插入了 \n
    expect(s.cursor).toBe(4);           // 契约 2:cursor 后移到 \n 之后
    expect(onSubmit).not.toHaveBeenCalled();  // 契约 3:submit 未触发
    expect(s.text).not.toBe('');        // 契约 4:输入仍编辑态(未清空)
  });

  it('Ctrl+J 在中间位置插入 \\n,cursor 正确', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    store.getState().insert('abc');
    store.getState().moveCursorTo(1);  // a|bc

    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\n');

    const s = store.getState();
    expect(s.text).toBe('a\nbc');
    expect(s.cursor).toBe(2);           // \n 在 index 1,cursor 后移到 2
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Ctrl+J 连续两次(AAA → Ctrl+J → BBB → Ctrl+J)→ 两行 + 仍不 submit', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    store.getState().insert('AAA');

    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\n');       // Ctrl+J → AAA\n
    stdin.write('BBB');      // 输入 BBB
    stdin.write('\n');       // 再 Ctrl+J → AAA\nBBB\n

    const s = store.getState();
    expect(s.text).toBe('AAA\nBBB\n');
    expect(s.cursor).toBe(8);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter(\\r) 触发 submit, Ctrl+J(\\n) 不触发 — 两者互斥', () => {
    // Enter:应触发 submit
    const onSubmitEnter = vi.fn();
    const storeEnter = createInputStore({ onSubmit: onSubmitEnter });
    storeEnter.getState().insert('x');
    const r1 = render(React.createElement(InputProbe, { store: storeEnter }));
    r1.stdin.write('\r');  // Enter = \r
    expect(onSubmitEnter).toHaveBeenCalledTimes(1);

    // Ctrl+J:不应触发 submit
    const onSubmitCtrlJ = vi.fn();
    const storeCtrlJ = createInputStore({ onSubmit: onSubmitCtrlJ });
    storeCtrlJ.getState().insert('x');
    const r2 = render(React.createElement(InputProbe, { store: storeCtrlJ }));
    r2.stdin.write('\n');  // Ctrl+J = \n
    expect(onSubmitCtrlJ).not.toHaveBeenCalled();
    expect(storeCtrlJ.getState().text).toBe('x\n');
  });
});
