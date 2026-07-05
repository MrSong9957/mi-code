// src/__tests__/tui/clipboard.test.ts
// 跨平台剪贴板写入（OS 命令，charter §核心模块 2 步骤 3）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeClipboard } from '../../tui/input/clipboard.js';

// mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));
import { spawn } from 'child_process';

/** 造一个最小 mock child（实现 writeClipboard 用到的 on/close/error 接口） */
function makeMockChild(opts: { exitCode?: number; spawnError?: Error } = {}) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const stdinHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const child = {
    stdin: {
      write: vi.fn(() => true),
      end: vi.fn(),
      on: (event: string, cb: (...args: unknown[]) => void) => {
        (stdinHandlers[event] ??= []).push(cb);
      },
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(cb);
      // spawn error 立即触发
      if (event === 'error' && opts.spawnError) {
        setTimeout(() => cb(opts.spawnError!), 0);
      }
      // close 事件模拟成功退出（除非要测错误码）
      if (event === 'close' && opts.spawnError === undefined) {
        setTimeout(() => cb(opts.exitCode ?? 0), 0);
      }
    },
  };
  return child;
}

describe('writeClipboard（跨平台 OS 命令）', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(makeMockChild());
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('win32: 调用 clip，文本写入 stdin', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await writeClipboard('hello world');
    expect(spawn).toHaveBeenCalledWith('clip', [], expect.any(Object));
  });

  it('darwin: 调用 pbcopy', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    await writeClipboard('mac text');
    expect(spawn).toHaveBeenCalledWith('pbcopy', [], expect.any(Object));
  });

  it('linux: 调用 xclip -selection clipboard', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    await writeClipboard('linux text');
    expect(spawn).toHaveBeenCalledWith('xclip', ['-selection', 'clipboard'], expect.any(Object));
  });

  it('spawn error 事件 → reject（不吞错）', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(makeMockChild({ spawnError: new Error('spawn fail') }));
    await expect(writeClipboard('x')).rejects.toThrow('spawn fail');
  });

  it('非零退出码 → reject', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(makeMockChild({ exitCode: 1 }));
    await expect(writeClipboard('x')).rejects.toThrow('exited with code 1');
  });
});
