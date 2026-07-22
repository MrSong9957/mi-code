// Agent 核心类型定义

/** 对话消息角色 */
export type MessageRole = 'user' | 'assistant';

/** 内容块类型 */
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result' | 'image';

/** 文本内容块 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** 工具调用块（模型输出） */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 工具结果块（写回消息历史） */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/** 图片支持的 MIME 类型（Anthropic API 限定集） */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** 图片内容块（用户输入）。内部命名与 SDK 字段解耦，convertMessages 做映射。 */
export interface ImageBlock {
  type: 'image';
  mediaType: ImageMediaType;
  /** base64 编码的图片数据。持久化时清空（只存 cachePath），resume 时从磁盘回填。 */
  data: string;
  /** 磁盘缓存路径。持久化后通过此路径引用图片，避免 base64 膨胀 JSONL。 */
  cachePath?: string;
}

/** 内容块联合类型 */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

/** 对话消息 */
export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}

/** 工具参数定义（兼容 JSON Schema） */
export interface ToolParameter {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  items?: ToolParameter;
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter;
}

/** 工具执行函数 */
export type ToolExecutor = (input: Record<string, unknown>) => Promise<string>;

/** 注册的工具 */
export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

/** 模型响应 */
export interface ModelResponse {
  content: ContentBlock[];
  stop_reason: 'tool_use' | 'end_turn' | 'max_tokens';
}

/** 循环状态 */
export interface LoopState {
  messages: Message[];
  turn_count: number;
  transition_reason: 'tool_result' | null;
}

/** Agent 配置 */
export interface AgentConfig {
  model: string;
  system: string;
  tools: ToolDefinition[];
  /**
   * 最大 agentic 轮次上限（可选，对齐 Claude Code）。
   * undefined = 无限循环，依赖 LLM 自主 end_turn + 用户 ESC + budget 软限制退出。
   * 显式传入时作为安全网，达到上限后返回 max_turns 终止原因。
   */
  max_turns?: number;
  /** 最大输出 token 数（默认 8000，超限时自动升级到 64000） */
  max_output_tokens?: number;
  /** 预算限制（美元），超限退出 */
  budget_limit?: number;
}

/** LLM 客户端接口 */
export interface LLMClient {
  create(messages: Message[], tools: ToolDefinition[]): Promise<ModelResponse>;
}

// ═══════════════════════════════════════════════════════════════
// 流式输出类型定义
// ═══════════════════════════════════════════════════════════════

/** Token 使用量 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** 内容块类型（流式扩展：增加 thinking 类型） */
export type StreamingContentBlockType = 'text' | 'tool_use' | 'thinking';

// ------ 六种流式事件 ------

/** 1. 消息开始事件（API 返回 message_start） */
export interface MessageStartEvent {
  type: 'message_start';
  messageId: string;
  model: string;
  inputTokens: number;
}

/** 2. 内容块开始事件（API 返回 content_block_start） */
export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  blockType: StreamingContentBlockType;
  blockId?: string; // 仅 tool_use 类型
}

/** 3. 内容块增量事件（API 返回 content_block_delta，每个 token 一次） */
export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  deltaType: 'text' | 'input_json' | 'thinking';
  content: string;
}

/** 4. 内容块结束事件（API 返回 content_block_stop） */
export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

/** 5. 消息增量事件（API 返回 message_delta） */
export interface MessageDeltaEvent {
  type: 'message_delta';
  stopReason: string | null;
  outputTokens: number;
}

/** 6. 消息结束事件（API 返回 message_stop） */
export interface MessageStopEvent {
  type: 'message_stop';
}

/** 流式事件联合类型 */
export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

/** 助手消息（流式输出完成时生成） */
export interface AssistantMessage {
  type: 'assistant';
  content: ContentBlock[];
  usage: Usage;
  stopReason: string | null;
  uuid: string;
  timestamp: string;
}

/** 流式调用选项 */
export interface StreamOptions {
  systemPrompt: string;
  maxTokens: number;
  signal: AbortSignal;
}

/** 流式 LLM 客户端接口 */
export interface StreamingLLMClient {
  stream(
    messages: Message[],
    tools: ToolDefinition[],
    options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage>;
}

// ------ 类型守卫 ------

// 用于运行时验证未类型化数据（如 JSON 解析），TypeScript 的判别联合已在编译时保证类型安全
const STREAM_EVENT_TYPES = new Set<string>([
  'message_start', 'content_block_start', 'content_block_delta',
  'content_block_stop', 'message_delta', 'message_stop',
]);

/** 判断是否为流式事件（统一守卫，避免重复定义） */
export function isStreamEvent(msg: { type?: string }): msg is StreamEvent {
  return typeof msg.type === 'string' && STREAM_EVENT_TYPES.has(msg.type);
}
