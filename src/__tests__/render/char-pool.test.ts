// src/__tests__/render/char-pool.test.ts
import { describe, it, expect } from 'vitest';
import { CharPool } from '../../render/char-pool.js';

describe('CharPool', () => {
  it('intern 空串 → 0（空白占位）', () => {
    const p = new CharPool();
    expect(p.intern('')).toBe(0);
  });

  it('intern 单 ASCII 字符 → id >= 1', () => {
    const p = new CharPool();
    const id = p.intern('a');
    expect(id).toBeGreaterThanOrEqual(1);
    expect(p.get(id)).toBe('a');
  });

  it('intern 同一字符返回同一 id（去重）', () => {
    const p = new CharPool();
    const id1 = p.intern('a');
    const id2 = p.intern('a');
    expect(id1).toBe(id2);
  });

  it('intern 不同字符返回不同 id', () => {
    const p = new CharPool();
    const id1 = p.intern('a');
    const id2 = p.intern('b');
    expect(id1).not.toBe(id2);
  });

  it('ASCII 快速路径：所有 128 个 ASCII 字符可 intern', () => {
    const p = new CharPool();
    for (let c = 0; c < 128; c++) {
      const ch = String.fromCharCode(c);
      const id = p.intern(ch);
      expect(p.get(id)).toBe(ch);
    }
  });

  it('ASCII 复用：第二次 intern 同字符同 id（快速路径命中）', () => {
    const p = new CharPool();
    const id1 = p.intern('x');
    const id2 = p.intern('x');
    expect(id1).toBe(id2);
  });

  it('CJK 字符：intern + get round-trip', () => {
    const p = new CharPool();
    const id = p.intern('你');
    expect(p.get(id)).toBe('你');
  });

  it('CJK 同字去重', () => {
    const p = new CharPool();
    expect(p.intern('你')).toBe(p.intern('你'));
  });

  it('emoji：intern + get round-trip', () => {
    const p = new CharPool();
    const id = p.intern('👋');
    expect(p.get(id)).toBe('👋');
  });

  it('不存在的 id → get 返回空格（防御）', () => {
    const p = new CharPool();
    expect(p.get(99999)).toBe(' ');
  });

  it('size：返回池子条目数（含 index 0 空白）', () => {
    const p = new CharPool();
    expect(p.size()).toBe(1);  // 初始只有空白
    p.intern('a');
    p.intern('b');
    p.intern('a');  // 去重
    expect(p.size()).toBe(3);  // '', 'a', 'b'
  });

  it('migrate：把旧池的 id 映射到新池（用于 resetPools）', () => {
    const old = new CharPool();
    const idA = old.intern('a');
    const idYou = old.intern('你');
    const fresh = new CharPool();
    const newIdA = old.migrate(idA, fresh);
    const newIdYou = old.migrate(idYou, fresh);
    expect(fresh.get(newIdA)).toBe('a');
    expect(fresh.get(newIdYou)).toBe('你');
    // 新池自己 intern 同字符得同 id
    expect(fresh.intern('a')).toBe(newIdA);
  });
});
