// src/__tests__/render/emit.test.ts
import { describe, it, expect } from 'vitest';
import { emit, type EmitContext } from '../../render/emit.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { ERASE_CHAR_ID, DEFAULT_STYLE, type Patch } from '../../render/types.js';

function makeCtx(): { ctx: EmitContext; output: string[] } {
  const output: string[] = [];
  const ctx: EmitContext = {
    charPool: new CharPool(),
    stylePool: new StylePool(),
    stdout: { write: (s: string) => { output.push(s); return true; } } as any,
  };
  return { ctx, output };
}

function patch(x: number, y: number, charId: number, styleId: number, fw = false): Patch {
  return { x, y, charId, styleId, isFullWidthContinuation: fw };
}

describe('emit', () => {
  it('空 patches → 仍输出 DEC 2026 包裹 + hideCursor', () => {
    const { ctx, output } = makeCtx();
    emit([], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[?2026h');
    expect(written).toContain('\x1b[?2026l');
    expect(written).toContain('\x1b[?25l');  // hideCursor
  });

  it('单 patch：绝对定位 + 字符 + DEC 2026', () => {
    const { ctx, output } = makeCtx();
    const charId = ctx.charPool.intern('X');
    emit([patch(3, 2, charId, 0)], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[?2026h');
    expect(written).toContain('\x1b[3;4H');  // y+1=3, x+1=4
    expect(written).toContain('X');
    expect(written).toContain('\x1b[?2026l');
  });

  it('相邻 patch（x+1）→ 不重发 cursorTo', () => {
    const { ctx, output } = makeCtx();
    const a = ctx.charPool.intern('a');
    const b = ctx.charPool.intern('b');
    emit([patch(0, 0, a, 0), patch(1, 0, b, 0)], ctx);
    const written = output.join('');
    // 第一个 patch 发 cursorTo(0,0) → \x1b[1;1H
    expect(written).toContain('\x1b[1;1H');
    // 第二个 patch 邻接，不应再发 cursorTo
    // 检查只有一个 cursorTo（粗略：count \x1b[;H 模式）
    const cursorMatches = written.match(/\x1b\[\d+;\d+H/g) ?? [];
    expect(cursorMatches.length).toBe(1);
  });

  it('非邻接 patch → 各发 cursorTo', () => {
    const { ctx, output } = makeCtx();
    const a = ctx.charPool.intern('a');
    const c = ctx.charPool.intern('c');
    emit([patch(0, 0, a, 0), patch(5, 0, c, 0)], ctx);
    const written = output.join('');
    const cursorMatches = written.match(/\x1b\[\d+;\d+H/g) ?? [];
    expect(cursorMatches.length).toBe(2);
  });

  it('style 变化：发 SGR transition', () => {
    const { ctx, output } = makeCtx();
    const a = ctx.charPool.intern('a');
    const boldId = ctx.stylePool.intern({ ...DEFAULT_STYLE, bold: true });
    emit([patch(0, 0, a, boldId)], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[1m');  // bold
  });

  it('ERASE_CHAR_ID patch → 发 eraseEndLine', () => {
    const { ctx, output } = makeCtx();
    emit([patch(0, 0, ERASE_CHAR_ID, 0)], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[K');  // eraseEndLine
  });

  it('全角续位 patch → 跳过字符输出（不写字符）', () => {
    const { ctx, output } = makeCtx();
    const you = ctx.charPool.intern('你');
    // 仅传续位 patch（异常情况，但 emit 应容错）
    emit([patch(0, 0, you, 0, true)], ctx);
    const written = output.join('');
    expect(written).not.toContain('你');  // 不输出字符
  });

  it('cursor 提供 → 末尾绝对定位 + showCursor', () => {
    const { ctx, output } = makeCtx();
    ctx.cursor = { x: 5, y: 3 };
    emit([], ctx);
    const written = output.join('');
    expect(written).toContain('\x1b[4;6H');  // y+1=4, x+1=6
    expect(written).toContain('\x1b[?25h');  // showCursor
  });

  it('每帧开头 reset 样式（\\x1b[0m）', () => {
    const { ctx, output } = makeCtx();
    emit([], ctx);
    expect(output.join('')).toContain('\x1b[0m');
  });
});
