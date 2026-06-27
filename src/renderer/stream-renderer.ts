// 流式事件渲染器（增强版）：Claude Code 级别的终端渲染效果
//
// 物理本质：舞台导演。
// AI 是演员（输出内容），渲染器是导演（决定怎么呈现）。
// - 文本内容 → 用 Markdown 渲染（带颜色）
// - 代码块 → 用语法高亮（关键字、字符串、注释）
// - 工具调用 → 用状态面板（spinner 动画）
// - Thinking → 用灰色显示（可折叠）

import type {
  StreamEvent,
  AssistantMessage,
  ContentBlock,
} from '../agent/types.js';
import type {
  StreamEventBus,
  ToolCallEvent,
  ToolResultEvent,
  ErrorEvent,
  LoopEndEvent,
} from '../agent/stream-event-bus.js';
import { MarkdownStreamRenderer } from './markdown-renderer.js';
import { CodeHighlighter } from './code-highlighter.js';
import { ToolStatusPanel } from './tool-status-panel.js';
import { ANSI } from './colors.js';

/** 渲染选项 */
export interface StreamRendererOptions {
  showTokenStream?: boolean;
  showToolCalls?: boolean;
  showThinking?: boolean;
  write?: (text: string) => void;
}

/**
 * StreamEventRenderer（增强版）
 *
 * 集成 Markdown 渲染、代码高亮、工具状态面板、Thinking 块显示。
 */
export class StreamEventRenderer {
  private options: Required<StreamRendererOptions>;
  private markdownRenderer: MarkdownStreamRenderer;
  private codeHighlighter: CodeHighlighter;
  private toolPanel: ToolStatusPanel;
  private isAttached = false;
  private isInCodeBlock = false;
  private codeBlockBuffer = '';
  private codeBlockLanguage = '';
  private thinkingBuffer = '';
  private thinkingStartTime = 0;
  private bus: StreamEventBus | null = null;
  private handlers: {
    streamEvent: (event: StreamEvent) => void;
    assistantMessage: (msg: AssistantMessage) => void;
    toolCall: (data: ToolCallEvent) => void;
    toolResult: (data: ToolResultEvent) => void;
    error: (data: ErrorEvent) => void;
    loopEnd: (data: LoopEndEvent) => void;
  } | null = null;

  constructor(options: StreamRendererOptions = {}) {
    this.options = {
      showTokenStream: options.showTokenStream ?? true,
      showToolCalls: options.showToolCalls ?? true,
      showThinking: options.showThinking ?? false,
      write: options.write ?? ((text: string) => process.stdout.write(text)),
    };

    this.markdownRenderer = new MarkdownStreamRenderer();
    this.codeHighlighter = new CodeHighlighter();
    this.toolPanel = new ToolStatusPanel(this.options.write);
  }

  attach(bus: StreamEventBus): void {
    if (this.isAttached) return;
    this.isAttached = true;
    this.bus = bus;

    this.handlers = {
      streamEvent: (event) => this.handleStreamEvent(event),
      assistantMessage: (msg) => this.handleAssistantMessage(msg),
      toolCall: (data) => this.handleToolCall(data),
      toolResult: (data) => this.handleToolResult(data),
      error: (data) => this.handleError(data),
      loopEnd: (data) => this.handleLoopEnd(data),
    };

    bus.onStreamEvent(this.handlers.streamEvent);
    bus.onAssistantMessage(this.handlers.assistantMessage);
    bus.onToolCall(this.handlers.toolCall);
    bus.onToolResult(this.handlers.toolResult);
    bus.onError(this.handlers.error);
    bus.onLoopEnd(this.handlers.loopEnd);
  }

  detach(): void {
    if (!this.isAttached || !this.bus || !this.handlers) return;

    this.bus.offStreamEvent(this.handlers.streamEvent);
    this.bus.offAssistantMessage(this.handlers.assistantMessage);
    this.bus.offToolCall(this.handlers.toolCall);
    this.bus.offToolResult(this.handlers.toolResult);
    this.bus.offError(this.handlers.error);
    this.bus.offLoopEnd(this.handlers.loopEnd);

    this.bus = null;
    this.handlers = null;
    this.isAttached = false;
  }

