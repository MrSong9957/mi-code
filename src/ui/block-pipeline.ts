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

import type { Block } from './types.js';
import { buildToolResultBlock } from './block-format.js';

/**
 * UILayout 的最小接口（pipeline 依赖的子集）。
 * 让 pipeline 不直接 new Renderer，而是接收一个已配置好的 layout，
 * 便于测试 mock，也便于未来替换底层渲染器。
 */
export interface PipelineLayout {
  send(type: string, content?: string, meta?: Record<string, unknown>): void;
  appendStreaming(type: 'thinking_content' | 'assistant', content: string): void;
  appendStreamingMarkdown(text: string, isFinal: boolean): void;
  finalizeStreaming(duration?: number, filesRead?: number): void;
  clear(): void;
  commit(): void;
}

/**
 * BlockPipeline：唯一输出管道。
 *
 * 当前实现（Step 2）：纯转发到 PipelineLayout，不做格式集中化。
 * 后续步骤会逐步把块间空行、前缀/缩进逻辑接管到这里。
 */
export class BlockPipeline {
  private layout: PipelineLayout;

  constructor(layout: PipelineLayout) {
    this.layout = layout;
  }

  /**
   * 投入一个块。按 kind 路由到对应的渲染调用。
   */
  emit(block: Block): void {
    switch (block.kind) {
      case 'user_input':
        this.layout.send('input', block.text);
        break;

      case 'thinking_start':
        this.layout.send('thinking');
        break;

      case 'thinking_delta':
        // 折叠模式：累积但不渲染
        this.layout.appendStreaming('thinking_content', block.content);
        break;

      case 'thinking_end':
        this.layout.finalizeStreaming(block.durationSec, block.filesRead);
        break;

      case 'assistant_text':
        this.layout.appendStreamingMarkdown(block.text, block.isFinal);
        break;

      case 'tool_call':
        this.layout.send('tool_call', '', { toolName: block.name, toolInput: block.input });
        break;

      case 'tool_result': {
        // 委托 block-format 计算摘要 meta（行数 / 原始输出）
        const meta = buildToolResultBlock(block.name, block.input, block.output);
        this.layout.send('tool_result', '', meta as Record<string, unknown>);
        break;
      }

      case 'system':
        this.layout.send('system', block.text);
        break;

      case 'error':
        this.layout.send('error', block.text);
        break;

      default: {
        // 穷尽性检查（编译期保证所有 kind 都处理）
        const _exhaustive: never = block;
        void _exhaustive;
      }
    }
  }

  /** 提交一帧（透传） */
  commit(): void {
    this.layout.commit();
  }

  /** 清空（透传） */
  clear(): void {
    this.layout.clear();
  }
}
