// 上下文压缩：三层策略保持上下文窗口可控
//
// 物理本质：整理办公桌。
// L3: 大文件放进抽屉，桌上只留预览（大结果落盘）
// L1: 旧便签扔掉，换成标签（裁掉旧对话）
// L2: 旧便签换成"之前处理过"（旧工具结果占位）
// L4: 整理一份工作日志，把桌子清空（LLM 全量摘要）

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Message, ContentBlock, StreamingLLMClient, StreamEvent, AssistantMessage } from './types.js';
import type { ToolTranscriptValidation } from './tools/transcript-validator.js';

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
 * 摘要请求的系统提示：指导小模型如何压缩对话历史。
 */
const SUMMARIZE_SYSTEM_PROMPT = [
  'You are a conversation summarizer.',
  'Summarize the key information of the conversation below concisely:',
  '- User requests and goals',
  '- Decisions made and actions taken',
  '- Current state and pending work',
  'Reply with the summary text only, no preamble.',
].join('\n');

/**
 * 从流式事件中提取最终的助手文本。
 *
 * 物理本质：接水管。
 * API 流出来的是一串水滴（content_block_delta），我们拿桶接着，
 * 等水流完（message_stop），桶里就是完整的摘要文本。
 */
async function extractTextFromStream(
  events: AsyncGenerator<StreamEvent | AssistantMessage>,
): Promise<string> {
  let text = '';
  for await (const event of events) {
    // 只关心文本增量事件
    if (event.type === 'content_block_delta' && event.deltaType === 'text') {
      text += event.content;
    }
  }
  return text;
}

/**
 * L4+: 用小模型生成真实摘要（带本地启发式回退）。
 *
 * 物理本质：请一个"临时秘书"（小模型）读完整本工作日志，写一份精炼总结。
 * 如果秘书请假（API 失败/超时），就用柜子里那份"机械模板总结"（本地启发式）顶上，
 * 绝不让整理办公桌这件事把整个办公室搞停工。
 *
 * @param messages 待压缩的对话历史
 * @param client   流式 LLM 客户端（通常用小模型实例化的 AnthropicStreamClient）
 * @returns 压缩后的单条 user 消息（保持与 compactHistory 相同的连续性前缀）
 */
export async function compactHistoryWithLLM(
  messages: Message[],
  client: StreamingLLMClient,
): Promise<Message[]> {
  saveTranscript(messages);

  let summary: string;
  try {
    const stream = client.stream(
      [{ role: 'user', content: serializeMessagesForSummary(messages) }],
      [], // 摘要任务不需要工具
      {
        systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
        maxTokens: 2048,
        signal: new AbortController().signal,
      },
    );
    summary = (await extractTextFromStream(stream)).trim();
    // 小模型可能返回空内容 → 回退本地摘要
    if (!summary) {
      summary = generateSummary(messages);
    }
  } catch {
    // 任何失败（网络/超时/解析）都回退本地启发式，保证不崩
    summary = generateSummary(messages);
  }

  return [{
    role: 'user',
    content: `This conversation was compacted for continuity.\n\n${summary}`,
  }];
}

/**
 * 把消息序列化成给摘要模型的纯文本输入。
 * 去掉 tool_use/tool_result 等结构化块的细节，只保留可读文本。
 */
function serializeMessagesForSummary(messages: Message[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content
        .map(block => {
          if (block.type === 'text') return block.text;
          if (block.type === 'tool_use') return `[tool: ${block.name}]`;
          if (block.type === 'tool_result') return `[tool result]`;
          if (block.type === 'image') return '[image]';
          return '';
        })
        .filter(Boolean)
        .join(' ');
    if (text) lines.push(`${role}: ${text}`);
  }
  return lines.join('\n');
}

/**
 * 组合压缩：按 L1 → L2 顺序执行
 *
 * 返回压缩后的消息和是否需要 L4。
 *
 * Wave B Task 11 (M-070 / BRC-5): 加了可选的 `before_compaction` checkpoint preflight。
 *
 * 物理本质: "整理办公桌前先体检"。压缩会把旧消息裁/换占位,在动刀前要求调用方
 * 出示一份 `before_compaction` checkpoint 上的 accepted validation,证明这份 transcript
 * 的 use/result 配对完整。压缩一份配对残缺的 transcript 会让"缺失 result 的 use"被
 * 裁掉后永远查不回因果,所以 fail-closed。
 *
 * 行为:
 *   - 不传 options: 走 legacy 路径,完全不校验,保持向后兼容(老的错误恢复 / 测试都走这条)。
 *   - 传 preflightValidation: 要求 checkpoint === 'before_compaction' AND status === 'accepted',
 *     否则抛 `{ code: 'tool_transcript.invalid', checkpoint: 'before_compaction' }`,不压缩。
 *
 * 注意: validator 不合成 result、不决定 Outcome,这里只信任 validator 冻结的判定。
 */
export function runCompaction(
  messages: Message[],
  options?: { preflightValidation?: ToolTranscriptValidation },
): { messages: Message[]; needsL4: boolean } {
  if (options?.preflightValidation !== undefined) {
    const v = options.preflightValidation;
    if (v.checkpoint !== 'before_compaction' || v.status !== 'accepted') {
      throw {
        code: 'tool_transcript.invalid',
        checkpoint: 'before_compaction',
      };
    }
  }
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
        // 图片 token 估算:base64 长度 / 300(粗略对标 Anthropic ~2000 token/张)。
        // 不计入会导致 estimateContextSize 严重低估 → 压缩永不触发 → 上下文爆炸。
        if (block.type === 'image') total += Math.ceil(block.data.length / 300);
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

/** 从消息 content 提取可读文本(text 块拼接 + image 标记) */
function contentToSummaryText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

/** 生成摘要 */
function generateSummary(messages: Message[]): string {
  const parts: string[] = [];

  const userMsgs = messages.filter(m => m.role === 'user').map(m => contentToSummaryText(m.content)).filter(Boolean);
  if (userMsgs.length > 0) {
    parts.push('User requests:');
    for (const msg of userMsgs.slice(-3)) parts.push(`- ${msg.slice(0, 100)}`);
  }

  const asstMsgs = messages.filter(m => m.role === 'assistant').map(m => contentToSummaryText(m.content)).filter(Boolean);
  if (asstMsgs.length > 0) {
    parts.push('\nRecent assistant actions:');
    for (const msg of asstMsgs.slice(-3)) parts.push(`- ${msg.slice(0, 100)}`);
  }

  return parts.join('\n') || 'No summary available.';
}
