// src/__tests__/tui/clipboard.test.ts
// clipboard 三级回退：OS命令 → tmux → OSC52

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('clipboard 三级回退', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let writeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    writeMock = vi.fn();
    // 清模块缓存：每个测试内 vi.doMock + 动态 import 都拿到重新求值的 clipboard.ts，
    // 使其顶层 `import { spawn }` 绑定到本测试自己的 spawnMock（否则首个 import 的绑定被缓存）。
    vi.resetModules();
    vi.spyOn(process.stdout, 'write').mockImplementation(writeMock);
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // Note: child_process.spawn is mocked at top-level via vi.mock below.
  // The mock factory exposes spawnMock so tests can configure return values.
  let spawnMock: ReturnType<typeof vi.fn>;

  function makeChild(ok: boolean): unknown {
    return {
      on: vi.fn((event: string, cb: (code?: number) => void) => {
        if (event === 'close') setTimeout(() => cb(ok ? 0 : 1), 0);
      }),
      stdin: {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      },
    };
  }

  it('本地（非 SSH）+ OS 命令成功：调 spawn', async () => {
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
    delete process.env.TMUX;
    spawnMock = vi.fn().mockReturnValue(makeChild(true));
    vi.doMock('child_process', () => ({ spawn: spawnMock }));
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('hello');
    expect(spawnMock).toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled(); // 没走 OSC52
  });

  it('SSH 环境 + 非 tmux：跳过 OS 命令，直接 OSC52', async () => {
    process.env.SSH_CONNECTION = '1.2.3.4';
    delete process.env.TMUX;
    spawnMock = vi.fn();
    vi.doMock('child_process', () => ({ spawn: spawnMock }));
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('hello');
    expect(spawnMock).not.toHaveBeenCalled();
    // OSC52 序列：\x1b]52;c;<base64>\x07
    const expected = `\x1b]52;c;${Buffer.from('hello', 'utf8').toString('base64')}\x07`;
    expect(writeMock).toHaveBeenCalledWith(expected);
  });

  it('tmux 环境：调 tmux load-buffer', async () => {
    delete process.env.SSH_CONNECTION;
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
    spawnMock = vi.fn().mockReturnValue(makeChild(true));
    vi.doMock('child_process', () => ({ spawn: spawnMock }));
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('hello');
    // 第一参 spawn 调用的 cmd 应是 'tmux'
    expect(spawnMock).toHaveBeenCalledWith(
      'tmux', expect.arrayContaining(['load-buffer']), expect.anything(),
    );
  });

  it('OSC52 中文 base64 编码正确', async () => {
    process.env.SSH_CONNECTION = '1.2.3.4';
    delete process.env.TMUX;
    spawnMock = vi.fn();
    vi.doMock('child_process', () => ({ spawn: spawnMock }));
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('你好');
    const expected = `\x1b]52;c;${Buffer.from('你好', 'utf8').toString('base64')}\x07`;
    expect(writeMock).toHaveBeenCalledWith(expected);
  });

  it('OSC52 emoji 正确编码', async () => {
    process.env.SSH_CONNECTION = '1.2.3.4';
    delete process.env.TMUX;
    spawnMock = vi.fn();
    vi.doMock('child_process', () => ({ spawn: spawnMock }));
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('👋🌍');
    const expected = `\x1b]52;c;${Buffer.from('👋🌍', 'utf8').toString('base64')}\x07`;
    expect(writeMock).toHaveBeenCalledWith(expected);
  });
});