  private handleStreamEvent(event: StreamEvent): void {
    if (!this.options.showTokenStream) return;

    if (event.type === 'content_block_delta') {
      // Thinking 块处理
      if (event.deltaType === 'thinking') {
        if (this.options.showThinking) {
          if (this.thinkingBuffer === '') {
            this.thinkingStartTime = Date.now();
            this.options.write(`\n${ANSI.cyan}┌─ Thinking ${'─'.repeat(46)}┐${ANSI.reset}\n`);
          }
          this.thinkingBuffer += event.content;
          this.options.write(`${ANSI.gray}${event.content}${ANSI.reset}`);
        }
        return;
      }

      // 代码块处理
      if (this.isInCodeBlock) {
        // 仅匹配行首的 ```（可能跨 token 拆分）
        const closeMatch = event.content.match(/^`{3}\s*$/m) || event.content.match(/\n`{3}\s*$/);
        if (closeMatch) {
          const highlighted = this.codeHighlighter.highlight(this.codeBlockBuffer, this.codeBlockLanguage);
          this.options.write(highlighted + '\n');
          this.options.write(`${ANSI.cyan}\`\`\`${ANSI.reset}\n`);
          this.isInCodeBlock = false;
          this.codeBlockBuffer = '';
          this.codeBlockLanguage = '';
        } else {
          this.codeBlockBuffer += event.content;
        }
        return;
      }

      // 检测代码块开始：``` 必须在行首
      if (event.deltaType === 'text') {
        const openMatch = event.content.match(/^`{3}(\w*)/m);
        if (openMatch) {
          this.isInCodeBlock = true;
          this.codeBlockLanguage = openMatch[1] ?? '';
          this.options.write(`${ANSI.cyan}\`\`\`${this.codeBlockLanguage}${ANSI.reset}\n`);
          return;
        }
      }

      // 普通文本：用 Markdown 渲染
      if (event.deltaType === 'text') {
        const rendered = this.markdownRenderer.renderToken(event.content);
        this.options.write(rendered);
      }
    }

    // 内容块结束
    if (event.type === 'content_block_stop') {
      // 结束 Thinking 块
      if (this.thinkingBuffer) {
        const duration = ((Date.now() - this.thinkingStartTime) / 1000).toFixed(1);
        this.options.write(`\n${ANSI.cyan}└─ (${duration}s) ${'─'.repeat(40)}┘${ANSI.reset}\n\n`);
        this.thinkingBuffer = '';
      }

      // 结束代码块（如果还在）
      if (this.isInCodeBlock) {
        const highlighted = this.codeHighlighter.highlight(this.codeBlockBuffer, this.codeBlockLanguage);
        this.options.write(highlighted + '\n');
        this.options.write(`${ANSI.cyan}\`\`\`${ANSI.reset}\n`);
        this.isInCodeBlock = false;
        this.codeBlockBuffer = '';
      }

      this.markdownRenderer.reset();
    }
  }

  private handleAssistantMessage(msg: AssistantMessage): void {
    if (!this.options.showTokenStream) {
      for (const block of msg.content) {
        this.renderContentBlock(block);
      }
    }
  }

  private renderContentBlock(block: ContentBlock): void {
    if (block.type === 'text' && 'text' in block) {
      const rendered = this.markdownRenderer.renderToken(block.text);
      this.options.write(rendered + '\n');
    }
  }

  private handleToolCall(data: ToolCallEvent): void {
    if (!this.options.showToolCalls) return;
    const inputStr = JSON.stringify(data.input);
    this.toolPanel.start(data.name, inputStr);
  }

  private handleToolResult(data: ToolResultEvent): void {
    if (!this.options.showToolCalls) return;
    const isError = data.output.includes('[Tool Error]');

    if (isError) {
      this.toolPanel.fail(data.output, data.duration);
    } else {
      this.toolPanel.complete(data.output, data.duration);
    }
  }

  private handleError(data: ErrorEvent): void {
    this.options.write(`\n${ANSI.red}❌ [${data.errorType}] ${data.message}${ANSI.reset}\n`);
    if (data.recoverable) {
      this.options.write(`${ANSI.gray}   (recoverable, retrying...)${ANSI.reset}\n`);
    }
  }

  private handleLoopEnd(data: LoopEndEvent): void {
    this.options.write(`\n${ANSI.cyan}--- Done (${data.reason}) ---${ANSI.reset}\n`);
  }
}
