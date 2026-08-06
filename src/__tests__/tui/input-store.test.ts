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

  it('insertNewline 在 2 行时允许变 3 行', () => {
    const store = createInputStore();
    store.getState().insert('a\nb');
    store.getState().moveCursorToEnd();
    store.getState().insertNewline();
    expect(store.getState().text).toBe('a\nb\n');
  });

  it('insertNewline 可超过 3 行（视口接管，不再有硬上限）', () => {
    // 旧设计：3 行硬上限，第 3 行时 insertNewline 被拒。
    // 新设计：任意行数，超出 MAX_VISIBLE_INPUT_LINES 由视口滚动处理（见 input-viewport.ts）。
    const store = createInputStore();
    store.getState().insert('a\nb\nc\nd\ne'); // 已 5 行
    store.getState().moveCursorToEnd();
    store.getState().insertNewline(); // 应成功，变 6 行
    expect(store.getState().text).toBe('a\nb\nc\nd\ne\n');
    expect(store.getState().text.split('\n').length).toBe(6);
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

  it('deleteToLineStart：删光标到行首（行中间）', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    store.getState().moveCursorTo(3); // hel|lo
    store.getState().deleteToLineStart(); // → |lo（删整行内容到行首）
    expect(store.getState().text).toBe('lo');
    expect(store.getState().cursor).toBe(0);
  });

  it('deleteToLineStart：光标在行首时删除整行（连 \n 一起删）', () => {
    // 新语义：光标在行首再按 Ctrl+U，删整行（含换行符），光标移到上一行末尾。
    // 这是「连续 Ctrl+U 逐行删除」的关键——旧语义卡住不动，新语义继续往上删。
    const store = createInputStore();
    store.getState().insert('abc\ndef'); // 第0行 abc，第1行 def
    store.getState().moveCursorTo(4); // 第1行行首（d 之前）
    store.getState().deleteToLineStart(); // 删第1行（含 \n）→ 剩 'abc'，光标到第0行末
    expect(store.getState().text).toBe('abc');
    expect(store.getState().cursor).toBe(3);
  });

  it('deleteToLineStart：光标在首行行首时删到空', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    store.getState().moveCursorToStart(); // 首行行首
    store.getState().deleteToLineStart(); // 删整行 → 空
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
  });

  it('deleteToLineStart：多行中间行删到行首', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndefgh'); // 第0行 abc，第1行 defgh
    store.getState().moveCursorTo(7); // 第1行 col 2（'g'，索引 7）
    store.getState().deleteToLineStart(); // → 第1行剩 'gh'，第0行不变
    expect(store.getState().text).toBe('abc\ngh');
    expect(store.getState().cursor).toBe(4); // 第1行行首（abc\n 之后）
  });

  it('deleteToLineStart：CJK 码点安全', () => {
    const store = createInputStore();
    store.getState().insert('你好世界');
    store.getState().moveCursorTo(2); // 你好|世界
    store.getState().deleteToLineStart(); // → |世界
    expect(store.getState().text).toBe('世界');
    expect(store.getState().cursor).toBe(0);
  });

  it('deleteToLineStart【核心契约】：连续按能从末行逐行删到全空', () => {
    expect.hasAssertions();
    // 模拟用户一直按 Ctrl+U：每次删一行，光标自动跳到上一行末尾，继续删。
    // 最终所有内容被删空。
    const store = createInputStore();
    store.getState().insert('aaa\nbbb\nccc');
    store.getState().moveCursorToEnd(); // 第2行末尾
    // 连续按到 text 为空（设上限防爆）
    let presses = 0;
    while (store.getState().text !== '' && presses < 20) {
      store.getState().deleteToLineStart();
      presses++;
    }
    expect(store.getState().text).toBe('');
    expect(store.getState().cursor).toBe(0);
    // 应在有限次内删空（3 行内容，每行删一次到行首 + 删整行交替）
    expect(presses).toBeLessThan(20);
  });

  it('deleteToLineStart【随机化防作弊】：任意多行输入连续删最终必空', () => {
    expect.hasAssertions();
    for (let trial = 0; trial < 10; trial++) {
      const lineCount = 1 + Math.floor(Math.random() * 6);
      const lines: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        // 随机内容（含 CJK），定宽前缀避免子串污染
        const isCjk = Math.random() < 0.5;
        lines.push(isCjk ? `行${i}` : `l${i}`);
      }
      const store = createInputStore();
      store.getState().insert(lines.join('\n'));
      store.getState().moveCursorToEnd();
      // 连续删到空
      let presses = 0;
      while (store.getState().text !== '' && presses < 30) {
        store.getState().deleteToLineStart();
        presses++;
      }
      // 不变量：无论内容/行数/光标位置，最终必删空
      expect(store.getState().text).toBe('');
      expect(store.getState().cursor).toBe(0);
    }
  });
});

