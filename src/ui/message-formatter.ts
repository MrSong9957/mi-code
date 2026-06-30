// src/ui/message-formatter.ts
// 消息格式化器
//
// 物理本质：排版工人。
// 给每种消息贴上统一格式的标签（前缀、样式、缩进）。

import type { UIMessageType, UIMessageMeta, FormattedLine, UIMessageStyle } from './types.js';

/** 紫色样式 */
const MAGENTA_STYLE: UIMessageStyle = { fg: 'magenta' };
/** 灰色样式 */
const DIM_STYLE: UIMessageStyle = { dim: true };
/** 绿色粗体样式 */
const GREEN_BOLD_STYLE: UIMessageStyle = { fg: 'green', bold: true };
/** 红色样式 */
const RED_STYLE: UIMessageStyle = { fg: 'red' };
/** 默认样式 */
const DEFAULT_STYLE: UIMessageStyle = {};

export class MessageFormatter {
  /**
   * 格式化消息
   *
   * 物理本质：排版工人根据消息类型贴标签。
   */
  static format(type: UIMessageType, meta: UIMessageMeta = {}, content?: string): FormattedLine[] {
    switch (type) {
      case 'thinking':
        return [{ content: '● Thinking…', style: MAGENTA_STYLE, indent: 0 }];

      case 'thinking_content':
        return [{ content: `  ${content ?? ''}`, style: DIM_STYLE, indent: 2 }];

      case 'thinking_end':
        return [this.formatThinkingEnd(meta)];

      case 'assistant':
        return [{ content: `● ${content ?? ''}`, style: MAGENTA_STYLE, indent: 0 }];

      case 'tool_call':
        return [this.formatToolCall(meta)];

      case 'tool_result':
        return [this.formatToolResult(meta)];

      case 'tool_output':
        return [this.formatToolOutput(meta)];

      case 'permission':
        return [{ content: `  ⎿  ${meta.permission ?? ''}`, style: DIM_STYLE, indent: 2 }];

      case 'system':
        return [{ content: content ?? '', style: DEFAULT_STYLE, indent: 0 }];

      case 'error':
        return [{ content: content ?? '', style: RED_STYLE, indent: 0 }];

      case 'input':
        return [{ content: `❯ ${content ?? ''}`, style: GREEN_BOLD_STYLE, indent: 0 }];

      default:
        return [{ content: content ?? '', style: DEFAULT_STYLE, indent: 0 }];
    }
  }

  /**
   * 格式化 thinking 结束
   *
   * 示例：  Thought for 17s, read 2 files (ctrl+o to expand)
   */
  private static formatThinkingEnd(meta: UIMessageMeta): FormattedLine {
    const duration = meta.duration ?? 0;
    const filesRead = meta.filesRead ?? 0;

    let text = `  Thought for ${duration}s`;
    if (filesRead > 0) {
      text += `, read ${filesRead} file${filesRead > 1 ? 's' : ''}`;
    }
    text += ' (ctrl+o to expand)';

    return { content: text, style: DIM_STYLE, indent: 2 };
  }

  /**
   * 格式化工具调用
   *
   * 示例：● Bash(cd ...)
   */
  private static formatToolCall(meta: UIMessageMeta): FormattedLine {
    const name = meta.toolName ?? 'unknown';
    const args = meta.toolArgs;

    let content = `● ${name}`;
    if (args) {
      // 参数过长时截断
      const maxArgsLen = 50;
      const displayArgs = args.length > maxArgsLen ? args.slice(0, maxArgsLen) + '…' : args;
      content += `(${displayArgs})`;
    }

    return { content, style: MAGENTA_STYLE, indent: 0 };
  }

  /**
   * 格式化工具结果
   *
   * 示例：  ⎿  Added 2 lines, removed 1 line
   */
  private static formatToolResult(meta: UIMessageMeta): FormattedLine {
    const added = meta.linesAdded ?? 0;
    const removed = meta.linesRemoved ?? 0;

    if (added === 0 && removed === 0) {
      return { content: '  ⎿  Done', style: DIM_STYLE, indent: 2 };
    }

    const parts: string[] = [];
    if (added > 0) {
      parts.push(`Added ${added} line${added > 1 ? 's' : ''}`);
    }
    if (removed > 0) {
      parts.push(`removed ${removed} line${removed > 1 ? 's' : ''}`);
    }

    return { content: `  ⎿  ${parts.join(', ')}`, style: DIM_STYLE, indent: 2 };
  }

  /**
   * 格式化工具输出
   *
   * 示例：  ⎿  > npm test ...
   */
  private static formatToolOutput(meta: UIMessageMeta): FormattedLine {
    const output = meta.output ?? '';
    // 截断过长输出
    const maxLen = 200;
    const displayOutput = output.length > maxLen ? output.slice(0, maxLen) + '…' : output;

    return { content: `  ⎿  ${displayOutput}`, style: DIM_STYLE, indent: 2 };
  }
}
