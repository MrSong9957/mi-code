// src/output/output-gate.ts
// 输出闸门（唯一出口）
//
// 物理本质：交通管制。
// 所有车辆（输出）必须经过收费站（OutputGate），
// 不允许任何车走应急车道（直接写终端）。
//
// 当前职责：
// - 消息排队：优先级队列（error > thinking > tool > assistant > system）
// - 编码清洗：GBK→UTF-8 自动检测
// - 样式管理：通过 StylePool 生成 ANSI 转义序列
//
// 未来职责（待集成）：
// - 帧缓冲：通过 LayoutScheduler 计算布局，只写变化的格子
// - 内容增长模型：新行靠 LF 滚入 scrollback，页脚钉底

import { MessageQueue } from './message-queue.js';
import { Encoder } from './encoder.js';
import { StylePool } from './style-pool.js';
import { LayoutScheduler } from './layout-scheduler.js';
import type { MessageType, OutputMessage, Writer, TermSize } from './types.js';
import { MessagePriority } from './types.js';

export interface OutputGateOptions {
  rows: number;
  cols: number;
  writer: Writer;
}

export class OutputGate {
  private queue: MessageQueue;
  private stylePool: StylePool;
  private writer: Writer;
  private termSize: TermSize;
  private layout: LayoutScheduler;

  constructor(options: OutputGateOptions) {
    this.queue = new MessageQueue();
    this.stylePool = new StylePool();
    this.writer = options.writer;
    this.termSize = { rows: options.rows, cols: options.cols };
    this.layout = new LayoutScheduler(this.termSize);
  }

  /**
   * 发送消息到队列
   *
   * 物理本质：车辆进入收费站。
   * 所有输出都必须经过这个函数。
   */
  send(type: MessageType, content: string, style?: OutputMessage['style']): OutputMessage {
    // 编码清洗
    const normalized = this.normalize(content);

    // 确定优先级
    const priority = this.getPriority(type);

    // 入队
    return this.queue.enqueue({
      type,
      content: normalized,
      style,
      priority,
    });
  }

  /**
   * 刷新队列（处理所有待处理消息）
   *
   * 物理本质：收费站放行所有车辆。
   * 按优先级顺序处理消息，生成 ANSI 序列，写入终端。
   */
  flush(): void {
    while (!this.queue.isEmpty) {
      const message = this.queue.dequeue();
      if (message) {
        this.processMessage(message);
      }
    }
  }

  /**
   * 处理单个消息
   *
   * 物理本质：检查车辆通行证，放行。
   */
  private processMessage(message: OutputMessage): void {
    // 获取样式
    const style = this.stylePool.get(message.style);
    const ansiStyle = this.stylePool.toAnsi(style);

    // 计算布局（每条消息占 1 行）
    this.layout.calculateLayout({
      messageLines: 1,
      inputLines: 1,
    });

    // 生成 ANSI 序列
    const output = ansiStyle
      ? `${ansiStyle}${message.content}\x1b[0m`
      : message.content;

    // 写入终端
    this.writer(output + '\n');
  }

  /**
   * 标准化文本（编码清洗）
   *
   * 物理本质：检查车辆是否超载，清理货物。
   */
  normalize(text: string): string {
    return Encoder.normalize(text);
  }

  /**
   * 获取消息优先级
   *
   * 物理本质：根据车辆类型确定通行顺序。
   * 救护车（error）最优先，普通车（system）最后。
   */
  private getPriority(type: MessageType): MessagePriority {
    const map: Record<MessageType, MessagePriority> = {
      thinking: MessagePriority.THINKING,
      assistant: MessagePriority.ASSISTANT,
      tool_call: MessagePriority.TOOL_CALL,
      tool_result: MessagePriority.TOOL_RESULT,
      tool_output: MessagePriority.TOOL_OUTPUT,
      system: MessagePriority.SYSTEM,
      error: MessagePriority.ERROR,
      input: MessagePriority.INPUT,
    };
    return map[type] ?? MessagePriority.SYSTEM;
  }

  /**
   * 更新终端尺寸
   */
  updateTermSize(size: TermSize): void {
    this.termSize = size;
    this.layout.updateTermSize(size);
  }

  /**
   * 队列大小（测试用）
   */
  get queueSize(): number {
    return this.queue.size;
  }
}
