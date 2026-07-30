// src/ui/message-formatter.ts
// 消息格式化器（已接入 block-format 统一契约）
//
// 物理本质：排版工厂的「路由员」。
// 接收语义消息类型（thinking / tool_call / tool_result / ...），
// 路由到 block-format 的统一格式化函数，贴上前缀、缩进、样式标签。
//
// 关键设计原则（统一性）：
// 1. 内容字符串本身**不含前导缩进空格**——缩进完全由 indent 字段表达。
//    （旧的 `  ⎿  ...` 双重缩进 bug 已消除。）
// 2. 所有块样式复用 block-format.BLOCK_STYLES 的单例常量，
//    保证 MessageBuffer.appendText 的 styleEq 能正确累积流式内容。
// 3. tool_call 从 toolInput（真实参数对象）提取显示文本；
//    tool_result 按工具类型分派（edit/write 显示行数、bash 显示输出摘要）。

import type { UIMessageType, UIMessageMeta, FormattedLine } from './types.js';
import {
  BLOCK_STYLES,
  formatToolCallDisplay,
  formatThinkingSummary,
  summarizeOutput,
} from './block-format.js';

/** Bash 等输出摘要的最大预览行数 */
const OUTPUT_PREVIEW_LINES = 4;

export class MessageFormatter {
  /**
   * 格式化消息
   *
   * 物理本质：路由员根据消息类型，把任务派发给 block-format 的专门函数。
   */
  static format(type: UIMessageType, meta: UIMessageMeta = {}, content?: string): FormattedLine[] {
    switch (type) {
      case 'thinking':
        return [{ content: `● ${content ?? 'Thinking…'}`, style: BLOCK_STYLES.magenta, indent: 0 }];

      case 'thinking_content':
        // thinking 折叠模式下不再实时显示内容，仅保留分支以防外部调用
        return [{ content: content ?? '', style: BLOCK_STYLES.dim, indent: 2 }];

      case 'thinking_end':
        return [this.formatThinkingEnd(meta)];

      case 'assistant':
        return [{ content: `● ${content ?? ''}`, style: BLOCK_STYLES.magenta, indent: 0 }];

      case 'tool_call':
        return [this.formatToolCall(meta)];

      case 'tool_result':
        return this.formatToolResult(meta);

      case 'tool_output':
        return [this.formatToolOutput(meta)];

      case 'permission':
        return [{ content: `⎿  ${meta.permission ?? ''}`, style: BLOCK_STYLES.dim, indent: 2 }];

      case 'system':
        return [{ content: content ?? '', style: BLOCK_STYLES.default, indent: 0 }];

      case 'error':
        return [{ content: content ?? '', style: BLOCK_STYLES.red, indent: 0 }];

      case 'input':
        // 多行 input 按 \n 拆成多条 FormattedLine：
        // 单条 content 含 \n 会让渲染层 footerHeight 账本错乱（物理行被 \n 提前断开，
        // 但账本只记 1 行 → 下一帧 cursorUp 覆写丢失前面行，表现为"只显示最后一句"）。
        // 首行带 ❯ 前缀，续行无前缀同色（与输入框多行续行视觉一致）。
        // 单行输入：split 返回长度 1，行为完全不变。
        return (content ?? '').split('\n').map((line, i) => ({
          content: i === 0 ? `❯ ${line}` : line,
          style: BLOCK_STYLES.greenBold,
          indent: 0,
        }));

      default:
        return [{ content: content ?? '', style: BLOCK_STYLES.default, indent: 0 }];
    }
  }

  /**
   * 格式化 thinking 结束摘要（委托 block-format）
   *
   * 示例：thought for 17s, read 2 files (ctrl+o to expand)
   */
  private static formatThinkingEnd(meta: UIMessageMeta): FormattedLine {
    return {
      // 2 空格缩进烤进 content（indent 字段是死数据，渲染层不消费；
      // 这里直接前置空格保证渲染时缩进生效，与 ⎿ 结果行对齐）
      content: '  ' + formatThinkingSummary(meta.duration ?? 0, meta.filesRead ?? 0),
      style: BLOCK_STYLES.dim,
      indent: 2,
    };
  }

