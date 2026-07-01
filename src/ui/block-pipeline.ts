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

import type { Block, FormattedLine, UIMessageStyle } from './types.js';
import { INDENT, BLOCK_STYLES, buildToolResultBlock, summarizeOutput } from './block-format.js';
import { MessageFormatter } from './message-formatter.js';
import { ExpandableBlockStore } from './expandable-store.js';
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
  /** 封口流式（插分隔符，不强制 flushNow）——比 finalizeStreaming 温和 */
  sealStreaming(): void;
  flushNow(): void;
  clearMessages(): void;
}

/** assistant 流式块的固定格式契约（hanging indent：● 第0列 + 续行 INDENT.nested 空格） */
const ASSISTANT_FORMAT = {
  indent: INDENT.nested,
  firstLinePrefix: '● ',
  firstLineStyle: { fg: 'magenta' } as Style,
};

/** tool_result 预览的最大行数（与 message-formatter 的 OUTPUT_PREVIEW_LINES 一致） */
const RESULT_PREVIEW_LINES = 4;

/** 快照条目：记录已渲染块的信息，用于 redraw 重放 */
interface SnapshotEntry {
  /** 该块的渲染方式 */
  render: () => void;
}

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
  /** tool_call → tool_result 的 input 缓存（按 name 匹配，算 diff 用） */
  private pendingToolInputs = new Map<string, Record<string, unknown>>();
  /** thinking 文本累积（供 ctrl+o 展开用） */
  private thinkingBuffer = '';
  /** 可折叠块存储（thinking + tool_result 的 summary/full + expanded 状态） */
  private expandable = new ExpandableBlockStore();
  /** 当前 turn 的渲染快照（用于 redraw 重放） */
  private turnSnapshot: SnapshotEntry[] = [];
  /** 块 id 计数器（生成唯一 id） */
  private idCounter = 0;

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
        this.snapshot(() => this.print(MessageFormatter.format('input', {}, block.text)));
        this.print(MessageFormatter.format('input', {}, block.text));
        break;

      case 'thinking_start':
        // 第一个模型块：强制加空行（前面总有 banner/用户输入等非模型内容）
        this.openModelBlock();
        this.thinkingActive = true;
        this.snapshot(() => this.print(MessageFormatter.format('thinking')));
        this.print(MessageFormatter.format('thinking'));
        break;

      case 'thinking_delta':
        // 累积 thinking 文本（供 ctrl+o 展开），不实时渲染（折叠模式）
        this.thinkingBuffer += block.content;
        break;

      case 'thinking_end': {
        // thinking 摘要行（2 空格缩进烤进 content，dim 样式）
        if (this.thinkingActive) {
          const summaryLines = MessageFormatter.format('thinking_end', {
            duration: block.durationSec,
            filesRead: block.filesRead,
          });
          // 注册可折叠块：summary=摘要行，full=完整思考文本（按行拆分 + dim 缩进）
          const id = `thinking-${++this.idCounter}`;
          const fullLines = this.thinkingBuffer
            ? this.thinkingBuffer.split('\n').map(l => ({
                content: `  ${l}`,
                style: BLOCK_STYLES.dim,
                indent: INDENT.nested,
              }))
            : summaryLines; // 无思考内容时 full = summary
          this.expandable.add({ id, kind: 'thinking', summaryLines, fullLines });
          // 快照：redraw 时按 expanded 选 summary/full
          this.snapshot(() => this.print(this.expandable.getLines(id)));
          this.print(summaryLines);
        }
        this.thinkingBuffer = '';
        this.thinkingActive = false;
        break;
      }

      case 'assistant_text': {
        // assistant 流式块：首次输出前插块间空行（仅一次）
        if (!this.assistantGapApplied) {
          this.openModelBlock();
          this.assistantGapApplied = true;
        }
        this.renderer.appendStreamingMarkdown(block.text, block.isFinal, ASSISTANT_FORMAT);
        if (block.isFinal) {
          // 封口（插分隔符防覆盖），但不强制 flushNow——减少渲染竞态
          this.renderer.sealStreaming();
          this.hasContent = true;
          this.assistantGapApplied = false; // 下一个 assistant 块重新加空行
          // 快照：redraw 时重发最终文本（isFinal=true 会重新走流式渲染 + 封口）
          const finalText = block.text;
          this.snapshot(() => this.renderer.appendStreamingMarkdown(finalText, true, ASSISTANT_FORMAT));
        }
        break;
      }

      case 'tool_call':
        this.openModelBlock();
        // 缓存 input 供后续 tool_result 计算 diff（按 name 匹配；
        // 写工具串行执行，安全。读工具不读 input，不受影响。）
        this.pendingToolInputs.set(block.name, block.input);
        this.snapshot(() => this.print(MessageFormatter.format('tool_call', {
          toolName: block.name,
          toolInput: block.input,
        })));
        this.print(MessageFormatter.format('tool_call', {
          toolName: block.name,
          toolInput: block.input,
        }));
        break;

      case 'tool_result': {
        // tool_result 续接 tool_call，不单独开新块（不加空行）
        // input 优先用 Block 自带的，否则从 tool_call 缓存按 name 取回
        const input = block.input ?? this.pendingToolInputs.get(block.name);
        this.pendingToolInputs.delete(block.name);
        const meta = buildToolResultBlock(block.name, input, block.output);
        const summaryLines = MessageFormatter.format('tool_result', meta);

        // 若输出被截断（有 rawOutput 且超预览行数），注册可折叠块
        if (meta.rawOutput !== undefined && meta.rawOutput !== '') {
          const { totalLines, truncated } = summarizeOutput(meta.rawOutput, RESULT_PREVIEW_LINES);
          if (truncated) {
            const id = `tool-${++this.idCounter}`;
            // fullLines：完整输出按行，首行带 ⎿，续行 3 空格
            const fullLines = meta.rawOutput.split('\n').map((l, i) => ({
              content: `${i === 0 ? '⎿  ' : '   '}${l}`,
              style: BLOCK_STYLES.dim,
              indent: INDENT.nested,
            }));
            this.expandable.add({ id, kind: 'tool_result', summaryLines, fullLines });
            this.snapshot(() => this.print(this.expandable.getLines(id)));
            this.print(summaryLines);
            this.hasContent = true;
            break;
          }
        }
        // 未截断：直接渲染，不需注册（无可展开内容）
        this.snapshot(() => this.print(summaryLines));
        this.print(summaryLines);
        this.hasContent = true;
        break;
      }

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

  /**
   * 第一个模型内容块（thinking_start / assistant_text / tool_call）：
   * 强制加空行分隔，因为前面总有非模型内容（banner / 用户输入）。
   * 后续模型块走普通 openBlock（仅在模型内容流内部加间隔）。
   */
  private openModelBlock(): void {
    if (!this.hasContent) {
      // 第一个模型块：强制加空行（即便 pipeline.hasContent=false，
      // 因为 UILayout 侧已有 banner/用户输入）
      this.renderer.printMessage('', 'system');
    } else {
      this.ensureGap();
    }
    this.hasContent = true;
  }

  private ensureGap(): void {
    if (this.hasContent) {
      this.renderer.printMessage('', 'system');
    }
  }

  /** 记录一个块的渲染闭包到快照（供 redraw 重放） */
  private snapshot(render: () => void): void {
    this.turnSnapshot.push({ render });
  }

  /**
   * ctrl+o：切换最后一个可折叠块的展开态。
   * 返回 true 表示有变化（调用方应 redraw）。
   */
  toggleLastExpandable(): boolean {
    return this.expandable.toggleLast();
  }

  /**
   * 重绘：clearMessages + 按当前快照重放所有块。
   * 可折叠块按 expanded 状态选 summary/full 行。
   * 注意：clearMessages 会清屏，之前的 scrollback 丢失（toggle 的已知代价）。
   */
  redraw(): void {
    this.renderer.clearMessages();
    this.hasContent = false;
    this.assistantGapApplied = true; // redraw 内部不重复加 assistant gap
    for (const entry of this.turnSnapshot) {
      entry.render();
    }
    this.renderer.flushNow();
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

  /** 清空（新 turn 开始时） */
  clear(): void {
    this.hasContent = false;
    this.assistantGapApplied = false;
    this.thinkingActive = false;
    this.thinkingBuffer = '';
    this.pendingToolInputs.clear();
    this.expandable.clear();
    this.turnSnapshot = [];
    this.renderer.clearMessages();
  }

  /**
   * 仅重置 turn 状态（可折叠块存储 + 快照），不清屏。
   * 新 turn 开始时调用——上一 turn 的展开状态/快照不再需要，
   * 但屏幕上的历史消息保留（不清屏）。
   */
  clearTurnState(): void {
    this.thinkingBuffer = '';
    this.pendingToolInputs.clear();
    this.expandable.clear();
    this.turnSnapshot = [];
    // hasContent 保持 true（屏幕上仍有历史内容，新块前要加空行）
  }
}
