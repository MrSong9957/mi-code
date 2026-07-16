// src/commands/image-command.ts
// /image 斜杠命令核心:解析路径 + 文本 → 读图片 → 构造 ContentBlock[]
//
// 核心锚点函数:processImageCommand
// 输入明确:args 数组(第一个是路径,其余是文本指令)
// 输出明确:ContentBlock[](给 API)+ displayText(给 TUI 回显)
//
// /image <path> <指令>  → [ImageBlock, TextBlock]
// /image <path>         → [ImageBlock]

import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { encodeImageBlock, saveImageCache } from '../agent/image-utils.js';
import { getImageFromClipboard } from '../agent/clipboard-image.js';
import type { ContentBlock } from '../agent/types.js';

export interface ImageCommandResult {
  /** 给 API 的内容块:[ImageBlock, TextBlock?] */
  content: ContentBlock[];
  /** 给 TUI 回显的文本(含 [Image #N] 占位符) */
  displayText: string;
}

export interface ImageCommandError {
  error: string;
}

/** 全局递增的图片 ID(单进程内,对标 paste-handler 的 nextPasteId) */
let nextImageId = 1;

/** 重置图片 ID 计数器(测试用) */
export function resetImageIdCounter(): void {
  nextImageId = 1;
}

/**
 * 解析 /image 命令:读图片 → 校验 → 编码 → 构造 ContentBlock[]。
 *
 * 解析规则:
 *   args[0]             = 图片文件路径
 *   args.slice(1).join  = 文本指令(可选)
 *
 * 每张图分配递增 ID,存磁盘缓存(~/.micode/image-cache/<session>/<id>.<ext>)。
 * displayText 含 [Image #N] 占位符,供 TUI 回显。
 */
export async function processImageCommand(
  args: string[],
  sessionId: string,
): Promise<ImageCommandResult | ImageCommandError> {
  // 判断图片来源:args[0] 是已存在的文件路径 → 从文件读;否则从剪贴板读。
  const filePath = args[0];
  const fromFile = filePath && existsSync(filePath);

  let actualFilePath: string;
  let instruction: string;
  let fromClipboard = false;

  if (fromFile) {
    // 场景 A:从文件读
    actualFilePath = filePath!;
    instruction = args.slice(1).join(' ').trim();
  } else {
    // 场景 B/C:从剪贴板读,所有 args 当文字指令
    instruction = args.join(' ').trim();
    const clipPath = await getImageFromClipboard();
    if (!clipPath) {
      return {
        error: '剪贴板里没有图片。用法: /image <图片路径> [指令],或先截图到剪贴板再用 /image',
      };
    }
    actualFilePath = clipPath;
    fromClipboard = true;
  }

  let block;
  try {
    block = await encodeImageBlock(actualFilePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  } finally {
    // 剪贴板临时文件读完后清理(best-effort,不影响后续流程)
    if (fromClipboard) {
      void unlink(actualFilePath).catch(() => {});
    }
  }

  // 分配 ID + 存磁盘缓存
  const imageId = nextImageId++;
  const cachePath = saveImageCache(sessionId, imageId, block);
  block.cachePath = cachePath;

  // 构造 content:[ImageBlock, TextBlock?]
  const content: ContentBlock[] = [block];
  if (instruction) {
    content.push({ type: 'text', text: instruction });
  }

  // 构造 displayText(给 TUI 回显)
  const placeholder = `[Image #${imageId}]`;
  const displayText = instruction ? `${instruction} ${placeholder}` : placeholder;

  return { content, displayText };
}