  /**
   * 格式化工具调用：`● Name(key_args)`
   *
   * 优先用 toolInput（真实参数对象）；兼容旧字段 toolArgs（字符串）。
   */
  private static formatToolCall(meta: UIMessageMeta): FormattedLine {
    const name = meta.toolName ?? 'unknown';

    let display: string;
    if (meta.toolInput && Object.keys(meta.toolInput).length > 0) {
      // 新路径：从参数对象提取
      display = formatToolCallDisplay(name, meta.toolInput);
    } else if (meta.toolArgs) {
      // 兼容旧字段（直接拼字符串，工具名按字面）
      const maxArgsLen = 60;
      const displayArgs = meta.toolArgs.length > maxArgsLen ? meta.toolArgs.slice(0, maxArgsLen) + '…' : meta.toolArgs;
      display = `${name}(${displayArgs})`;
    } else {
      display = name;
    }

    return { content: `● ${display}`, style: BLOCK_STYLES.magenta, indent: 0 };
  }

  /**
   * 格式化工具结果，按数据来源分派：
   * 1. 有 linesAdded/linesRemoved → edit/write 风格：`⎿  Added N lines, removed M line`
   * 2. 有 rawOutput（Bash 等）→ 输出摘要：preview + `+N 行 (ctrl+o to expand)`
   * 3. 都没有 → `⎿  Done` 兜底
   */
  private static formatToolResult(meta: UIMessageMeta): FormattedLine[] {
    const added = meta.linesAdded ?? 0;
    const removed = meta.linesRemoved ?? 0;

    // 路径 1：edit/write 行数统计
    if (added > 0 || removed > 0) {
      const parts: string[] = [];
      if (added > 0) parts.push(`Added ${added} line${added > 1 ? 's' : ''}`);
      if (removed > 0) parts.push(`removed ${removed} line${removed > 1 ? 's' : ''}`);
      return [{ content: `⎿  ${parts.join(', ')}`, style: BLOCK_STYLES.dim, indent: 2 }];
    }

    // 路径 2：Bash 等原始输出摘要（raw=true，跳过 Markdown 渲染——
    // 工具输出可能含 --- / # / * 等 markdown 特殊字符，不该被误判为 hr/标题/粗体）
    if (meta.rawOutput !== undefined && meta.rawOutput !== '') {
      const { preview, totalLines, truncated } = summarizeOutput(meta.rawOutput, OUTPUT_PREVIEW_LINES);
      const lines: FormattedLine[] = [];
      // preview 可能多行，每行一行（首行带 ⎿）
      const previewLines = preview.split('\n');
      previewLines.forEach((pl, i) => {
        const prefix = i === 0 ? '⎿  ' : '   ';
        lines.push({ content: `${prefix}${pl}`, style: BLOCK_STYLES.dim, indent: 2, raw: true });
      });
      // 截断时追加折叠提示
      if (truncated) {
        const hidden = totalLines - OUTPUT_PREVIEW_LINES;
        lines.push({ content: `   +${hidden} 行 (ctrl+o to expand)`, style: BLOCK_STYLES.dim, indent: 2, raw: true });
      }
      return lines;
    }

    // 路径 3：兜底
    return [{ content: '⎿  Done', style: BLOCK_STYLES.dim, indent: 2 }];
  }

  /**
   * 格式化工具输出（独立 tool_output 类型，保留兼容）
   *
   * 示例：⎿  > npm test ...
   */
  private static formatToolOutput(meta: UIMessageMeta): FormattedLine {
    const output = meta.output ?? '';
    const maxLen = 200;
    const displayOutput = output.length > maxLen ? output.slice(0, maxLen) + '…' : output;
    return { content: `⎿  ${displayOutput}`, style: BLOCK_STYLES.dim, indent: 2 };
  }
}
