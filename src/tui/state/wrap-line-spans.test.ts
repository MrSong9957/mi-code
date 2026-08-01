// src/tui/state/wrap-line-spans.test.ts
// Step 3:wrapLineWithSpans —— 带物理行宽度、源区间、cursorColMap 的 span 折行。
//
// 与 wrapLine() 共用同一断行核心(wrapCore);wrapLine 改调 wrapLineWithSpans(text,w,w).map(.text)。
// 关键契约:
// - 首物理行用 firstWidth,续物理行用 continuationWidth;
// - span / source range / cursorColMap 必须在断行过程中产生,禁止从最终字符串反推;
// - 空格断行用 trim 后的 visibleWidth(不含待丢弃空格);被丢弃空格的 srcOffset 是 colMap 的 key,
//   但列值 = 前一可见字符的列(空格不计显示列)。

import { describe, it, expect } from 'vitest';
import { wrapLineWithSpans, wrapLine } from './wrap-line.js';

describe('wrapLineWithSpans', () => {
  it('firstWidth===continuationWidth 时,spans.map(s=>s.text) 与 wrapLine 完全一致', () => {
    const cases: Array<[string, number]> = [
      ['hello world', 10],
      ['a'.repeat(100), 79],
      ['中'.repeat(10), 10],
      ['a b c', 3],
    ];
    for (const [text, w] of cases) {
      const spans = wrapLineWithSpans(text, w, w);
      const lines = wrapLine(text, w);
      expect(spans.map(s => s.text), `text=${JSON.stringify(text)} w=${w}`).toEqual(lines);
    }
  });

  it('空文本:1 span,text="",charStart=0,charEnd=0,breakKind=none,cursorColMap:{0:0}', () => {
    expect(wrapLineWithSpans('', 80, 80)).toMatchObject([{
      text: '', charStart: 0, charEnd: 0, breakKind: 'none', cursorColMap: { 0: 0 },
    }]);
  });

  it('首行宽 5、续行宽 10:abcdefghij → abcde / fghij', () => {
    const s = wrapLineWithSpans('abcdefghij', 5, 10);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ text: 'abcde', charStart: 0, charEnd: 5, breakKind: 'none' });
    expect(s[1]).toMatchObject({ text: 'fghij', charStart: 5, charEnd: 10, breakKind: 'soft' });
  });

  it('hello world:空格丢弃,第一行 [0,6),第二行 [6,11)', () => {
    const s = wrapLineWithSpans('hello world', 10, 10);
    expect(s[0]).toMatchObject({ text: 'hello', charStart: 0, charEnd: 6 });
    expect(s[1]).toMatchObject({ text: 'world', charStart: 6, charEnd: 11 });
  });

  it('CJK 连续无空格:源区间无间隙', () => {
    const s = wrapLineWithSpans('中'.repeat(10), 10, 10);
    expect(s[0]!.charEnd).toBe(s[1]!.charStart);
  });

  it('极窄 width=1:每字符独占一物理行,不丢字符', () => {
    const s = wrapLineWithSpans('abc', 1, 1);
    expect(s).toHaveLength(3);
    expect(s.map(x => x.text)).toEqual(['a', 'b', 'c']);
    expect(s[0]).toMatchObject({ charStart: 0, charEnd: 1 });
    expect(s[2]).toMatchObject({ charStart: 2, charEnd: 3 });
  });

  it('极窄 width≤0 钳到 1(不产生负/零宽)', () => {
    const s = wrapLineWithSpans('ab', 0, -1);
    expect(s).toHaveLength(2);
    expect(s.map(x => x.text)).toEqual(['a', 'b']);
  });

  // === dropped-space map:首次实现(Step 3 wrapped span 层) ===
  it('dropped-space map:hello world 空格 offset 5 → 列 5;第一行边界 offset 6(下一行起点)→ 列 5', () => {
    const s = wrapLineWithSpans('hello world', 10, 10);
    expect(s[0]!.cursorColMap[5]).toBe(5);  // 被丢弃空格(srcOffset=5)→ 列 5('o' 后,空格不计列)
    expect(s[0]!.cursorColMap[6]).toBe(5);  // 行末边界 = 下一行起点(srcOffset=6)→ 前一行可见末列 5
  });

  it('dropped-space map:aa   bb offsets 2/3/4 → 列 2', () => {
    const s = wrapLineWithSpans('aa   bb', 5, 5);
    expect(s[0]!.cursorColMap[2]).toBe(2);
    expect(s[0]!.cursorColMap[3]).toBe(2);
    expect(s[0]!.cursorColMap[4]).toBe(2);
  });

  it('dropped-space map:第二行 map 包含 {5:0,6:1,7:2}', () => {
    const s = wrapLineWithSpans('aa   bb', 5, 5);
    expect(s[1]!.cursorColMap).toMatchObject({ 5: 0, 6: 1, 7: 2 });
  });
});
