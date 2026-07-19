// src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
//
// 验证 MICODE_INLINE_V2 flag 切换 bootstrap 的 inline 路径:
//   - MICODE_INLINE_V2=0 (默认):inlineV2=false,走 V0 (InlineRenderer)
//   - MICODE_INLINE_V2=1        :inlineV2=true, 走 V2 (Ink reconciler)
//   - alt-screen 模式           :inlineV2=false(不受 flag 影响)
//
// 注意:bootstrap 真实 render Ink 到 process.stdout,每个测试用完必须 cleanup。
// env 在 bootstrap() 函数体内读(非模块顶层),静态 import 也能跑;动态 import 仅为对称/习惯。

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

describe('bootstrap MICODE_INLINE_V2 flag', () => {
  let origEnv: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;
  let originalColumns: number;

  beforeEach(() => {
    origEnv = process.env.MICODE_INLINE_V2;
    // Stub stdout 避免污染真实终端(Ink 渲染写入大量字节)
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MICODE_INLINE_V2;
    else process.env.MICODE_INLINE_V2 = origEnv;
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
  });

  it('MICODE_INLINE_V2=0 时 inlineV2=false(走 V0)', async () => {
    process.env.MICODE_INLINE_V2 = '0';
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'inline',
    });
    expect(handle.inlineV2).toBe(false);
    handle.cleanup();
  });

  it('MICODE_INLINE_V2=1 时 inlineV2=true(走 V2)', async () => {
    process.env.MICODE_INLINE_V2 = '1';
    // 动态 import 让 env 变化生效
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'inline',
    });
    expect(handle.inlineV2).toBe(true);
    handle.cleanup();
  });

  it('alt-screen 模式 inlineV2=false(不受 flag 影响)', async () => {
    process.env.MICODE_INLINE_V2 = '1';
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'alt-screen',
    });
    expect(handle.inlineV2).toBe(false);
    handle.cleanup();
  });

  it('未设 MICODE_INLINE_V2 时 inlineV2=false(默认 V0)', async () => {
    delete process.env.MICODE_INLINE_V2;
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'inline',
    });
    expect(handle.inlineV2).toBe(false);
    handle.cleanup();
  });
});
