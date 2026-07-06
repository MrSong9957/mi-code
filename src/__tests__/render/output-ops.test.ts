// src/__tests__/render/output-ops.test.ts
import { describe, it, expect } from 'vitest';
import { blit } from '../../render/output-ops.js';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE, decodeStyleId, isFullWidthContinuation, type Style } from '../../render/types.js';

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('blit', () => {
  it('写 ASCII 字符串：每字符占 1 cell，fullWidth=false', () => {
    const s = makeScreen(1, 5);
    blit(s, 0, 0, 'abc', DEFAULT_STYLE);
    const a = s.cellAt(0, 0);
    const b = s.cellAt(1, 0);
    const c = s.cellAt(2, 0);
    expect(s.charPool.get(a.charId)).toBe('a');
    expect(s.charPool.get(b.charId)).toBe('b');
    expect(s.charPool.get(c.charId)).toBe('c');
    expect(isFullWidthContinuation(a.encodedStyleId)).toBe(false);
    expect(isFullWidthContinuation(b.encodedStyleId)).toBe(false);
  });

  it('写 CJK 字符：占 2 cell，第二个 cell 是续位（fullWidthFlag=1）', () => {
    const s = makeScreen(1, 4);
    blit(s, 0, 0, '你', DEFAULT_STYLE);
    const head = s.cellAt(0, 0);
    const tail = s.cellAt(1, 0);
    expect(s.charPool.get(head.charId)).toBe('你');
    expect(s.charPool.get(tail.charId)).toBe('你');  // 续位存同 charId
    expect(isFullWidthContinuation(head.encodedStyleId)).toBe(false);
    expect(isFullWidthContinuation(tail.encodedStyleId)).toBe(true);
    expect(decodeStyleId(head.encodedStyleId)).toBe(decodeStyleId(tail.encodedStyleId));
  });

  it('写 emoji：占 2 cell，同 CJK 规则', () => {
    const s = makeScreen(1, 4);
    blit(s, 0, 0, '👋', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('👋');
    expect(isFullWidthContinuation(s.cellAt(1, 0).encodedStyleId)).toBe(true);
  });

  it('写混合：ASCII + CJK + ASCII', () => {
    const s = makeScreen(1, 6);
    blit(s, 0, 0, 'a你b', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('a');
    expect(s.charPool.get(s.cellAt(1, 0).charId)).toBe('你');  // CJK head
    expect(isFullWidthContinuation(s.cellAt(2, 0).encodedStyleId)).toBe(true);  // CJK tail
    expect(s.charPool.get(s.cellAt(3, 0).charId)).toBe('b');
  });

  it('行末裁剪：超出 cols 的字符不写', () => {
    const s = makeScreen(1, 3);
    blit(s, 0, 0, 'abcde', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('a');
    expect(s.charPool.get(s.cellAt(1, 0).charId)).toBe('b');
    expect(s.charPool.get(s.cellAt(2, 0).charId)).toBe('c');
    // d, e 未写（越界）
  });

  it('全角字符跨右边界：整字裁掉（不留半字）', () => {
    const s = makeScreen(1, 3);
    // cols=3，'ab你'：a(0),b(1),你 需占 (2,3)，但 3 越界 → 你 整字裁掉
    blit(s, 0, 0, 'ab你', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('a');
    expect(s.charPool.get(s.cellAt(1, 0).charId)).toBe('b');
    expect(s.charPool.get(s.cellAt(2, 0).charId)).toBe('');  // 空（你 被裁）
  });

  it('应用 Style：所有写入字符同 styleId', () => {
    const s = makeScreen(1, 3);
    const bold: Style = { ...DEFAULT_STYLE, bold: true };
    blit(s, 0, 0, 'ab', bold);
    const boldStyleId = s.stylePool.intern(bold);
    expect(decodeStyleId(s.cellAt(0, 0).encodedStyleId)).toBe(boldStyleId);
    expect(decodeStyleId(s.cellAt(1, 0).encodedStyleId)).toBe(boldStyleId);
  });

  it('多行文本（含 \\n）：换行写入', () => {
    const s = makeScreen(2, 3);
    blit(s, 0, 0, 'ab\ncd', DEFAULT_STYLE);
    expect(s.charPool.get(s.cellAt(0, 0).charId)).toBe('a');
    expect(s.charPool.get(s.cellAt(1, 0).charId)).toBe('b');
    expect(s.charPool.get(s.cellAt(0, 1).charId)).toBe('c');
    expect(s.charPool.get(s.cellAt(1, 1).charId)).toBe('d');
  });

  it('空字符串：无操作', () => {
    const s = makeScreen(1, 3);
    blit(s, 0, 0, '', DEFAULT_STYLE);
    expect(s.cellAt(0, 0).charId).toBe(0);
  });

  it('负坐标 / 越界 y：无操作（防御）', () => {
    const s = makeScreen(2, 3);
    blit(s, -1, 0, 'a', DEFAULT_STYLE);
    blit(s, 0, 99, 'a', DEFAULT_STYLE);
    expect(s.cellAt(0, 0).charId).toBe(0);
  });
});
