// src/__tests__/agent/clipboard-image.test.ts
// clipboard-image 单元测试:Windows 剪贴板图片读取。
//
// 核心锚点函数 getImageFromClipboard:PowerShell 检测 → 有图存临时文件 → 返回路径。
// 通过依赖注入 mock PowerShell 执行器,不依赖真实 spawn。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  hasClipboardImage,
  getImageFromClipboard,
} from '../../agent/clipboard-image.js';

// 最小 PNG(用于模拟 PowerShell 保存的临时文件)
const MIN_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0x70, 0x7e,
  0xaa, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `micode-clip-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  // mock process.platform 为 win32(测试在任意平台跑)
  vi.stubGlobal('process', { ...process, platform: 'win32' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────── hasClipboardImage ───────────────

describe('hasClipboardImage', () => {
  it('PowerShell 返回 True:剪贴板有图', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'True\r\n', code: 0 });
    const result = await hasClipboardImage(mockExec);
    expect(result).toBe(true);
  });

  it('PowerShell 返回 False:剪贴板无图', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'False\r\n', code: 0 });
    const result = await hasClipboardImage(mockExec);
    expect(result).toBe(false);
  });

  it('PowerShell 退出码非 0:视为无图', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '', code: 1 });
    const result = await hasClipboardImage(mockExec);
    expect(result).toBe(false);
  });

  it('PowerShell spawn 失败(抛异常):视为无图', async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const result = await hasClipboardImage(mockExec);
    expect(result).toBe(false);
  });
});

// ─────────────── getImageFromClipboard ───────────────

describe('getImageFromClipboard', () => {
  it('剪贴板有图:保存临时文件,返回路径,文件存在', async () => {
    const fakeTempPath = join(tmpDir, 'clip-test.png');
    // mock:检测返回 True;保存命令执行后写假 PNG 文件
    const mockExec = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes('-ne $null')) return { stdout: 'True\r\n', code: 0 };
      if (cmd.includes('.Save(')) {
        writeFileSync(fakeTempPath, MIN_PNG);
        return { stdout: '', code: 0 };
      }
      return { stdout: '', code: 0 };
    });

    const result = await getImageFromClipboard(mockExec, () => fakeTempPath);
    expect(result).not.toBeNull();
    expect(result).toBe(fakeTempPath);
    expect(existsSync(fakeTempPath)).toBe(true);
  });

  it('剪贴板无图:返回 null', async () => {
    const mockExec = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes('-ne $null')) return { stdout: 'False\r\n', code: 0 };
      return { stdout: '', code: 0 };
    });

    const result = await getImageFromClipboard(mockExec, () => join(tmpDir, 'x.png'));
    expect(result).toBeNull();
  });

  it('保存失败(退出码非 0):返回 null', async () => {
    const mockExec = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes('-ne $null')) return { stdout: 'True\r\n', code: 0 };
      if (cmd.includes('.Save(')) return { stdout: '', code: 1 }; // 保存失败
      return { stdout: '', code: 0 };
    });

    const result = await getImageFromClipboard(mockExec, () => join(tmpDir, 'x.png'));
    expect(result).toBeNull();
  });
});
