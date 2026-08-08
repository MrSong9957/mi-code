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
// - pipeline 直接调 Renderer 语义原语（startToolCall / finishToolCall / appendStreamingMarkdown），
//   不经过 UILayout 的 send（避免重复套 gap/format 逻辑）

import type { Block, FormattedLine, UIMessageStyle } from './types.js';
import { INDENT, BLOCK_STYLES } from './block-format.js';
import { ExpandableBlockStore } from './expandable-store.js';
import { buildAskBlock } from './ask-user-presentation.js';
import { buildToolPresentation } from './tool-presentation.js';
import type { Translator } from '../locale/types.js';
import type {
  AskBlock,
  ToolPresentation,
} from '../tui/transcript-types.js';
import type { BoundaryBlock, ThinkingSummaryBlock } from '../tui/state/transcript-reducer.js';

/**
 * PipelineRenderer:pipeline 依赖的下游语义投递接口。
 *
 * 这是「配对后的语义数据 → store」的边界。adapter 把这些调用翻译成
 * transcript-reducer 的状态转移。pipeline 不再传 FormattedLine[],
 * 而是传 ToolPresentation / AskBlock 等语义对象。
 */
export interface PipelineRenderer {
  // ── 工具(语义) ──
  startToolCall(call: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  }): void;
  finishToolCall(toolUseId: string, presentation: ToolPresentation): boolean;
  finishAsk?(toolUseId: string, block: AskBlock): boolean;
  closeOpenToolGroup?(): void;

  // ── assistant 流式(语义) ──
  appendStreamingMarkdown(
    text: string,
    isFinal: boolean,
    opts?: { indent?: number; firstLinePrefix?: string; firstLineStyle?: UIMessageStyle },
  ): void;
  sealStreaming(): void;

  // ── thinking 流式(语义) ──
  startThinking(text: string): string;
  updateThinking(text: string): void;
  eraseThinking(): void;
  finishThinking(summary: ThinkingSummaryBlock): void;

  // ── 通用 transcript 追加 ──
  appendTranscriptBlock(block: BoundaryBlock): void;

  // ── 控制 ──
  flushNow(): void;
  clearMessages(): void;
}

/** assistant 流式块的固定格式契约（hanging indent：● 第0列 + 续行 INDENT.nested 空格） */
const ASSISTANT_FORMAT = {
  // assistant 文本块首行顶格（与 ● Thinking… 对齐），不缩进。
  // nested(2) 缩进只用于 ⎿ 工具结果行，不用于 assistant 正文。
  indent: INDENT.block,
  firstLinePrefix: '● ',
  firstLineStyle: { fg: 'brand' } as UIMessageStyle,
};

/**
 * 工具块缓冲项:一个 tool_call 等待它的 result 的"配对货架格子"。
 *
 * call 进缓冲区时只存身份(name/input/toolUseId);result 到达时配对,
 * 调 buildToolPresentation 构建语义展示,再通过 renderer.finishToolCall 投递。
 */
interface BufferedTool {
  /** 唯一键:tool_use id(无 id 时生成临时 id) */
  toolUseId: string;
  /** 工具名 */
  name: string;
  /** 原始 input */
  input: Record<string, unknown>;
  /** 是否已配对 result(防重复配对) */
  resolved?: boolean;
}

/**
 * BlockPipeline:唯一输出管道。
 *
 * 集中管理:
 * - hasContent:是否已有内容(决定块间空行)
 * - thinkingPhase:thinking 块生命周期状态机
 * - toolBuffer:tool_call → tool_result 配对缓冲
 * - 所有语义投递通过 renderer 的语义方法完成
 */
/**
 * thinking 协议生命周期状态机(两态)。
 *
 * - idle:无 thinking block 进行中。不变量:buffer 为空,无临时闪烁行。
 * - active:thinking block 已开始。不变量:已显示临时行,允许累积 delta 到 buffer。
 */
type ThinkingPhase = 'idle' | 'active';

export class BlockPipeline {
  private renderer: PipelineRenderer;
  private translator: Translator;
  private hasContent = false;
  private thinkingPhase: ThinkingPhase = 'idle';
  /**
   * 工具块缓冲区:tool_call 进缓冲区等 result,配对后投递语义展示。
   * streaming-query 阶段 1 背靠背 emit 所有 call,阶段 3 才 emit result。
   * 缓冲吸收这个时序,等配对再投递。
   */
  private toolBuffer: BufferedTool[] = [];
  /** thinking 文本只在内存中累积,供 ctrl+o 展开。 */
  private thinkingBuffer = '';
  /** 可折叠块存储(thinking + tool_result 的 summary/full)——ctrl+o 用 */
  private expandable = new ExpandableBlockStore();
  /** 块 id 计数器(生成唯一 id) */
  private idCounter = 0;

