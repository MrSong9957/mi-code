// src/__tests__/render/renderer.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createCustomRenderer } from '../../render/renderer.js';

describe('createCustomRenderer', () => {
  it('返回函数：接收 rootNode + options，返回 {output, outputHeight, staticOutput}', () => {
    const stdout = { write: vi.fn(), columns: 80, rows: 24, isTTY: true };
    const renderer = createCustomRenderer({ stdout });
    expect(typeof renderer).toBe('function');
  });

  it('空树 → output 为空串，outputHeight=0，不抛错', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const renderer = createCustomRenderer({ stdout });
    const result = renderer(null, { width: 80, height: 24 });
    expect(result.output).toBe('');
    expect(result.outputHeight).toBe(0);
  });

  it('feature flag off（useDoubleBuffer=false）→ 走 fallback', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const fallback = vi.fn(() => ({ output: 'fallback', outputHeight: 1, staticOutput: '' }));
    const renderer = createCustomRenderer({ stdout, useDoubleBuffer: false, fallback });
    renderer(null, { width: 80, height: 24 });
    expect(fallback).toHaveBeenCalled();
  });

  it('自研 renderer 抛错 → 自动 fallback', () => {
    const writes: string[] = [];
    const stdout = { write: (s: string) => { writes.push(s); return true; }, columns: 80, rows: 24, isTTY: true };
    const fallback = vi.fn(() => ({ output: 'fallback', outputHeight: 1, staticOutput: '' }));
    // 传一个会抛错的 rootNode（yogaNode.getComputedWidth 抛错）
    const badRoot = { nodeName: 'ink-root', yogaNode: { getComputedWidth: () => { throw new Error('boom'); }, getComputedLeft: () => 0, getComputedTop: () => 0, getComputedHeight: () => 0, getDisplay: () => 0 }, childNodes: [] };
    const renderer = createCustomRenderer({ stdout, fallback });
    const result = renderer(badRoot as any, { width: 80, height: 24 });
    expect(fallback).toHaveBeenCalled();
    expect(result.output).toBe('fallback');
  });
});