describe('input-store pasteRanges 字段（初始化）', () => {
  it('初始：pasteRanges 为空数组', () => {
    const store = createInputStore();
    expect(store.getState().pasteRanges).toEqual([]);
  });
});

describe('insertPaste / insert / insertNewline（range 创建与手敲同步）', () => {
  it('insertPaste：在光标处插入并创建 range', () => {
    const store = createInputStore();
    store.getState().insertPaste('ABC');
    expect(store.getState().text).toBe('ABC');
    expect(store.getState().cursor).toBe(3);
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('insertPaste 在已有文本后方：range 起点是当前 cursor', () => {
    const store = createInputStore();
    store.getState().insert('xx');        // cursor=2, text='xx'
    store.getState().insertPaste('ABC');  // range {2,5}
    expect(store.getState().pasteRanges).toEqual([{ start: 2, end: 5 }]);
    expect(store.getState().text).toBe('xxABC');
  });

  it('insert（手敲）紧贴 range.end 后方插入：不破坏该 range', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');  // range {0,3}, cursor=3
    store.getState().insert('x');         // editStart=3==end=3 → reconcile 规则2 不变
    expect(store.getState().text).toBe('AAAx');
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 3 }]);
  });

  it('insert（手敲）插进 range 内部：该 range 失效', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAAA');  // range {0,4}, cursor=4
    store.getState().moveCursorTo(2);      // 进内部 AA|AA
    store.getState().insert('x');          // editStart=2 < end=4 → 触及 → 丢弃
    expect(store.getState().text).toBe('AAxAA');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('insert（手敲）在 range 前方插入：range 右移（正 delta）', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // range {0,3}
    store.getState().moveCursorTo(0);
    store.getState().insert('x');          // editStart=0, editEnd=0 <= r.start=0 → 规则1 右移 +1
    expect(store.getState().text).toBe('xAAA');
    expect(store.getState().pasteRanges).toEqual([{ start: 1, end: 4 }]);
  });

  it('insertPaste 空字符串：不创建空 range', () => {
    const store = createInputStore();
    store.getState().insertPaste('');
    expect(store.getState().text).toBe('');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('insertNewline：等同 insert("\\n")，与 range 同步', () => {
    const store = createInputStore();
    store.getState().insertPaste('AAA');   // range {0,3}
    store.getState().moveCursorTo(1);      // 进内部
    store.getState().insertNewline();      // 触及 → 丢弃
    expect(store.getState().text).toBe('A\nAA');
    expect(store.getState().pasteRanges).toEqual([]);
  });

  it('非 BMP 坐标闭合：insertPaste 后立即断言防 surrogate 假阳性', () => {
    // 𝄞 = U+1D11E，1 code point / 2 UTF-16 unit。
    // 关键：insertPaste('X') 后立即断言 text/cursor，捕获 surrogate 被拆又恢复的假阳性。
    const store = createInputStore();
    store.getState().insertPaste('𝄞');      // text='𝄞', cursor=1, range {0,1}
    store.getState().insertPaste('X');      // 立即断言
    expect(store.getState().text).toBe('𝄞X'); // 若坐标错（UTF-16）：text 可能乱码
    expect(store.getState().cursor).toBe(2);   // 若坐标错：cursor=3（surrogate 计 2）
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  });
});
