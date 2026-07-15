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

  it('ERASE patch 写空格（不使用 \\x1b[K，避免误擦同行后续 cell）', () => {
    const { written, ctx } = createCtx(26);
    const patches: Patch[] = [
      { x: 0, y: 0, charId: ERASE_CHAR_ID, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // ERASE 写空格，不用 \x1b[K
    expect(output).toContain(' ');
    expect(output).not.toContain('\x1b[K');
  });

  it('同行 ERASE 在前 + 字符在后：字符不被误擦（\\x1b[K bug 回归）', () => {
    const { written, charPool, ctx } = createCtx(0);
    const wId = charPool.intern('W');
    // 模拟 diff 场景：cell(0,0) 从有内容→空格(ERASE)，cell(1,0) 从空格→'W'
    // optimizer 按 (y,x) 排序后 ERASE 在前、'W' 在后
    const patches: Patch[] = [
      { x: 0, y: 0, charId: ERASE_CHAR_ID, styleId: 0, isFullWidthContinuation: false },
      { x: 1, y: 0, charId: wId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // 'W' 必须出现在输出中——\x1b[K 会擦掉它，空格不会
    expect(output).toContain('W');
    // 确认没有 \x1b[K（它会导致 'W' 丢失）
    expect(output).not.toContain('\x1b[K');
  });
});

describe('emit cursorMove 模式', () => {
  function createCtxMove() {
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
        useCursorMove: true,
      } as Parameters<typeof emit>[1],
    };
  }

  it('首 patch 用 CUP 建基准，后续邻接 patch 不发 CUP', () => {
    const { written, charPool, ctx } = createCtxMove();
    const aId = charPool.intern('A');
    const bId = charPool.intern('B');
    // 两个相邻 patch：(0,0)='A', (1,0)='B'（B 邻接 A）
    const patches: Patch[] = [
      { x: 0, y: 0, charId: aId, styleId: 0, isFullWidthContinuation: false },
      { x: 1, y: 0, charId: bId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // 首 patch 有 CUP（\x1b[1;1H）
    expect(output).toContain('\x1b[1;1H');
    // 'A' 和 'B' 都出现
    expect(output).toContain('A');
    expect(output).toContain('B');
    // CUP 只出现一次（首 patch）；第二个 patch 邻接（dx=0，光标已在 x=1）→ 不发 CUP 也不发 cursorForward
    const cupCount = (output.match(/\x1b\[\d+;\d+H/g) ?? []).length;
    expect(cupCount).toBe(1);
    // 不应有 cursorForward（dx=0 不需要移动）
    expect(output).not.toContain('\x1b[1C');
  });

  it('全角字符后光标 +2：下一个 patch 邻接命中（不发 CUP）', () => {
    const { written, charPool, ctx } = createCtxMove();
    const cjkId = charPool.intern('中');  // width=2
    const nextId = charPool.intern('X');  // width=1
    // (0,0)='中' (width=2) → 光标到 x=2
    // (2,0)='X' → 邻接（dx=2-0=... 不对，dx=2-0=2 不是 1）
    // 等等：写 '中' 后 curX = 0 + 2 = 2。下一个 patch x=2。dx = 2 - 2 = 0？
    // 不对——curX 更新为 0+2=2，下一个 patch x=2，dx=0 → 不邻接
    // 但实际终端写 '中' 后光标在 col 2，写 'X' 应该在 col 2 → 邻接！
    // curX 更新为 2 后，patch.x=2 → dx=0，不是邻接（dx===1 才邻接）
    // 所以应该有 cursorForward 或 CUP
    const patches: Patch[] = [
      { x: 0, y: 0, charId: cjkId, styleId: 0, isFullWidthContinuation: false },
      { x: 2, y: 0, charId: nextId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // 'X' 必须出现
    expect(output).toContain('X');
    // 全角后光标 +2，下一个 patch x=2 正好是 curX=2 → dx=0
    // dx=0 意味着光标已在正确位置，不需要移动
    // 但 dx===0 不等于 dx===1（邻接），需要特殊处理
    // 实际上：写完全角后 curX=2，patch.x=2 → 不需要移动光标
    // CUP 只应有首 patch 的一次
    const cupCount = (output.match(/\x1b\[\d+;\d+H/g) ?? []).length;
    expect(cupCount).toBe(1);  // 只有首 patch 的 CUP
  });

  it('换行时用 \\r + cursorForward（不用 cursorBack）', () => {
    const { written, charPool, ctx } = createCtxMove();
    const aId = charPool.intern('A');
    const bId = charPool.intern('B');
    // (0,0)='A' → curX=1
    // (5,1)='B' → 换行 dy=1, dx=5
    const patches: Patch[] = [
      { x: 0, y: 0, charId: aId, styleId: 0, isFullWidthContinuation: false },
      { x: 5, y: 1, charId: bId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // 换行应该用 \r + cursorDown + cursorForward
    expect(output).toContain('\r');
    expect(output).toContain('\x1b[1B');  // cursorDown(1)
    expect(output).toContain('\x1b[5C');  // cursorForward(5)
    // 不应有多余的 CUP（首 patch 除外）
    const cupCount = (output.match(/\x1b\[\d+;\d+H/g) ?? []).length;
    expect(cupCount).toBe(1);  // 只有首 patch 的 CUP
  });

  it('column 0 换行到 column 5：用 \\r + cursorDown + cursorForward', () => {
    const { written, charPool, ctx } = createCtxMove();
    const aId = charPool.intern('A');
    const bId = charPool.intern('B');
    // (0,0)='A' → curX=1
    // (0,1)='C' → 换行 dy=1, dx=-1 → \r + cursorDown(1)（cursorForward(0) 不输出）
    //   写完 'C' 后 curX = 0+1 = 1
    // (5,1)='B' → dy=0, dx=5-1=4 → cursorForward(4)
    const patches: Patch[] = [
      { x: 0, y: 0, charId: aId, styleId: 0, isFullWidthContinuation: false },
      { x: 0, y: 1, charId: charPool.intern('C'), styleId: 0, isFullWidthContinuation: false },
      { x: 5, y: 1, charId: bId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // 'B' 必须出现
    expect(output).toContain('B');
    // 写完 'C' 后 curX=1，'B' 在 x=5 → dx=4 → cursorForward(4)
    expect(output).toContain('\x1b[4C');
    // 换行用 \r + cursorDown（不用 cursorBack）
    expect(output).toContain('\r');
    expect(output).toContain('\x1b[1B');
  });
});