  constructor(renderer: PipelineRenderer, translator: Translator) {
    this.renderer = renderer;
    this.translator = translator;
  }

  /**
   * 投入一个块。按 kind 路由到语义 renderer 操作。
   */
  emit(block: Block): void {
    switch (block.kind) {
      case 'user_input': {
        this.renderer.appendTranscriptBlock({
          id: `user-${++this.idCounter}`,
          kind: 'user',
          text: block.text,
        });
        this.hasContent = true;
        break;
      }

      case 'thinking_start': {
        // 重复 start 幂等:不清空 buffer,不重置,不二次显示。
        if (this.thinkingPhase === 'active') break;
        this.thinkingPhase = 'active';
        this.thinkingBuffer = '';
        this.renderer.startThinking('Thinking…');
        break;
      }

      case 'thinking_delta': {
        // 只在 active 态累积 buffer(供 Ctrl+O 展开)。idle 时忽略。
        if (this.thinkingPhase !== 'active') break;
        this.thinkingBuffer += block.content;
        break;
      }

      case 'thinking_end': {
        // active 态才产生摘要;idle 时(end 无 start)完全无害,只确保回到 idle。
        if (this.thinkingPhase === 'active') {
          const summaryText = `Thought for ${block.durationSec}s`;
          // 注册可折叠块:summary=摘要行,full=完整思考文本或 placeholder。
          const id = `thinking-${++this.idCounter}`;
          const fullLines = this.buildThinkingFullLines();
          const summaryLines: FormattedLine[] = [{
            content: summaryText,
            style: BLOCK_STYLES.dim,
            indent: INDENT.nested,
          }];
          this.expandable.add({ id, kind: 'thinking', summaryLines, fullLines });
          // 擦除临时行,defer thinking-summary SystemBlock。
          this.renderer.eraseThinking();
          this.renderer.finishThinking({
            id,
            kind: 'system',
            subkind: 'thinking-summary',
            text: summaryText,
            durationMs: block.durationSec * 1000,
            expandableId: id,
            groupBoundary: 'transparent',
          });
        }
        this.thinkingPhase = 'idle';
        this.thinkingBuffer = '';
        break;
      }

      case 'assistant_text': {
        // assistant 流式:通过 appendStreamingMarkdown 驱动(它内部走 start/update/finish)。
        this.renderer.appendStreamingMarkdown(block.text, block.isFinal, ASSISTANT_FORMAT);
        if (block.isFinal) {
          this.renderer.sealStreaming();
          this.hasContent = true;
        }
        break;
      }

      case 'tool_call': {
        // 进缓冲区等 result。立即调 startToolCall 让 reducer 建 PendingTool。
        const toolUseId = block.toolUseId ?? `auto-${this.idCounter++}-${block.name}`;
        this.renderer.startToolCall({
          toolUseId,
          name: block.name,
          input: block.input,
        });
        this.toolBuffer.push({
          toolUseId,
          name: block.name,
          input: block.input,
        });
        this.hasContent = true;
        break;
      }

      case 'tool_result': {
        // 配对:从缓冲区找到这个 result 对应的 call 项。
        let idx = -1;
        if (block.toolUseId) {
          idx = this.toolBuffer.findIndex(t => t.toolUseId === block.toolUseId);
        } else {
          idx = this.toolBuffer.findIndex(t => !t.resolved);
        }
        if (idx < 0) {
          // 兜底:没找到对应 call,直接构建展示投递(不丢失 result)。
          this.renderer.startToolCall({
            toolUseId: `orphan-${++this.idCounter}`,
            name: block.name,
            input: block.input ?? {},
          });
          const presentation = this.buildPresentationSafely(
            `orphan-${this.idCounter}`,
            block.name,
            block.input ?? {},
            block.output,
            block.durationMs,
          );
          this.renderer.finishToolCall(`orphan-${this.idCounter}`, presentation);
          this.hasContent = true;
          break;
        }

        const item = this.toolBuffer[idx]!;
        item.resolved = true;
        const input = block.input ?? item.input;
        const toolUseId = item.toolUseId;

        // ask_user_question + structuredOutcome → 独立 AskBlock 路径(Task 5)。
        // 不走通用 tool presentation;用 buildAskBlock 构造 AskBlock,通过 finishAsk 投递。
        // 缺失/畸形 structuredOutcome → null,fall through 到通用 tool presentation。
        if (item.name === 'ask_user_question' && block.structuredOutcome) {
          const askBlock = buildAskBlock(toolUseId, block.structuredOutcome);
          if (askBlock && this.renderer.finishAsk) {
            this.renderer.finishAsk(toolUseId, askBlock);
            this.toolBuffer.splice(idx, 1);
            this.hasContent = true;
            break;
          }
        }

        // 通用路径:spawn_agent 由 buildToolPresentation 内部复用 buildSubagentCompletionPresentation。
        const presentation = this.buildPresentationSafely(
          toolUseId,
          item.name,
          input,
          block.output,
          block.durationMs,
        );

        // 注册可折叠块(截断的 raw output)。
        if (block.output && block.output.length > 500) {
          const expId = `tool-${++this.idCounter}`;
          const fullLines = block.output.split('\n').map((l, i) => ({
            content: `${i === 0 ? '⎿  ' : '   '}${l}`,
            style: BLOCK_STYLES.dim,
            indent: INDENT.nested,
            raw: true,
          }));
          this.expandable.add({
            id: expId,
            kind: 'tool_result',
            summaryLines: [],
            fullLines,
          });
        }

        this.renderer.finishToolCall(toolUseId, presentation);
        this.toolBuffer.splice(idx, 1);
        this.hasContent = true;
        break;
      }

      case 'hook': {
        // PostToolUse hook 日志:作为 system notification 追加。
        // (Task 4 过渡:hook 暂时作为 system notification 投递。)
        this.renderer.appendTranscriptBlock({
          id: `hook-${++this.idCounter}`,
          kind: 'system',
          subkind: 'notification',
          text: block.text,
          groupBoundary: 'break',
        });
        break;
      }

      default: {
        const _exhaustive: never = block;
        void _exhaustive;
      }
    }
  }

