// src/output/message-queue.ts
// 优先级消息队列
//
// 物理本质：急诊室分诊台。
// 病人（消息）按病情严重程度（优先级）排队，
// 病情最重的（error）最先被处理。

import type { OutputMessage, MessageType } from './types.js';
import { MessagePriority } from './types.js';

/**
 * 全局消息 ID 计数器（模块级）
 *
 * 有意设计为模块级而非实例级，确保跨所有 MessageQueue 实例的 ID 全局唯一。
 * 这样即使创建多个队列实例，消息 ID 也不会冲突。
 */
let nextId = 0;

export class MessageQueue {
  /** 消息数组（按优先级排序） */
  private messages: OutputMessage[] = [];

  /**
   * 入队
   *
   * 物理本质：病人挂号，护士根据病情安排排队位置。
   */
  enqueue(params: {
    type: MessageType;
    content: string;
    priority: MessagePriority;
    style?: OutputMessage['style'];
  }): OutputMessage {
    const message: OutputMessage = {
      id: `msg_${nextId++}`,
      type: params.type,
      content: params.content,
      style: params.style,
      priority: params.priority,
      timestamp: Date.now(),
    };

    // 插入排序：找到正确位置插入
    let inserted = false;
    for (let i = 0; i < this.messages.length; i++) {
      if (message.priority > this.messages[i]!.priority) {
        this.messages.splice(i, 0, message);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      this.messages.push(message);
    }

    return message;
  }

  /**
   * 出队（取优先级最高的）
   *
   * 物理本质：护士叫号，病情最重的先进诊室。
   */
  dequeue(): OutputMessage | undefined {
    return this.messages.shift();
  }

  /**
   * 查看下一个（不移除）
   *
   * 物理本质：护士看看下一个是谁，但还没叫号。
   */
  peek(): OutputMessage | undefined {
    return this.messages[0];
  }

  /**
   * 清空队列
   *
   * 物理本质：下班了，所有病人转去其他诊室。
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * 队列大小
   */
  get size(): number {
    return this.messages.length;
  }

  /**
   * 是否为空
   */
  get isEmpty(): boolean {
    return this.messages.length === 0;
  }
}
