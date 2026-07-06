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

describe('input-store 多行', () => {
  it('insertNewline：在光标处插 \\n，光标+1', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().moveCursorTo(1); // a|bc
    store.getState().insertNewline(); // a\n|bc
    expect(store.getState().text).toBe('a\nbc');
    expect(store.getState().cursor).toBe(2);
  });

  it('insertNewline 上限 3 行：第 3 行时不插入', () => {
    const store = createInputStore();
    store.getState().insert('a\nb\nc'); // 已 3 行
    store.getState().moveCursorToEnd();
    store.getState().insertNewline(); // 应被拒
    expect(store.getState().text).toBe('a\nb\nc');
  });

  it('insertNewline 在 2 行时允许变 3 行', () => {
    const store = createInputStore();
    store.getState().insert('a\nb');
    store.getState().moveCursorToEnd();
    store.getState().insertNewline();
    expect(store.getState().text).toBe('a\nb\n');
  });

  it('moveCursorDown：跨行下移，保留列', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorTo(2); // ab|c（第 0 行 col 2）
    store.getState().moveCursorDown(); // → 第 1 行 col 2（'f'，索引 6）
    expect(store.getState().cursor).toBe(6);
  });

  it('moveCursorDown 末行：无操作', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorToEnd(); // 第 1 行末（索引 7）
    store.getState().moveCursorDown();
    expect(store.getState().cursor).toBe(7);
  });

  it('moveCursorUp：跨行上移，保留列（钳到上行长度）', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorTo(5); // 第 1 行 col 1（'e'）
    store.getState().moveCursorUp(); // → 第 0 行 col 1（'b'，索引 1）
    expect(store.getState().cursor).toBe(1);
  });

  it('moveCursorUp 第 0 行：无操作', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorTo(0);
    store.getState().moveCursorUp();
    expect(store.getState().cursor).toBe(0);
  });

  it('moveCursorUp 列超出上行长度：钳到上行末尾', () => {
    const store = createInputStore();
    store.getState().insert('ab\ndefgh'); // 上行 2 字符，下行 5
    store.getState().moveCursorTo(6); // 第 1 行 col 2（'f'）
    store.getState().moveCursorUp(); // → 第 0 行 col min(2,2)=2 = 末尾
    expect(store.getState().cursor).toBe(2);
  });
});
