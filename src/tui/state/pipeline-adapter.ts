// src/tui/state/pipeline-adapter.ts
// PipelineToStoreAdapter：实现 PipelineRenderer，把 BlockPipeline 调用翻译成 messages-store 操作
//
// 物理本质：旧 Renderer 接口的「store 版替身」。
// BlockPipeline 内部把 Block 格式化成 FormattedLine / 流式累积文本，再调 PipelineRenderer
// 的方法。旧实现是手写 ANSI Renderer（printMessage 写屏）；本 adapter 不写屏，而是把这些
// 数据推进 zustand store，由 React + Ink 渲染。
//
// 映射：
// - printMessage(text, role, style, raw) → appendLine(role, FormattedLine)
// - appendStreamingMarkdown(text, isFinal, opts):
//     首次(isFinal=false 且无流式) → startStreaming(prefix + text)
//     后续(isFinal=false)         → updateStreaming(prefix + text)
//     isFinal=true                 → finalizeStreaming(用 prefix+text 造一行)
// - sealStreaming → finalizeStreaming（用当前 streamingText）
// - clearMessages → store.clear()
// - flushNow → 无操作（store 响应式，Ink 自动重渲染）
//
// 注意：本 adapter 不做 Markdown 渲染（Phase 5 接 StreamingMarkdown 时，固化行的渲染
// 由 React 侧完成；adapter 只把 streamingText 透传，固化时造一个含 prefix 的占位行）。

import type { PipelineRenderer } from '../../ui/block-pipeline.js';
import type { FormattedLine, UIMessageStyle } from '../../ui/types.js';
import type { MessagesStore } from './messages-store.js';
import type { MessageRole } from './messages-store.js';

/** system/banner 等 role 字符串 → TuiMessage.role 映射 */
function mapRole(role: string | undefined): MessageRole {
  switch (role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'tool': return 'tool';
    default: return 'system'; // system / banner / error / undefined
  }
}

export class PipelineToStoreAdapter implements PipelineRenderer {
  private store: MessagesStore;
  /** 流式块的 firstLinePrefix（首次 appendStreamingMarkdown 时记录，后续复用） */
  private streamingPrefix = '';

  constructor(store: MessagesStore) {
    this.store = store;
  }

  printMessage(
    text: string,
    role?: string,
    style?: Record<string, unknown>,
    _raw?: boolean,
  ): void {
    const line: FormattedLine = {
      content: text,
      style: (style ?? {}) as UIMessageStyle,
      indent: 0,
    };
    if (_raw) line.raw = true;
    this.store.getState().appendLine(mapRole(role), line);
  }

  appendStreamingMarkdown(
    text: string,
    isFinal: boolean,
    opts?: { indent?: number; firstLinePrefix?: string; firstLineStyle?: UIMessageStyle },
  ): void {
    const prefix = opts?.firstLinePrefix ?? '';
    const fullText = prefix + text;

    if (isFinal) {
      // 固化：用 prefix + text 造最终行（MVP：单行；Phase 5 接 Markdown 后精化）
      const style = opts?.firstLineStyle ?? {};
      const lines: FormattedLine[] = text === ''
        ? []
        : [{ content: fullText, style, indent: opts?.indent ?? 0 }];
      // 若已有流式块，finalizeStreaming 固化它；否则新建
      const msgs = this.store.getState().messages;
      const last = msgs[msgs.length - 1];
      if (last && !last.finalized && last.role === 'assistant') {
        this.store.getState().finalizeStreaming(lines.length > 0 ? lines : [{ content: '', style: {}, indent: 0 }]);
      } else if (lines.length > 0) {
        this.store.getState().appendMessage('assistant', lines);
      }
      this.streamingPrefix = '';
      return;
    }

    // 非终态：首次 startStreaming，后续 updateStreaming
    const msgs = this.store.getState().messages;
    const last = msgs[msgs.length - 1];
    if (last && !last.finalized && last.role === 'assistant') {
      this.store.getState().updateStreaming(fullText);
    } else {
      this.streamingPrefix = prefix;
      this.store.getState().startStreaming(fullText);
    }
  }

  sealStreaming(): void {
    // 用当前 streamingText 固化（封口）
    const msgs = this.store.getState().messages;
    const last = msgs[msgs.length - 1];
    if (last && !last.finalized && last.role === 'assistant' && last.streamingText !== undefined) {
      const line: FormattedLine = {
        content: last.streamingText,
        style: { fg: 'brand' },
        indent: 0,
      };
      this.store.getState().finalizeStreaming([line]);
    }
    this.streamingPrefix = '';
  }

  flushNow(): void {
    // 无操作：store 是响应式的，Ink 自动重渲染。
    // 保留方法以满足 PipelineRenderer 接口契约。
  }

  startToolCall(toolUseId: string, lines: FormattedLine[]): void {
    this.store.getState().appendPendingTool(toolUseId, lines);
  }

  finishToolCall(toolUseId: string, lines: FormattedLine[]): boolean {
    return this.store.getState().resolvePendingTool(toolUseId, lines);
  }

  appendToolHook(toolUseId: string, lines: FormattedLine[]): boolean {
    return this.store.getState().appendToolHook(toolUseId, lines);
  }

  updateToolProgress(parentToolUseId: string, progressLines: FormattedLine[]): boolean {
    // AUTO-0025 Task 3:转发到 store 的 updatePendingToolProgress。
    // store 按 parentToolUseId 精确匹配,重建 pending 消息的 lines = 原 call 行 + 进度快照。
    return this.store.getState().updatePendingToolProgress(parentToolUseId, progressLines);
  }

  appendStreamingThinking(text: string): void {
    // 流式 thinking：首次 startStreamingThinking，后续 updateStreamingThinking
    const msgs = this.store.getState().messages;
    const last = msgs[msgs.length - 1];
    if (last && !last.finalized && last.role === 'thinking') {
      this.store.getState().updateStreamingThinking(text);
    } else {
      this.store.getState().startStreamingThinking(text);
    }
  }

  eraseStreamingThinking(): void {
    // 折叠：移除流式 thinking 消息，摘要行由 printMessage 追加
    this.store.getState().removeStreamingThinking();
  }

  clearMessages(): void {
    this.store.getState().clear();
    this.streamingPrefix = '';
  }
}
