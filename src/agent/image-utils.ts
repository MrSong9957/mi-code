// src/agent/image-utils.ts
// 图片处理工具:魔数检测 / 大小校验 / base64 编码 / 磁盘缓存 / 持久化 strip。
//
// 设计原则:零依赖(纯 Node fs + Buffer),MVP 只校验不 resize。
// 魔数检测优先于扩展名,防伪装文件。

import { readFile, mkdir, writeFile } from 'fs/promises';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
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

// ─────────────── 图片转换 helper（三家 client 共用） ───────────────

/** OpenAI vision API 的 image_url part 结构。*/
export interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string }; // data URL (data:<media>;base64,<data>)
  // 可选字段 detail?: 'low' | 'high' | 'auto' 控制解析精度与 token 消耗，
  // 默认 'auto'。当前不设置，保留扩展空间。
}

/** Google Gemini API 的 inlineData part 结构。*/
export type GeminiInlineData = {
  inlineData: { mimeType: ImageMediaType; data: string };
};

/** 合法的 mediaType 集合（与 types.ts ImageMediaType 一致）。*/
const SUPPORTED_MEDIA_TYPES: ReadonlySet<ImageMediaType> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * 返回可用的 base64 data。
 *
 * 路径优先级：
 *   1. mediaType 白名单校验（不变，防御 cast 绕过类型）
 *   2. 热路径：data 非空直接返回（首次发送）
 *   3. 冷路径：委托 rehydrateFromCache 从 cachePath 回填（resume 后）
 *
 * 三家 provider client 都经此 helper，一处修改三家受益。
 */
export function ensureImageData(block: ImageBlock): string {
  if (!SUPPORTED_MEDIA_TYPES.has(block.mediaType)) {
    throw new Error(
      `不支持的图片类型：${block.mediaType}\n` +
        `支持的类型：image/png、image/jpeg、image/gif、image/webp`,
    );
  }
  if (block.data) return block.data;
  return rehydrateFromCache(block);
}

/**
 * 从 cachePath 读回 base64 data（resume 场景）。
 *
 * 当前方案：每次 convertMessages 都读磁盘，不缓存。多轮对话中同一图片会重复读,
 * 但单图磁盘成本（µs-ms 级）远低于 API 往返（数百 ms 到数秒）。
 *
 * 注意：不回写 block.data，保持 ensureImageData 无副作用。
 * 如未来成为瓶颈，可在本函数内部加 Map<cachePath, string> 缓存，对外接口不变。
 *
 * 失败路径：
 *   - cachePath 缺失：状态损坏（理论上不可能，stripImagesForPersistence 总保留 cachePath）
 *   - 文件不存在：用户清缓存 / 跨设备迁移，建议重新 /image
 *   - 0 字节文件：剪贴板保存失败残留，silent corruption，必须 throw
 *   - EACCES/EIO 等系统错误：不包装，自然冒泡（与 encodeImageBlock 一致）
 */
function rehydrateFromCache(block: ImageBlock): string {
  if (!block.cachePath) {
    throw new Error(
      `图片数据缺失，且未记录缓存路径，无法发送。\n` +
        `mediaType：${block.mediaType}\n` +
        `这通常是会话状态损坏，请到 GitHub Issues 反馈。`,
    );
  }
  if (!existsSync(block.cachePath)) {
    throw new Error(
      `图片缓存文件丢失，无法发送历史图片。\n` +
        `缓存路径：${block.cachePath}\n` +
        `mediaType：${block.mediaType}\n` +
        `建议：重新使用 /image 命令附加该图片。`,
    );
  }
  const buf = readFileSync(block.cachePath);
  if (buf.length === 0) {
    throw new Error(
      `图片缓存文件为空：${block.cachePath}\n` +
        `建议：重新使用 /image 命令附加该图片。`,
    );
  }
  return buf.toString('base64');
}

/** 构造 OpenAI vision image_url part（含 data URL 前缀）。*/
export function buildOpenAIImagePart(block: ImageBlock): OpenAIImagePart {
  const data = ensureImageData(block);
  return {
    type: 'image_url',
    image_url: { url: `data:${block.mediaType};base64,${data}` },
  };
}

/** 构造 Gemini inlineData part（纯 base64，无前缀）。*/
export function buildGeminiInlineData(block: ImageBlock): GeminiInlineData {
  const data = ensureImageData(block);
  return {
    inlineData: { mimeType: block.mediaType, data },
  };
}
