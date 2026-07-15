import { describe, it, expect } from 'vitest';
import { CharPool } from './char-pool.js';

describe('CharPool.widthOf', () => {
  it('半角字符 width=1', () => {
    const pool = new CharPool();
    const id = pool.intern('A');
    expect(pool.widthOf(id)).toBe(1);
  });

  it('全角字符（CJK）width=2', () => {
    const pool = new CharPool();
    const id = pool.intern('中');
    expect(pool.widthOf(id)).toBe(2);
  });

  it('空字符串 width=0', () => {
    const pool = new CharPool();
    const id = pool.intern('');
    expect(pool.widthOf(id)).toBe(0);
  });

  it('同一字符多次 intern 返回相同 charId 和 width', () => {
    const pool = new CharPool();
    const id1 = pool.intern('A');
    const id2 = pool.intern('A');
    expect(id1).toBe(id2);
    expect(pool.widthOf(id1)).toBe(1);
  });

  it('ASCII 快速路径也记录 width', () => {
    const pool = new CharPool();
    const id = pool.intern('Z');
    expect(pool.widthOf(id)).toBe(1);
  });

  it('emoji width=2', () => {
    const pool = new CharPool();
    const id = pool.intern('😀');
    expect(pool.widthOf(id)).toBe(2);
  });

  it('migrate 后 width 保持正确', () => {
    const oldPool = new CharPool();
    const oldId = oldPool.intern('中');
    const fresh = new CharPool();
    const newId = oldPool.migrate(oldId, fresh);
    expect(fresh.widthOf(newId)).toBe(2);
  });

  it('不存在的 charId 返回默认 width=1', () => {
    const pool = new CharPool();
    expect(pool.widthOf(999)).toBe(1);
  });
});
