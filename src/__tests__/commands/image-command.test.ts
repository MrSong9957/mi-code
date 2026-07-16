// src/__tests__/commands/image-command.test.ts
// processImageCommand 单元测试:核心锚点函数。
//
// 场景 A: /image <path> <指令> → 从文件读 → ContentBlock[]
// 场景 B: /image <指令>        → 从剪贴板读(第一个 arg 不是文件路径)
// 场景 C: /image               → 从剪贴板读(纯图片无文字)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// mock clipboard-image 模块(避免真实 spawn PowerShell)
const mockGetImageFromClipboard = vi.fn();
vi.mock('../../agent/clipboard-image.js', () => ({
  getImageFromClipboard: (...args: unknown[]) => mockGetImageFromClipboard(...args),
}));

// import 必须在 vi.mock 之后(hoist)
import { processImageCommand } from '../../commands/image-command.js';

// 最小 PNG(1x1)
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
let pngPath: string;
let clipboardTempPath: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `micode-imgcmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  pngPath = join(tmpDir, 'test.png');
  writeFileSync(pngPath, MIN_PNG);
  clipboardTempPath = join(tmpDir, 'clipboard-shot.png');
  mockGetImageFromClipboard.mockReset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────── 场景 A:从文件读(现有逻辑) ───────────────

describe('processImageCommand — 从文件读', () => {
  it('图片 + 文本指令:返回 [ImageBlock, TextBlock]', async () => {
    const result = await processImageCommand([pngPath, '这是什么'], 'test-session');
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.type).toBe('image');
    expect(result.content[1]!.type).toBe('text');
    expect((result.content[1] as { text: string }).text).toBe('这是什么');
    expect(result.displayText).toContain('[Image #');
    expect(result.displayText).toContain('这是什么');
  });

  it('仅图片无文本:返回 [ImageBlock]', async () => {
    const result = await processImageCommand([pngPath], 'test-session');
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('image');
    expect(result.displayText).toMatch(/^\[Image #\d+\]$/);
  });

  it('文件不存在 + 剪贴板无图:返回 error', async () => {
    mockGetImageFromClipboard.mockResolvedValue(null);
    const result = await processImageCommand([join(tmpDir, 'nope.png')], 'test-session');
    expect('error' in result).toBe(true);
  });

  it('image block 有 cachePath', async () => {
    const result = await processImageCommand([pngPath], 'test-session');
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    const imgBlock = result.content[0] as { type: string; cachePath?: string };
    expect(imgBlock.cachePath).toBeTruthy();
  });
});

// ─────────────── 场景 B/C:从剪贴板读(新增) ───────────────

describe('processImageCommand — 从剪贴板读', () => {
  it('无参数(args 为空):从剪贴板读图,返回 [ImageBlock]', async () => {
    // mock:剪贴板有图,返回临时文件路径(预先写入假 PNG)
    writeFileSync(clipboardTempPath, MIN_PNG);
    mockGetImageFromClipboard.mockResolvedValue(clipboardTempPath);

    const result = await processImageCommand([], 'test-session');
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('image');
    expect(result.displayText).toMatch(/^\[Image #\d+\]$/);
    // 剪贴板临时文件应被清理
    expect(existsSync(clipboardTempPath)).toBe(false);
  });

  it('文字指令(非文件路径) + 剪贴板有图:返回 [ImageBlock, TextBlock]', async () => {
    writeFileSync(clipboardTempPath, MIN_PNG);
    mockGetImageFromClipboard.mockResolvedValue(clipboardTempPath);

    const result = await processImageCommand(['这是什么错误'], 'test-session');
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.type).toBe('image');
    expect(result.content[1]!.type).toBe('text');
    expect((result.content[1] as { text: string }).text).toBe('这是什么错误');
    expect(result.displayText).toContain('这是什么错误');
    // 临时文件已清理
    expect(existsSync(clipboardTempPath)).toBe(false);
  });

  it('剪贴板无图:返回 error', async () => {
    mockGetImageFromClipboard.mockResolvedValue(null);

    const result = await processImageCommand([], 'test-session');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('剪贴板');
  });
});
