// src/__tests__/render/types.test.ts
// 类型与常量：ERASE_CHAR_ID / Style 默认值 / 编解码辅助

import { describe, it, expect } from 'vitest';
import {
  ERASE_CHAR_ID,
  DEFAULT_STYLE,
  encodeStyleId,
  decodeStyleId,
  isFullWidthContinuation,
  type Style,
  type Patch,
  type CursorPos,
} from '../../render/types.js';

describe('render types', () => {
  it('ERASE_CHAR_ID = -1', () => {
    expect(ERASE_CHAR_ID).toBe(-1);
  });

  it('DEFAULT_STYLE 全空（fg=0/bg=0/无装饰）', () => {
    expect(DEFAULT_STYLE.fg).toBe(0);
    expect(DEFAULT_STYLE.bg).toBe(0);
    expect(DEFAULT_STYLE.bold).toBe(false);
    expect(DEFAULT_STYLE.italic).toBe(false);
    expect(DEFAULT_STYLE.underline).toBe(false);
    expect(DEFAULT_STYLE.inverse).toBe(false);
    expect(DEFAULT_STYLE.dim).toBe(false);
    expect(DEFAULT_STYLE.strikethrough).toBe(false);
  });

  it('encodeStyleId: poolId=5, fullWidth=false → 10', () => {
    expect(encodeStyleId(5, false)).toBe(10);
  });

  it('encodeStyleId: poolId=5, fullWidth=true → 11', () => {
    expect(encodeStyleId(5, true)).toBe(11);
  });

  it('decodeStyleId: 编码值 11 → poolId 5', () => {
    expect(decodeStyleId(11)).toBe(5);
  });

  it('decodeStyleId: 编码值 10 → poolId 5', () => {
    expect(decodeStyleId(10)).toBe(5);
  });

  it('isFullWidthContinuation: 编码值 11 → true', () => {
    expect(isFullWidthContinuation(11)).toBe(true);
  });

  it('isFullWidthContinuation: 编码值 10 → false', () => {
    expect(isFullWidthContinuation(10)).toBe(false);
  });

  it('编码 → 解码 round-trip 保持 poolId', () => {
    for (const poolId of [0, 1, 42, 9999]) {
      for (const fw of [false, true]) {
        const encoded = encodeStyleId(poolId, fw);
        expect(decodeStyleId(encoded)).toBe(poolId);
        expect(isFullWidthContinuation(encoded)).toBe(fw);
      }
    }
  });
});
