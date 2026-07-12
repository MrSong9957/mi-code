// src/__tests__/tui/bootstrap-decawm-cleanup.test.ts
//
// 验证 bootstrap cleanup → InlineRenderer.destroy → DECAWM 恢复序列。
// 整条 crash 兜底链：cleanup() → inlineRenderer?.destroy() → \x1b[?7h + \x1b[?25h。
//
// 不测 Ink 渲染（太重），只 spy process.stdout.write 检查 cleanup 后的序列。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bootstrap } from '../../tui/bootstrap.js';

describe('bootstrap cleanup 恢复 DECAWM', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;
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

  it('inline 模式 cleanup 写入 DECAWM ON + 光标可见', () => {
    expect.hasAssertions();
    const handle = bootstrap({
      renderMode: 'inline',
      status: { mode: 'build', model: 'test', dir: '/tmp', branch: 'main' },
      logo: { version: '1.0.0', dir: '/tmp' },
      onSubmit: () => {},
      onExit: () => {},
    });

    // cleanup 前：constructor 已写 \x1b[?7l（DECAWM OFF）
    const beforeCleanup = writeSpy.mock.calls.map((c: [string]) => c[0]).join('');
    expect(beforeCleanup).toContain('\x1b[?7l');

    // 清空 spy 记录，只看 cleanup 输出
    writeSpy.mockClear();

    handle.cleanup();

    const afterCleanup = writeSpy.mock.calls.map((c: [string]) => c[0]).join('');
    // cleanup 应写入 DECAWM ON + 光标可见
    expect(afterCleanup).toContain('\x1b[?7h');
    expect(afterCleanup).toContain('\x1b[?25h');
  });

  it('alt-screen 模式 cleanup 写入 exitAltScreen（\x1b[?1049l）', () => {
    expect.hasAssertions();
    const handle = bootstrap({
      renderMode: 'alt-screen',
      status: { mode: 'build', model: 'test', dir: '/tmp', branch: 'main' },
      logo: { version: '1.0.0', dir: '/tmp' },
      onSubmit: () => {},
      onExit: () => {},
    });

    writeSpy.mockClear();
    handle.cleanup();

    const afterCleanup = writeSpy.mock.calls.map((c: [string]) => c[0]).join('');
    // alt-screen 模式应退出备用屏
    expect(afterCleanup).toContain('\x1b[?1049l');
  });

  it('多次调用 cleanup 不崩溃（幂等性）', () => {
    expect.hasAssertions();
    const handle = bootstrap({
      renderMode: 'inline',
      status: { mode: 'build', model: 'test', dir: '/tmp', branch: 'main' },
      logo: { version: '1.0.0', dir: '/tmp' },
      onSubmit: () => {},
      onExit: () => {},
    });

    // 第一次 cleanup
    expect(() => handle.cleanup()).not.toThrow();
    // 第二次 cleanup 不应崩溃（inkInstance 已 null）
    expect(() => handle.cleanup()).not.toThrow();
  });
});
