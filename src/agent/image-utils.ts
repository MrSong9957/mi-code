// src/agent/image-utils.ts
// 图片处理工具:魔数检测 / 大小校验 / base64 编码 / 磁盘缓存 / 持久化 strip。
//
// 设计原则:零依赖(纯 Node fs + Buffer),MVP 只校验不 resize。
// 魔数检测优先于扩展名,防伪装文件。

import { readFile, mkdir, writeFile } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ImageBlock, ImageMediaType, Message, ContentBlock } from './types.js';

/** 原始字节上限(3.75MB,对应 base64 5MB API 限制:3.75M × 4/3 ≈ 5MB) */
export const MAX_IMAGE_BYTES = 3_750_000;

/** 扩展名 → mediaType(用于 cachePath 文件后缀,不用于格式判定) */
const EXT_MAP: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** mediaType → 文件后缀(磁盘缓存命名) */
const MEDIA_EXT: Record<ImageMediaType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * 魔数检测图片格式。只认前几个字节,不信任扩展名。
 * 返回 null 表示不是支持的图片格式。
 */
export function detectImageFormat(buf: Buffer): ImageMediaType | null {
  if (buf.length < 4) return null;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 ("GIF")
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP(需 12 字节)
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * 校验图片大小。超过 MAX_IMAGE_BYTES 抛错。
 */
export function validateImageSize(buf: Buffer): void {
  if (buf.length > MAX_IMAGE_BYTES) {
    const mb = (buf.length / 1024 / 1024).toFixed(2);
    const limitMb = (MAX_IMAGE_BYTES / 1024 / 1024).toFixed(2);
    throw new Error(
      `图片 ${mb}MB 超过限制 ${limitMb}MB(API base64 上限 5MB)。请先压缩后再发送。`,
    );
  }
}

/**
 * 端到端编码:读文件 → 魔数检测格式 → 校验大小 → base64 编码 → 返回 ImageBlock。
 *
 * 魔数优先:即使扩展名是 .png 但实际是 JPEG,按真实格式判定。
 */
export async function encodeImageBlock(filePath: string): Promise<ImageBlock> {
  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`无法读取图片文件: ${msg}`);
  }

  const mediaType = detectImageFormat(buf);
  if (!mediaType) {
    throw new Error(
      `不支持的图片格式(魔数未匹配 PNG/JPEG/GIF/WebP)。文件可能不是图片或已损坏。`,
    );
  }

  validateImageSize(buf);

  return {
    type: 'image',
    mediaType,
    data: buf.toString('base64'),
  };
}

/** 磁盘缓存根目录:~/.micode/image-cache/ */
function cacheRoot(): string {
  return join(homedir(), '.micode', 'image-cache');
}

/**
 * 把 ImageBlock 的 base64 解码后存到磁盘缓存目录。
 * 路径格式:~/.micode/image-cache/<sessionId>/<id>.<ext>
 * 返回绝对路径,写入 ImageBlock.cachePath 供持久化引用。
 */
export function saveImageCache(sessionId: string, id: number, block: ImageBlock): string {
  const dir = join(cacheRoot(), sessionId);
  mkdirSync(dir, { recursive: true });
  const ext = MEDIA_EXT[block.mediaType];
  const cachePath = join(dir, `${id}${ext}`);
  writeFileSync(cachePath, Buffer.from(block.data, 'base64'));
  return cachePath;
}

/**
 * 持久化前 strip:清空 image block 的 base64 data,只保留 cachePath + mediaType。
 *
 * 避免 base64 膨胀 JSONL 日志(一张图可能几 MB)。
 * resume 时通过 cachePath 从磁盘重新读取 base64。
 *
 * 纯文本消息和不含 image 的数组内容原样返回。
 */
export function stripImagesForPersistence(msg: Message): Message {
  if (typeof msg.content === 'string') return msg;
  const stripped: ContentBlock[] = msg.content.map(block => {
    if (block.type === 'image') {
      return { ...block, data: '' };
    }
    return block;
  });
  return { ...msg, content: stripped };
}
