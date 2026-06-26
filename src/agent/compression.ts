// 上下文压缩：三层策略保持上下文窗口可控
//
// 物理本质：整理办公桌。
// L3: 大文件放进抽屉，桌上只留预览（大结果落盘）
// L1: 旧便签扔掉，换成标签（裁掉旧对话）
// L2: 旧便签换成"之前处理过"（旧工具结果占位）
// L4: 整理一份工作日志，把桌子清空（LLM 全量摘要）

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Message, ContentBlock } from './types.js';

/** 大结果阈值：超过此长度写磁盘 */
const PERSIST_THRESHOLD = 5000;

/** 上下文大小阈值：超过此长度触发完整压缩 */
const CONTEXT_LIMIT = 100000;

/** 保留最近 N 个工具结果的完整内容 */
const KEEP_RECENT = 3;

/** 消息数阈值：超过此数量触发 snip 裁剪 */
const SNIP_THRESHOLD = 50;

/** snip 后保留的尾部消息数 */
const SNIP_KEEP_TAIL = 47;

/** 旧工具结果占位的最小长度 */
const COMPACT_MIN_LENGTH = 120;

/** 持久化目录 */
const OUTPUT_DIR = '.task_outputs/tool-results';

/** 转录保存目录 */
const TRANSCRIPT_DIR = '.transcripts';

/**
 * L3: 大结果持久化
 *
 * 防死循环：read_file 的阈值设为 Infinity。
 * 原因：如果 read_file 触发落盘，模型下次读落盘文件又会触发二次落盘，导致无限循环。
 */
export function persistLargeOutput(toolUseId: string, output: string, toolName?: string): string {
  // read_file 永不落盘（防止死循环）
  if (toolName === 'read_file') return output;
  if (output.length <= PERSIST_THRESHOLD) return output;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const filepath = join(OUTPUT_DIR, `${toolUseId}.txt`);
  writeFileSync(filepath, output, 'utf8');

  const preview = output.slice(0, 2000);
  return `\nFull output saved to: ${filepath}\nPreview:\n${preview}\n...`;
}

/**
 * L1: 裁掉旧对话 (snip_compact)
 *
 * 消息数超过阈值时，保留前 3 条 + 后 47 条，中间裁掉。
 * 边界保护：不拆散 tool_use/tool_result 对。
 */
export function snipCompact(messages: Message[]): Message[] {
  if (messages.length <= SNIP_THRESHOLD) return messages;

  const headCount = 3;
  let cutPoint = messages.length - SNIP_KEEP_TAIL;

  // 安全裁剪点：不拆散 tool_use/tool_result 对
  while (cutPoint > headCount) {
    const msg = messages[cutPoint];
    if (msg?.role === 'user' && Array.isArray(msg.content)) {
      const hasToolResult = (msg.content as ContentBlock[]).some(b => b.type === 'tool_result');
      if (hasToolResult) { cutPoint--; continue; }
    }
    const prev = messages[cutPoint - 1];
    if (prev?.role === 'assistant' && Array.isArray(prev.content)) {
      const hasToolUse = (prev.content as ContentBlock[]).some(b => b.type === 'tool_use');
      if (hasToolUse) { cutPoint--; continue; }
    }
    break;
  }

  const snipped = messages.length - headCount - (messages.length - cutPoint);
  return [
    ...messages.slice(0, headCount),
    { role: 'user', content: `[snipped ${snipped} messages...]` },
    ...messages.slice(cutPoint),
  ];
}

/**
 * L2: 微压缩：旧工具结果改成占位
 *
 * 只保留最近 KEEP_RECENT 个工具结果的完整内容，
 * 更旧的且长度 > 120 字符的改成占位提示。
 */
export function microCompact(messages: Message[]): Message[] {
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      if ((msg.content as ContentBlock[]).some(b => b.type === 'tool_result')) {
        toolResultIndices.push(i);
      }
    }
  }

  if (toolResultIndices.length <= KEEP_RECENT) return messages;

  const toCompact = toolResultIndices.slice(0, -KEEP_RECENT);
  const compacted = [...messages];

  for (const idx of toCompact) {
    const msg = compacted[idx]!;
    const contentStr = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    if (contentStr.length <= COMPACT_MIN_LENGTH) continue;

    compacted[idx] = {
      role: 'user',
      content: [{ type: 'text', text: '[Earlier tool result compacted. Re-run if needed.]' }],
    };
  }

  return compacted;
}

/**
 * L4: 完整压缩：保存记录 + 生成摘要
 */
export function compactHistory(messages: Message[]): Message[] {
  saveTranscript(messages);
  const summary = generateSummary(messages);
  return [{
    role: 'user',
    content: `This conversation was compacted for continuity.\n\n${summary}`,
  }];
}

/**
 * 组合压缩：按 L1 → L2 顺序执行
 *
 * 返回压缩后的消息和是否需要 L4。
 */
export function runCompaction(messages: Message[]): { messages: Message[]; needsL4: boolean } {
  let result = snipCompact(messages);
  result = microCompact(result);
  return { messages: result, needsL4: estimateContextSize(result) > CONTEXT_LIMIT };
}

/** 估算上下文大小 */
export function estimateContextSize(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block) total += block.text.length;
        if ('content' in block && typeof block.content === 'string') total += block.content.length;
      }
    }
  }
  return total;
}

/** 检查是否需要压缩 */
export function needsCompaction(messages: Message[]): boolean {
  return estimateContextSize(messages) > CONTEXT_LIMIT;
}

/** 保存完整转录 */
function saveTranscript(messages: Message[]): void {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  try {
    writeFileSync(join(TRANSCRIPT_DIR, `transcript-${Date.now()}.json`), JSON.stringify(messages, null, 2), 'utf8');
  } catch { /* 静默忽略 */ }
}

/** 生成摘要 */
function generateSummary(messages: Message[]): string {
  const parts: string[] = [];

  const userMsgs = messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean);
  if (userMsgs.length > 0) {
    parts.push('User requests:');
    for (const msg of userMsgs.slice(-3)) parts.push(`- ${msg.slice(0, 100)}`);
  }

  const asstMsgs = messages.filter(m => m.role === 'assistant').map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean);
  if (asstMsgs.length > 0) {
    parts.push('\nRecent assistant actions:');
    for (const msg of asstMsgs.slice(-3)) parts.push(`- ${msg.slice(0, 100)}`);
  }

  return parts.join('\n') || 'No summary available.';
}