  /**
   * 安全构建 ToolPresentation:构建失败时走 generic fallback,不抛穿 UI 事件循环。
   */
  private buildPresentationSafely(
    toolUseId: string,
    name: string,
    input: Record<string, unknown>,
    output: string,
    durationMs?: number,
  ): ToolPresentation {
    try {
      return buildToolPresentation(
        { toolUseId, toolName: name, input, output, durationMs },
        this.translator,
      );
    } catch (err) {
      if (process.env.DEBUG) {
        console.error('[tool presentation failed]', { toolUseId, err });
      }
      // generic fallback:不分组,安全单行。
      return buildToolPresentation(
        { toolUseId, toolName: 'unknown', input: {}, output },
        this.translator,
      );
    }
  }

  /**
   * ctrl+o 临时 alt screen 覆盖层:取最后一个可折叠块的完整展开内容。
   */
  getLastExpandableFullLines(): { lines: FormattedLine[]; kind: 'thinking' | 'tool_result' } | null {
    const lines = this.expandable.getLastFullLines();
    const kind = this.expandable.getLastKind();
    if (!lines || !kind) return null;
    return { lines, kind };
  }

  /**
   * 构建 thinking 可折叠块的完整展开行。
   */
  private buildThinkingFullLines(): FormattedLine[] {
    const hasContent = this.thinkingBuffer.trim().length > 0;
    if (hasContent) {
      return this.thinkingBuffer.split('\n').map(l => ({
        content: `  ${l}`,
        style: BLOCK_STYLES.dim,
        indent: INDENT.nested,
      }));
    }
    return [{
      content: '  (No thinking content received)',
      style: BLOCK_STYLES.dim,
      indent: INDENT.nested,
      raw: true,
    }];
  }

  /**
   * 重置 thinking 状态。
   */
  private resetThinkingState(eraseIfActive: boolean): void {
    if (eraseIfActive && this.thinkingPhase === 'active') {
      this.renderer.eraseThinking();
    }
    this.thinkingPhase = 'idle';
    this.thinkingBuffer = '';
  }

  /** 提交一帧 */
  commit(): void {
    this.renderer.flushNow();
  }

  /** 清空(新 turn 开始时) */
  clear(): void {
    // 关闭未完成的 open tool group(防丢失)。
    this.renderer.closeOpenToolGroup?.();
    this.toolBuffer = [];
    this.hasContent = false;
    this.resetThinkingState(false);
    this.expandable.clear();
    this.renderer.clearMessages();
  }

  /**
   * 仅重置 turn 状态(可折叠块存储),不清屏。
   */
  clearTurnState(): void {
    this.renderer.closeOpenToolGroup?.();
    this.toolBuffer = [];
    this.resetThinkingState(true);
    this.expandable.clear();
  }
}
