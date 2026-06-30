// src/ui/ui-layout.ts
// UI 布局管理器（主入口）
//
// 物理本质：排版工厂的总管。
// 接收消息 → 格式化 → 分区 → 布局 → 帧缓冲 → 终端。

import { MessageFormatter } from './message-formatter.js';
import { ContentRegion } from './content-region.js';
import { Renderer } from '../renderer/renderer.js';
import type { UIMessageType, UIMessageMeta, Writer } from './types.js';
import type { StatusBarState, ToolStatus } from '../renderer/status-bar.js';

export interface UILayoutOptions {
  rows: number;
  cols: number;
  writer: Writer;
  status: Pick<StatusBarState, 'model' | 'branch' | 'dir' | 'mode' | 'contextUsage'>;
  prompt?: string;
}

export class UILayout {
  private renderer: Renderer;
  private region: ContentRegion;
  private streamingContent: string = '';
  private streamingType: 'thinking' | 'assistant' | null = null;

  constructor(options: UILayoutOptions) {
    this.renderer = new Renderer({
      rows: options.rows,
      cols: options.cols,
      writer: options.writer,
      status: options.status,
      prompt: options.prompt,
    });
    this.region = new ContentRegion();
  }

  /**
   * 发送消息（自动格式化 + 路由）
   *
   * 物理本质：排版工人接收快递，贴标签，放到正确的传送带。
   */
  send(type: UIMessageType, content?: string, meta?: UIMessageMeta): void {
    // 如果有流式内容且不是 thinking_content，先固化
    if (this.streamingContent && type !== 'thinking_content') {
      this.finalizeStreaming();
    }

    // 格式化
    const lines = MessageFormatter.format(type, meta ?? {}, content);

    // 路由到对应区域
    for (const line of lines) {
      this.region.addLine(type, line);
    }

    // 通过 renderer 输出
    for (const line of lines) {
      this.renderer.printMessage(line.content, 'system', line.style);
    }
  }

  /**
   * 流式更新（thinking/assistant）
   *
   * 物理本质：实时接收流式内容，累积到缓冲区。
   */
  appendStreaming(type: 'thinking_content' | 'assistant', content: string): void {
    if (type === 'thinking_content') {
      // thinking 内容：累积到流式缓冲区
      this.streamingContent += content;
      this.streamingType = 'thinking';

      // 格式化并输出
      const lines = MessageFormatter.format('thinking_content', {}, content);
      for (const line of lines) {
        this.renderer.printMessage(line.content, 'system', line.style);
      }
    } else if (type === 'assistant') {
      // assistant 内容：累积到流式缓冲区
      this.streamingContent += content;
      this.streamingType = 'assistant';
    }
  }

  /**
   * 流式 Markdown 渲染（assistant 文本）
   *
   * 物理本质：累积文本经 Markdown 渲染器转成带样式的 cells，替换当前 assistant 消息。
   * isFinal=true 时封口（固化进 scrollback）。
   */
  appendStreamingMarkdown(text: string, isFinal: boolean): void {
    this.renderer.appendStreamingMarkdown(text, isFinal);
    if (isFinal) {
      this.streamingContent = '';
      this.streamingType = null;
    }
  }

  /**
   * 固化流式内容
   *
   * 物理本质：流式内容接收完毕，固化到消息区。
   */
  finalizeStreaming(duration?: number, filesRead?: number): void {
    if (this.streamingType === 'thinking' && duration !== undefined) {
      // thinking 结束：输出 Thought for Ns
      const lines = MessageFormatter.format('thinking_end', { duration, filesRead });
      for (const line of lines) {
        this.renderer.printMessage(line.content, 'system', line.style);
      }
    }

    // 清空流式缓冲区
    this.streamingContent = '';
    this.streamingType = null;
  }

  /**
   * 更新输入框
   */
  setInput(text: string, cursorPos: number): void {
    this.renderer.setInput(text, cursorPos);
  }

  /**
   * 更新状态栏
   */
  setStatus(_status: Partial<StatusBarState>): void {
    // 状态栏由构造时的 status 信息驱动，暂不支持运行时更新
  }

  /**
   * 设置工具状态
   */
  setToolStatus(name: string, status: ToolStatus['status']): void {
    this.renderer.setToolStatus(name, status);
  }

  /**
   * 清空工具状态
   */
  clearToolStatus(): void {
    this.renderer.clearToolStatus();
  }

  /**
   * 设置提示
   */
  setHint(hint: string | undefined): void {
    this.renderer.setHint(hint);
  }

  /**
   * 获取提示符
   */
  getPrompt(): string {
    return this.renderer.getPrompt();
  }

  /**
   * 提交一帧
   */
  commit(): void {
    this.renderer.flushNow();
  }

  /**
   * 清空所有内容
   */
  clear(): void {
    this.region.clear();
    this.streamingContent = '';
    this.streamingType = null;
    this.renderer.clearMessages();
  }

  /**
   * 进入渲染模式
   */
  enter(): void {
    this.renderer.enter();
  }

  /**
   * 退出渲染模式
   */
  exit(): void {
    this.renderer.exit();
  }

  /**
   * 更新终端尺寸
   */
  resize(rows: number, cols: number): void {
    this.renderer.resize(rows, cols);
  }
}
