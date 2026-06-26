// Agent 核心类型定义

/** 对话消息角色 */
export type MessageRole = 'user' | 'assistant';

/** 内容块类型 */
export type ContentBlockType = 'text' | 'tool_use' | 'tool_result';

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

/** 内容块联合类型 */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

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
  max_turns: number;
  /** 最大输出 token 数（默认 8000，超限时自动升级到 64000） */
  max_output_tokens?: number;
  /** 预算限制（美元），超限退出 */
  budget_limit?: number;
}

/** LLM 客户端接口 */
export interface LLMClient {
  create(messages: Message[], tools: ToolDefinition[]): Promise<ModelResponse>;
}
