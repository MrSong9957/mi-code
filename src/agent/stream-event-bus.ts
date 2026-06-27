// 流式事件总线：发布/订阅模式，连接生产者（查询循环）和消费者（渲染器、存储）
//
// 物理本质：广播电台。
// 查询循环是"播音员"，emit 发射信号。
// 渲染器、会话存储是"收音机"，on 监听信号。
// 多个收音机可以同时收听同一个频道，互不干扰。

import { EventEmitter } from 'events';
import type { StreamEvent, AssistantMessage } from './types.js';

/** 流式事件类型 */
export type StreamEventType =
  | 'stream_event'        // 原始流式事件（用于实时 token 渲染）
  | 'assistant_message'   // 助手消息完成（用于消息渲染）
  | 'tool_call'           // 工具调用开始（用于工具状态显示）
  | 'tool_result'         // 工具执行结果（用于工具结果显示）
  | 'error'               // 错误事件（用于错误显示）
  | 'loop_end';           // 循环结束（用于清理 UI 状态）

/** 工具调用事件数据 */
export interface ToolCallEvent {
  name: string;
  input: Record<string, unknown>;
  startTime: number;
}

/** 工具结果事件数据 */
export interface ToolResultEvent {
  toolUseId: string;
  name: string;
  output: string;
  duration: number;
}

/** 错误事件数据 */
export interface ErrorEvent {
  errorType: string;
  message: string;
  recoverable: boolean;
}

/** 循环结束事件数据 */
export interface LoopEndEvent {
  reason: string;
}

/**
 * StreamEventBus
 *
 * 类型安全的事件总线，用于流式事件的发布/订阅。
 * 基于 Node.js EventEmitter 封装，提供类型安全的 emit/on/off 方法。
 */
/** 默认最大监听器数量 */
const DEFAULT_MAX_LISTENERS = 20;

export class StreamEventBus {
  private emitter = new EventEmitter();

  constructor(maxListeners: number = DEFAULT_MAX_LISTENERS) {
    this.emitter.setMaxListeners(maxListeners);
  }

  // ------ stream_event ------
  emitStreamEvent(event: StreamEvent): void {
    this.emitter.emit('stream_event', event);
  }
  onStreamEvent(handler: (event: StreamEvent) => void): void {
    this.emitter.on('stream_event', handler);
  }
  offStreamEvent(handler: (event: StreamEvent) => void): void {
    this.emitter.removeListener('stream_event', handler);
  }

  // ------ assistant_message ------
  emitAssistantMessage(message: AssistantMessage): void {
    this.emitter.emit('assistant_message', message);
  }
  onAssistantMessage(handler: (message: AssistantMessage) => void): void {
    this.emitter.on('assistant_message', handler);
  }
  offAssistantMessage(handler: (message: AssistantMessage) => void): void {
    this.emitter.removeListener('assistant_message', handler);
  }

  // ------ tool_call ------
  emitToolCall(data: ToolCallEvent): void {
    this.emitter.emit('tool_call', data);
  }
  onToolCall(handler: (data: ToolCallEvent) => void): void {
    this.emitter.on('tool_call', handler);
  }
  offToolCall(handler: (data: ToolCallEvent) => void): void {
    this.emitter.removeListener('tool_call', handler);
  }

  // ------ tool_result ------
  emitToolResult(data: ToolResultEvent): void {
    this.emitter.emit('tool_result', data);
  }
  onToolResult(handler: (data: ToolResultEvent) => void): void {
    this.emitter.on('tool_result', handler);
  }
  offToolResult(handler: (data: ToolResultEvent) => void): void {
    this.emitter.removeListener('tool_result', handler);
  }

  // ------ error ------
  emitError(data: ErrorEvent): void {
    this.emitter.emit('error', data);
  }
  onError(handler: (data: ErrorEvent) => void): void {
    this.emitter.on('error', handler);
  }
  offError(handler: (data: ErrorEvent) => void): void {
    this.emitter.removeListener('error', handler);
  }

  // ------ loop_end ------
  emitLoopEnd(data: LoopEndEvent): void {
    this.emitter.emit('loop_end', data);
  }
  onLoopEnd(handler: (data: LoopEndEvent) => void): void {
    this.emitter.on('loop_end', handler);
  }
  offLoopEnd(handler: (data: LoopEndEvent) => void): void {
    this.emitter.removeListener('loop_end', handler);
  }

  /** 移除所有监听器 */
  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
