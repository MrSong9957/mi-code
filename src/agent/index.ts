// Agent 模块导出
export type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDefinition,
  ToolParameter,
  ToolExecutor,
  RegisteredTool,
  ModelResponse,
  LoopState,
  AgentConfig,
  LLMClient,
} from './types.js';

export { ToolRegistry, createBashTool, createDefaultRegistry } from './tool-registry.js';
export { MockLLMClient, createMockClient } from './llm-client.js';
export { agentLoop, createLoopState, type LoopCallbacks } from './loop.js';

// 错误恢复模块
export {
  createRecoveryState,
  classifyError,
  handleError,
  FailureInbox,
  MAX_RETRY_LIMIT,
  type ErrorType,
  type RecoveryState,
  type FailureRecord,
} from './recovery.js';

export {
  exponentialBackoff,
  jitteredBackoff,
  sleep,
  withBackoff,
} from './backoff.js';
