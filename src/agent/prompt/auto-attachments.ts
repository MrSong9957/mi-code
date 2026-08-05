// Auto 模式 Prompt Attachment 与 Plane 隔离（Task 12 / 设计 §11、§10 A74-A80）
//
// 物理本质：Agent prompt 的"静态骨架"与"动态贴纸"分离器。
//   - static system prompt 不随 permission mode 变化（A74）；
//   - auto_mode_exit 是动态 attachment，只影响 dynamicHash（A75/A76）；
//   - classifier stage instructions 物理隔离，不注册到 Agent prompt（设计 §11）。
//
// 本模块是轻量的 attachment 层，不重构现有 CRC-1/BRC-1/DRC-1 编译链。
// 它提供 compilePromptForMode / compilePrompt 便捷函数，用于验证 plane 隔离不变量。
// 生产 prompt 编译仍走现有 compiler.ts / resolution.ts / profiles.ts 链。

import { createHash } from 'node:crypto';
import type { PermissionMode } from '../../permission/types.js';

/** 动态 attachment 类型（设计 §11） */
export type PromptAttachment =
  | { readonly type: 'auto_mode_exit' };

/**
 * 静态 system prompt 骨架（不随 mode 变化）。
 *
 * 设计 §11：mode 不改变 static system prompt。
 * 这里用一个固定的 base text 代表静态骨架；生产中由 compiler.ts 编译。
 */
const STATIC_SYSTEM_PROMPT = Object.freeze(
  'You are MiCode, an interactive coding agent that helps users with software engineering tasks.',
);

/** staticHash：静态骨架的 sha256（不随 mode/attachment 变化） */
const STATIC_HASH = Object.freeze(sha256(STATIC_SYSTEM_PROMPT));

/** auto_mode_exit attachment 的渲染文本 */
const AUTO_MODE_EXIT_TEXT = Object.freeze(
  'Permission mode has exited auto. Subsequent tool calls will follow the new permission mode.',
);

/**
 * 按 mode 编译 prompt 快照（A74）。
 *
 * mode 不进入 static system sections——staticHash 在所有 mode 下相同。
 * 返回 { text, staticHash, dynamicHash } 供测试断言 plane 隔离。
 */
export function compilePromptForMode(_mode: PermissionMode): {
  readonly text: string;
  readonly staticHash: string;
  readonly dynamicHash: string;
} {
  // mode 不改变 static prompt；dynamicHash 此时无 attachment，等于空内容的 hash
  return compilePrompt({ attachments: [] });
}

/**
 * 编译 prompt 快照（A76）。
 *
 * attachments 只影响 dynamicHash，不影响 staticHash。
 * staticHash 恒定为静态骨架的 hash。
 * dynamicHash = sha256(attachment 渲染文本的有序拼接)。
 */
export function compilePrompt(options: {
  readonly attachments?: readonly PromptAttachment[];
}): {
  readonly text: string;
  readonly staticHash: string;
  readonly dynamicHash: string;
} {
  const attachments = options.attachments ?? [];
  const dynamicParts = attachments.map(renderAttachment);
  const dynamicText = dynamicParts.join('\n');
  const fullText = dynamicText.length > 0
    ? `${STATIC_SYSTEM_PROMPT}\n\n---\n\n${dynamicText}`
    : STATIC_SYSTEM_PROMPT;
  return Object.freeze({
    text: fullText,
    staticHash: STATIC_HASH,
    dynamicHash: sha256(dynamicText),
  });
}

/** 渲染单个 attachment 为文本 */
function renderAttachment(attachment: PromptAttachment): string {
  switch (attachment.type) {
    case 'auto_mode_exit':
      return AUTO_MODE_EXIT_TEXT;
  }
}

/**
 * 把 attachment 列表渲染为可注入 systemPrompt 的文本段（生产接线用）。
 *
 * 多个 attachment 以换行分隔。空列表返回空字符串（调用方据此决定是否追加）。
 * 返回值非空时，index.ts 以 `\n\n---\n\n` 分隔追加到 static system prompt 之后。
 */
export function renderAttachmentsForPrompt(attachments: readonly PromptAttachment[]): string {
  if (attachments.length === 0) return '';
  return attachments.map(renderAttachment).join('\n');
}

/** sha256 hex */
function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
