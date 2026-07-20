// src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
//
// bootstrap inline 模式验证。
//
// Stage 5b 后:V0(InlineRenderer)已删除,inline 模式恒走 V2(Ink reconciler)。
// MICODE_INLINE_V2 flag 不再生效(保留为 no-op,向后兼容)。
// alt-screen 模式不受影响。
//
// 注意:bootstrap 真实 render Ink 到 process.stdout,每个测试用完必须 cleanup。

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

describe('bootstrap inline/alt-screen 模式', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let originalColumns: number;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
  });

  it('inline 模式启动不崩(Ink reconciler + <Static>)', async () => {
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'inline',
    });
    // 不崩 + cleanup 不崩 = pass
    expect(() => handle.cleanup()).not.toThrow();
  });

  it('alt-screen 模式启动不崩', async () => {
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'alt-screen',
    });
    expect(() => handle.cleanup()).not.toThrow();
  });

  it('MICODE_INLINE_V2 env 不再生效(V0 已删,inline 恒走 V2)', async () => {
    // 设成任何值都不应该影响行为(向后兼容 no-op)
    process.env.MICODE_INLINE_V2 = '0';
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'inline',
    });
    // 不崩即可(V2 路径,忽略 env)
    expect(() => handle.cleanup()).not.toThrow();
    delete process.env.MICODE_INLINE_V2;
  });
});
