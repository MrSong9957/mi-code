// src/ui/content-region.ts
// 内容分区管理器
//
// 物理本质：分拣员。
// 把消息按类型分到不同的区域（消息区/工具区/系统区）。

import type { UIMessageType, FormattedLine } from './types.js';

/** 消息区类型 */
const MESSAGE_TYPES = new Set<UIMessageType>(['thinking', 'thinking_content', 'thinking_end', 'assistant']);

/** 工具区类型 */
const TOOL_TYPES = new Set<UIMessageType>(['tool_call', 'tool_result', 'tool_output', 'permission']);

/** 系统区类型 */
const SYSTEM_TYPES = new Set<UIMessageType>(['system', 'error', 'input']);

export class ContentRegion {
  /** 消息区（thinking + assistant） */
  private messageLines: Array<{ type: UIMessageType; line: FormattedLine }> = [];
  /** 工具区（tool_call + tool_result + tool_output + permission） */
  private toolLines: Array<{ type: UIMessageType; line: FormattedLine }> = [];
  /** 系统区（system + error + input） */
  private systemLines: Array<{ type: UIMessageType; line: FormattedLine }> = [];

  /**
   * 添加一行到对应区域
   *
   * 物理本质：分拣员把快递按类型放到不同的传送带。
   */
  addLine(type: UIMessageType, line: FormattedLine): void {
    const entry = { type, line };

    if (MESSAGE_TYPES.has(type)) {
      this.messageLines.push(entry);
    } else if (TOOL_TYPES.has(type)) {
      this.toolLines.push(entry);
    } else if (SYSTEM_TYPES.has(type)) {
      this.systemLines.push(entry);
    }
  }

  /**
   * 获取消息区所有行
   */
  getMessageLines(): FormattedLine[] {
    return this.messageLines.map(e => e.line);
  }

  /**
   * 获取工具区所有行
   */
  getToolLines(): FormattedLine[] {
    return this.toolLines.map(e => e.line);
  }

  /**
   * 获取系统区所有行
   */
  getSystemLines(): FormattedLine[] {
    return this.systemLines.map(e => e.line);
  }

  /**
   * 获取所有行（按消息区 -> 工具区 -> 系统区顺序）
   */
  getAllLines(): FormattedLine[] {
    return [
      ...this.messageLines.map(e => e.line),
      ...this.toolLines.map(e => e.line),
      ...this.systemLines.map(e => e.line),
    ];
  }

  /**
   * 清空所有区域
   */
  clear(): void {
    this.messageLines = [];
    this.toolLines = [];
    this.systemLines = [];
  }

  /**
   * 总行数
   */
  get lineCount(): number {
    return this.messageLines.length + this.toolLines.length + this.systemLines.length;
  }
}
