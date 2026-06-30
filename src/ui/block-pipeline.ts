// src/ui/block-pipeline.ts
// 统一输出管道：大模型事件 → 唯一入口 → 终端
//
// 物理本质：排版工厂的「总调度台」。
// 所有要渲染到终端的内容（thinking / assistant / tool / system / error），
// 都先转成 Block 对象，经 emit() 投入这条管道。管道内部统一处理：
//   1. 块间空行（每个新块开始前自动加空行分隔）
//   2. 格式契约（● / ⎿ 前缀、缩进、magenta/dim 样式）
//   3. 下沉到 renderer 实际绘制
//
// 设计原则：
// - emit 即渲染，不引入缓冲/重排（ordering 由上游 streaming-executor 保证 call-order）
// - 格式契约集中在本文件 + block-format，杜绝散落在 formatter/renderer/index.ts
// - pipeline 直接调 Renderer 原语（printMessage / appendStreamingMarkdown），
//   不经过 UILayout 的 send（避免重复套 gap/format 逻辑）

import type { Block, UIMessageStyle } from './types.js';
import { buildToolResultBlock } from './block-format.js';
import { MessageFormatter } from './message-formatter.js';
import type { Style } from '../renderer/cell.js';

/**
 * PipelineRenderer：pipeline 依赖的 Renderer 子集（最小接口，便于 mock）。
 */
export interface PipelineRenderer {
  printMessage(text: string, role?: string, style?: Record<string, unknown>): void;
  appendStreamingMarkdown(
    text: string,
    isFinal: boolean,
    opts?: { indent?: number; firstLinePrefix?: string; firstLineStyle?: Style },
  ): void;
  finalizeStreaming(): void;
  flushNow(): void;
  clearMessages(): void;
}

/** assistant 流式块的固定格式契约（hanging indent：● 第0列 + 续行 2 空格） */
const ASSISTANT_FORMAT = {
  indent: 2,
  firstLinePrefix: '● ',
  firstLineStyle: { fg: 'magenta' } as Style,
};

/**
 * BlockPipeline：唯一输出管道。
 *
 * 集中管理：
 * - hasContent / assistantGapApplied：块间空行状态
 * - thinkingActive：thinking 块是否进行中（决定 thinking_end 是否输出摘要）
 * - 所有 ●/⎿ 前缀、缩进、样式都从这里产出（调 MessageFormatter + block-format）
 */
export class BlockPipeline {
  private renderer: PipelineRenderer;
  private hasContent = false;
  private assistantGapApplied = false;
  private thinkingActive = false;

  constructor(renderer: PipelineRenderer) {
    this.renderer = renderer;
  }

  /**
   * 投入一个块。按 kind 路由，统一处理块间空行 + 格式契约。
   */
  emit(block: Block): void {
    switch (block.kind) {
      case 'user_input':
        this.openBlock();
        this.print(MessageFormatter.format('input', {}, block.text));
        break;

      case 'thinking_start':
        this.openBlock();
        this.thinkingActive = true;
        this.print(MessageFormatter.format('thinking'));
        break;

      case 'thinking_delta':
        // 折叠模式：累积但不渲染（pipeline 不持有 thinking 文本，
        // 由上游 index.ts 累积；这里仅 noop）
        break;

      case 'thinking_end':
        // thinking 摘要行（2 空格缩进烤进 content，dim 样式）
        if (this.thinkingActive) {
          this.print(MessageFormatter.format('thinking_end', {
            duration: block.durationSec,
            filesRead: block.filesRead,
          }));
        }
        this.renderer.finalizeStreaming();
        this.thinkingActive = false;
        break;

      case 'assistant_text': {
        // assistant 流式块：首次输出前插块间空行（仅一次）
        if (!this.assistantGapApplied) {
          this.ensureGap();
          this.assistantGapApplied = true;
        }
        this.renderer.appendStreamingMarkdown(block.text, block.isFinal, ASSISTANT_FORMAT);
        if (block.isFinal) {
          this.renderer.finalizeStreaming();
          this.hasContent = true;
          this.assistantGapApplied = false; // 下一个 assistant 块重新加空行
        }
        break;
      }

      case 'tool_call':
        this.openBlock();
        this.print(MessageFormatter.format('tool_call', {
          toolName: block.name,
          toolInput: block.input,
        }));
        break;

      case 'tool_result': {
        // tool_result 续接 tool_call，不单独开新块（不加空行）
        const meta = buildToolResultBlock(block.name, block.input, block.output);
        this.print(MessageFormatter.format('tool_result', meta));
        this.hasContent = true;
        break;
      }

      case 'system':
        this.openBlock();
        this.print(MessageFormatter.format('system', {}, block.text));
        break;

      case 'error':
        this.openBlock();
        this.print(MessageFormatter.format('error', {}, block.text));
        break;

      default: {
        const _exhaustive: never = block;
        void _exhaustive;
      }
    }
  }

  /**
   * 开新块：若已有内容，先输出空行分隔。首个块不加。
   * 用于 user_input / thinking_start / tool_call / system / error。
   * （tool_result 续接 tool_call，不调用此方法；assistant_text 有自己的 gap 逻辑）
   */
  private openBlock(): void {
    this.ensureGap();
    this.hasContent = true;
  }

  private ensureGap(): void {
    if (this.hasContent) {
      this.renderer.printMessage('', 'system');
    }
  }

  /** 把 FormattedLine[] 下沉到 renderer（带样式） */
  private print(lines: { content: string; style: UIMessageStyle }[]): void {
    for (const line of lines) {
      this.renderer.printMessage(line.content, 'system', line.style as Record<string, unknown>);
    }
  }

  /** 提交一帧 */
  commit(): void {
    this.renderer.flushNow();
  }

  /** 清空 */
  clear(): void {
    this.hasContent = false;
    this.assistantGapApplied = false;
    this.thinkingActive = false;
    this.renderer.clearMessages();
  }
}
