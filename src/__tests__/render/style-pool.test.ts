// src/__tests__/render/style-pool.test.ts
import { describe, it, expect } from 'vitest';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE, type Style } from '../../render/types.js';

describe('StylePool', () => {
  it('DEFAULT_STYLE 的 id = 0', () => {
    const p = new StylePool();
    expect(p.intern(DEFAULT_STYLE)).toBe(0);
  });

  it('intern 同样样式返回同 id（去重）', () => {
    const p = new StylePool();
    const s: Style = { ...DEFAULT_STYLE, bold: true };
    expect(p.intern(s)).toBe(p.intern({ ...DEFAULT_STYLE, bold: true }));
  });

  it('intern 不同样式返回不同 id', () => {
    const p = new StylePool();
    const id1 = p.intern({ ...DEFAULT_STYLE, bold: true });
    const id2 = p.intern({ ...DEFAULT_STYLE, italic: true });
    expect(id1).not.toBe(id2);
  });

  it('get(DEFAULT_STYLE id) → DEFAULT_STYLE', () => {
    const p = new StylePool();
    expect(p.get(0)).toEqual(DEFAULT_STYLE);
  });

  it('不存在的 id → get 返回 DEFAULT_STYLE（防御）', () => {
    const p = new StylePool();
    expect(p.get(99999)).toEqual(DEFAULT_STYLE);
  });

  it('transition 相同 id → 空串（无变化）', () => {
    const p = new StylePool();
    expect(p.transition(0, 0)).toBe('');
    const idBold = p.intern({ ...DEFAULT_STYLE, bold: true });
    expect(p.transition(idBold, idBold)).toBe('');
  });

  it('transition 默认 → bold：含 SGR 1', () => {
    const p = new StylePool();
    const idBold = p.intern({ ...DEFAULT_STYLE, bold: true });
    const seq = p.transition(0, idBold);
    expect(seq).toContain('\x1b[1m');
    expect(seq).toContain('\x1b[0m');  // 先 reset 再加 bold
  });

  it('transition 缓存：第二次调同 id 对返回同串', () => {
    const p = new StylePool();
    const idBold = p.intern({ ...DEFAULT_STYLE, bold: true });
    const seq1 = p.transition(0, idBold);
    const seq2 = p.transition(0, idBold);
    expect(seq1).toBe(seq2);
  });

  it('transition fg 颜色：含 38;2;R;G;B', () => {
    const p = new StylePool();
    const idColor = p.intern({ ...DEFAULT_STYLE, fg: 0xFF0000 });  // 红
    const seq = p.transition(0, idColor);
    expect(seq).toContain('38;2;255;0;0');
  });

  it('transition bg 颜色：含 48;2;R;G;B', () => {
    const p = new StylePool();
    const idColor = p.intern({ ...DEFAULT_STYLE, bg: 0x00FF00 });  // 绿
    const seq = p.transition(0, idColor);
    expect(seq).toContain('48;2;0;255;0');
  });

  it('migrate：把旧池 id 迁到新池', () => {
    const old = new StylePool();
    const idBold = old.intern({ ...DEFAULT_STYLE, bold: true });
    const fresh = new StylePool();
    const newId = old.migrate(idBold, fresh);
    expect(fresh.get(newId).bold).toBe(true);
  });
});
