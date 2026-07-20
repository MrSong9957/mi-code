// src/__tests__/agent/image-utils.test.ts
// image-utils 单元测试:魔数检测 / 大小校验 / base64 编码 / 磁盘缓存 / 持久化 strip
//
// TDD:先写失败测试,再实现 image-utils.ts。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectImageFormat,
  validateImageSize,
  encodeImageBlock,
  saveImageCache,
  stripImagesForPersistence,
  ensureImageData,
  buildOpenAIImagePart,
  buildGeminiInlineData,
  MAX_IMAGE_BYTES,
} from '../../agent/image-utils.js';
import type { ImageBlock, Message } from '../../agent/types.js';

// ── 测试用真实图片二进制(最小合法各格式) ──

/** 最小 PNG:1x1 红点(67 字节,魔数 89 50 4E 47) */
const MIN_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0x70, 0x7e,
  0xaa, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

/** 最小 JPEG:SOI + 少量数据(魔数 FF D8 FF) */
const MIN_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/** 最小 GIF:GIF89a header(魔数 47 49 46) */
const MIN_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x3b,
]);

/** 非图片数据:纯文本 */
const NOT_IMAGE = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `micode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────── detectImageFormat(魔数检测) ───────────────

describe('detectImageFormat', () => {
  it('PNG: 识别 89 50 4E 47 魔数', () => {
    expect(detectImageFormat(MIN_PNG)).toBe('image/png');
  });

  it('JPEG: 识别 FF D8 FF 魔数', () => {
    expect(detectImageFormat(MIN_JPEG)).toBe('image/jpeg');
  });

  it('GIF: 识别 47 49 46 魔数', () => {
    expect(detectImageFormat(MIN_GIF)).toBe('image/gif');
  });

  it('非图片返回 null', () => {
    expect(detectImageFormat(NOT_IMAGE)).toBeNull();
  });

  it('空 Buffer 返回 null', () => {
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
  });

  it('WebP: 识别 RIFF....WEBP 魔数', () => {
    const webp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, // RIFF
      0x57, 0x45, 0x42, 0x50,                           // WEBP
    ]);
    expect(detectImageFormat(webp)).toBe('image/webp');
  });
});

// ─────────────── validateImageSize ───────────────

describe('validateImageSize', () => {
  it('小于上限:不抛异常', () => {
    expect(() => validateImageSize(MIN_PNG)).not.toThrow();
  });

  it('超过上限(3.75MB):抛异常并提示大小', () => {
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x89);
    // 补上 PNG 魔数让 detectImageFormat 不干扰(虽然 validateImageSize 只看大小)
    oversized[0] = 0x89; oversized[1] = 0x50; oversized[2] = 0x4e; oversized[3] = 0x47;
    expect(() => validateImageSize(oversized)).toThrow(/超过.*限制/);
  });
});

// ─────────────── encodeImageBlock(端到端编码) ───────────────

describe('encodeImageBlock', () => {
  it('正常 PNG:返回正确的 ImageBlock', async () => {
    const filePath = join(tmpDir, 'test.png');
    writeFileSync(filePath, MIN_PNG);

    const block = await encodeImageBlock(filePath);
    expect(block.type).toBe('image');
    expect(block.mediaType).toBe('image/png');
    expect(block.data).toBe(MIN_PNG.toString('base64'));
  });

  it('正常 JPEG:返回正确的 mediaType', async () => {
    const filePath = join(tmpDir, 'test.jpg');
    writeFileSync(filePath, MIN_JPEG);

    const block = await encodeImageBlock(filePath);
    expect(block.mediaType).toBe('image/jpeg');
  });

  it('文件不存在:抛异常', async () => {
    await expect(encodeImageBlock(join(tmpDir, 'nope.png'))).rejects.toThrow();
  });

  it('非图片文件(魔数不匹配):抛异常', async () => {
    const filePath = join(tmpDir, 'fake.png');
    writeFileSync(filePath, NOT_IMAGE);

    await expect(encodeImageBlock(filePath)).rejects.toThrow(/格式/);
  });

  it('扩展名伪装(.png 实际是 JPEG):按魔数判定为 jpeg', async () => {
    const filePath = join(tmpDir, 'disguised.png');
    writeFileSync(filePath, MIN_JPEG);

    const block = await encodeImageBlock(filePath);
    // 魔数优先,不信任扩展名
    expect(block.mediaType).toBe('image/jpeg');
  });

  it('超大文件:抛异常', async () => {
    const filePath = join(tmpDir, 'big.png');
    const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x00);
    // PNG 魔数
    MIN_PNG.copy(oversized);
    writeFileSync(filePath, oversized);

    await expect(encodeImageBlock(filePath)).rejects.toThrow(/超过.*限制/);
  });
});

// ─────────────── saveImageCache(磁盘缓存) ───────────────

describe('saveImageCache', () => {
  it('保存图片到缓存目录,返回路径,文件存在', () => {
    const block: ImageBlock = {
      type: 'image',
      mediaType: 'image/png',
      data: MIN_PNG.toString('base64'),
    };
    const cachePath = saveImageCache('test-session', 1, block);
    expect(existsSync(cachePath)).toBe(true);
    expect(cachePath).toContain('test-session');
    // 读回验证内容一致
    const readBack = Buffer.from(
      // saveImageCache 把 base64 解码回二进制存盘
      // 这里验证文件存在即可,具体读法在实现里定
      '', 'base64',
    );
    // 文件非空
    const { statSync } = require('fs');
    expect(statSync(cachePath).size).toBeGreaterThan(0);
  });
});

// ─────────────── stripImagesForPersistence(持久化 strip) ───────────────

describe('stripImagesForPersistence', () => {
  it('清空 image block 的 data,保留 cachePath 和 mediaType', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', cachePath: '/cache/1.png' },
        { type: 'text', text: '这是什么' },
      ],
    };
    const stripped = stripImagesForPersistence(msg);
    const blocks = stripped.content as Extract<Message['content'], Array<unknown>>;
    const imgBlock = blocks[0] as ImageBlock;
    expect(imgBlock.data).toBe('');
    expect(imgBlock.cachePath).toBe('/cache/1.png');
    expect(imgBlock.mediaType).toBe('image/png');
    // text block 不受影响
    const textBlock = blocks[1] as { type: string; text: string };
    expect(textBlock.text).toBe('这是什么');
  });

  it('纯文本消息:不受影响', () => {
    const msg: Message = { role: 'user', content: 'hello' };
    const stripped = stripImagesForPersistence(msg);
    expect(stripped).toEqual(msg);
  });

  it('无 image block 的数组 content:不受影响', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: '回复' }],
    };
    const stripped = stripImagesForPersistence(msg);
    expect(stripped).toEqual(msg);
  });
});

// ─────────────── 图片转换 helper ───────────────

function makeImageBlock(overrides: Partial<ImageBlock> = {}): ImageBlock {
  return {
    type: 'image',
    mediaType: 'image/png',
    data: 'AAA',
    ...overrides,
  };
}

describe('图片转换 helper — ensureImageData', () => {
  it('正常 data 返回原值', () => {
    const block = makeImageBlock({ data: 'AAA' });
    expect(ensureImageData(block)).toBe('AAA');
  });

  it('非法 mediaType 抛中文错误', () => {
    const block = makeImageBlock({ mediaType: 'image/svg+xml' as any });
    expect(() => ensureImageData(block)).toThrowError(/不支持的图片类型/);
    expect(() => ensureImageData(block)).toThrowError(/image\/svg\+xml/);
    expect(() => ensureImageData(block)).toThrowError(/image\/png/);
  });

  it('空 data 有 cachePath 抛中文错误(含 cachePath 与 AUTO-0028)', () => {
    const block = makeImageBlock({ data: '', cachePath: '/tmp/x.png' });
    expect(() => ensureImageData(block)).toThrowError(/图片数据缺失/);
    expect(() => ensureImageData(block)).toThrowError(/AUTO-0028/);
    expect(() => ensureImageData(block)).toThrowError(/\/tmp\/x\.png/);
  });

  it('空 data 无 cachePath 抛中文错误(含「未记录」)', () => {
    const block = makeImageBlock({ data: '' });
    expect(() => ensureImageData(block)).toThrowError(/未记录/);
  });

  it('先校验 mediaType 再校验 data(非法 mediaType 即使 data 空也优先报 mediaType 错误)', () => {
    const block = makeImageBlock({ mediaType: 'image/tiff' as any, data: '' });
    expect(() => ensureImageData(block)).toThrowError(/不支持的图片类型/);
    expect(() => ensureImageData(block)).not.toThrowError(/图片数据缺失/);
  });
});

describe('图片转换 helper — buildOpenAIImagePart', () => {
  it('PNG block → image_url data URL', () => {
    const part = buildOpenAIImagePart(makeImageBlock({ mediaType: 'image/png', data: 'AAA' }));
    expect(part.type).toBe('image_url');
    expect(part.image_url.url).toBe('data:image/png;base64,AAA');
  });

  it('JPEG/GIF/WebP 各自的 mediaType 前缀正确', () => {
    for (const mediaType of ['image/jpeg', 'image/gif', 'image/webp'] as const) {
      const part = buildOpenAIImagePart(makeImageBlock({ mediaType, data: 'AAA' }));
      expect(part.image_url.url).toBe(`data:${mediaType};base64,AAA`);
    }
  });

  it('空 data 透传 ensureImageData 错误', () => {
    expect(() => buildOpenAIImagePart(makeImageBlock({ data: '' }))).toThrowError(/图片数据缺失/);
  });

  it('非法 mediaType 透传 ensureImageData 错误', () => {
    expect(() => buildOpenAIImagePart(makeImageBlock({ mediaType: 'image/svg+xml' as any }))).toThrowError(
      /不支持的图片类型/,
    );
  });
});

describe('图片转换 helper — buildGeminiInlineData', () => {
  it('PNG block → inlineData 纯 base64(无前缀)', () => {
    const part = buildGeminiInlineData(makeImageBlock({ mediaType: 'image/png', data: 'AAA' }));
    expect(part.inlineData.mimeType).toBe('image/png');
    expect(part.inlineData.data).toBe('AAA'); // 不含 data: 前缀
  });

  it('JPEG/GIF/WebP 各自的 mimeType 正确', () => {
    for (const mediaType of ['image/jpeg', 'image/gif', 'image/webp'] as const) {
      const part = buildGeminiInlineData(makeImageBlock({ mediaType, data: 'AAA' }));
      expect(part.inlineData.mimeType).toBe(mediaType);
      expect(part.inlineData.data).toBe('AAA');
    }
  });

  it('空 data 透传 ensureImageData 错误', () => {
    expect(() => buildGeminiInlineData(makeImageBlock({ data: '' }))).toThrowError(/图片数据缺失/);
  });
});
