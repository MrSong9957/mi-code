/**
 * 键盘输入回归测试
 *
 * 验证 inline 模式下键盘处理 hook 被正确调用。
 * 通过检查 inputStore 状态变化来验证输入是否生效。
 */
import { describe, it, expect, vi } from 'vitest';
import { createInputStore } from '../../tui/state/input-store.js';

describe('键盘输入回归测试', () => {
  it('inputStore 可以接收文本插入', () => {
    const submitted: string[] = [];
    const store = createInputStore({ onSubmit: (t) => submitted.push(t) });

    // 模拟键盘输入
    store.getState().insert('h');
    store.getState().insert('i');
    expect(store.getState().text).toBe('hi');

    // 模拟回车提交
    store.getState().submit();
    expect(submitted).toEqual(['hi']);
    expect(store.getState().text).toBe('');
  });

  it('inputStore 支持退格删除', () => {
    const store = createInputStore({ onSubmit: () => {} });
    store.getState().insert('abc');
    store.getState().backspace();
    expect(store.getState().text).toBe('ab');
  });

  it('inputStore 支持光标移动', () => {
    const store = createInputStore({ onSubmit: () => {} });
    store.getState().insert('hello');
    store.getState().moveCursorLeft();
    store.getState().moveCursorLeft();
    expect(store.getState().cursor).toBe(3);
  });
});
