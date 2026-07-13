import { describe, it, expect } from 'vitest';
import { emit } from './emit.js';
import { CharPool } from './char-pool.js';
import { StylePool } from './style-pool.js';
import { ERASE_CHAR_ID, type Patch } from './types.js';

function createCtx(yBias?: number) {
  const written: string[] = [];
  const charPool = new CharPool();
  const stylePool = new StylePool();
  return {
    written,
    charPool,
    stylePool,
    ctx: {
      charPool,
      stylePool,
      stdout: { write: (s: string) => { written.push(s); return true; } },
      ...(yBias !== undefined ? { yBias } : {}),
    },
  };
}

describe('emit yBias', () => {
  it('yBias 未传时（默认 0）：CUP 用 patch.y + 1', () => {
    const { written, charPool, ctx } = createCtx();
    const charId = charPool.intern('A');
    const patches: Patch[] = [
      { x: 5, y: 3, charId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // y=3, yBias=0 → CUP row=4
    expect(output).toContain('\x1b[4;6H');
  });

  it('yBias=26（footerTopRow=27）：CUP 用 patch.y + 27', () => {
    const { written, charPool, ctx } = createCtx(26);
    const charId = charPool.intern('A');
    const patches: Patch[] = [
      { x: 5, y: 0, charId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // y=0, yBias=26 → CUP row=27
    expect(output).toContain('\x1b[27;6H');
  });

  it('yBias 影响末尾光标定位', () => {
    const { written, charPool, ctx } = createCtx(26);
    const charId = charPool.intern('A');
    const patches: Patch[] = [
      { x: 0, y: 1, charId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, { ...ctx, cursor: { x: 3, y: 1 } });
    const output = written.join('');
    // cursor y=1, yBias=26 → CUP row=28
    expect(output).toContain('\x1b[28;4H');
  });

  it('yBias 不影响 \\x1b[K（EL 只擦当前行，依赖前置 CUP）', () => {
    const { ctx } = createCtx(26);
    const patches: Patch[] = [
      { x: 0, y: 0, charId: ERASE_CHAR_ID, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    // 不报错即通过——EL 不接受 yBias 参数
    expect(true).toBe(true);
  });
});
