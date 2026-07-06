// src/__tests__/tui/input-store.test.ts
// 输入态 store：文本编辑 + 光标 + 提交回调

import { describe, it, expect, vi } from 'vitest';
import { createInputStore } from '../../tui/state/input-store.js';

describe('input-store（文本编辑 + 光标）', () => {
  it('初始：空文本，光标在 0', () => {
    const store = createInputStore();
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
  });

  it('insert(char)：在光标处插入，光标前移', () => {
    const store = createInputStore();
    store.getState().insert('h');
    store.getState().insert('i');
    expect(store.getState().text).toBe('hi');
    expect(store.getState().cursor).toBe(2);
  });

  it('insert 多字符：整串插入', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    expect(store.getState().text).toBe('hello');
    expect(store.getState().cursor).toBe(5);
  });

  it('光标中插入：在中间插入字符', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    store.getState().moveCursorTo(2); // he|llo
    store.getState().insert('X'); // heX|llo
    expect(store.getState().text).toBe('heXllo');
    expect(store.getState().cursor).toBe(3);
  });

  it('backspace：删光标前一字符，光标后移', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().moveCursorTo(2); // ab|c
    store.getState().backspace(); // a|c
    expect(store.getState().text).toBe('ac');
    expect(store.getState().cursor).toBe(1);
  });

  it('backspace 在光标=0 时无操作', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().moveCursorTo(0);
    store.getState().backspace();
    expect(store.getState().text).toBe('abc');
    expect(store.getState().cursor).toBe(0);
  });

  it('deleteForward：删光标处字符（Delete 键）', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().moveCursorTo(1); // a|bc
    store.getState().deleteForward(); // a|c
    expect(store.getState().text).toBe('ac');
    expect(store.getState().cursor).toBe(1);
  });

  it('moveCursorLeft / moveCursorRight 边界', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().moveCursorTo(0);
    store.getState().moveCursorLeft(); // 已在最左，不动
    expect(store.getState().cursor).toBe(0);
    store.getState().moveCursorTo(3);
    store.getState().moveCursorRight(); // 已在最右，不动
    expect(store.getState().cursor).toBe(3);
  });

  it('moveCursorToStart / moveCursorToEnd', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    store.getState().moveCursorToStart();
    expect(store.getState().cursor).toBe(0);
    store.getState().moveCursorToEnd();
    expect(store.getState().cursor).toBe(5);
  });

  it('clear：清空文本，光标归 0', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    store.getState().clear();
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
  });

  it('submit：调用 onSubmit 回调传入 trim 后文本，并清空', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    store.getState().insert('  hello  ');
    const result = store.getState().submit();
    expect(result).toBe('hello');
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
  });

  it('submit 空文本：返回 null，不触发 onSubmit', () => {
    const onSubmit = vi.fn();
    const store = createInputStore({ onSubmit });
    const result = store.getState().submit();
    expect(result).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('moveCursorTo 钳位到 [0, text.length]', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().moveCursorTo(-5);
    expect(store.getState().cursor).toBe(0);
    store.getState().moveCursorTo(999);
    expect(store.getState().cursor).toBe(3);
  });
});

describe('input-store setText（补全用）', () => {
  it('setText：整串替换，光标移到末尾', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().setText('/plan');
    expect(store.getState().text).toBe('/plan');
    expect(store.getState().cursor).toBe(5);
  });

  it('setText 空串：清空，光标归 0', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().setText('');
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
  });

  it('setText CJK：光标按码点数', () => {
    const store = createInputStore();
    store.getState().setText('/你好');
    expect(store.getState().cursor).toBe(3);
  });
});
