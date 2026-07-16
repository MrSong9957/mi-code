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

/**
 * PipelineRenderer：pipeline 依赖的下游渲染/投递接口（最小接口，便于 mock）。
 *
 * 注意：这是「格式化数据 → 渲染目标」的边界。旧实现是手写 ANSI Renderer；
 * Ink 重构后由 store adapter 实现同一接口（把 FormattedLine 推进 zustand store）。
 * 样式用语义 token（UIMessageStyle：fg=brand/success/error、dim、bold…），
 * 由渲染侧映射到具体着色（旧 Renderer 的 theme / Ink 的 <Text color>）。
 */
export interface PipelineRenderer {
  printMessage(text: string, role?: string, style?: Record<string, unknown>, raw?: boolean): void;
  appendStreamingMarkdown(
    text: string,
    isFinal: boolean,
    opts?: { indent?: number; firstLinePrefix?: string; firstLineStyle?: UIMessageStyle },
  ): void;
  /** 流式 thinking 文本（灰色 dim，实时显示思考过程） */
  appendStreamingThinking(text: string): void;
  /** 擦除 thinking 流式草稿区（折叠为摘要行时调用） */
  eraseStreamingThinking(): void;
  /** 封口流式（插分隔符，不强制 flushNow）——比 finalizeStreaming 温和 */
  sealStreaming(): void;
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

/** tool_result 预览的最大行数（与 message-formatter 的 OUTPUT_PREVIEW_LINES 一致） */
const RESULT_PREVIEW_LINES = 4;

/**
 * 工具块缓冲项：一个 tool_call 等待它的 result（+ hook）的"配对货架格子"。
 *
 * call 进缓冲区时填 callLines；result 到达时填 resultLines + 注册可折叠块，
 * 然后立即 flush 该项（call→result→hook 成对 print）。
 */
interface BufferedTool {
  /** 唯一键：tool_use id（无 id 时生成临时 id） */
  toolUseId: string;
  /** 工具名（用于无 id 时按 name 回退匹配） */
  name: string;
  /** 原始 input（result 到达时算 diff 用） */
  input: Record<string, unknown>;
  /** call 行（已格式化，待 print） */
  callLines: FormattedLine[];
  /** result 行（到齐后填；undefined 表示 result 尚未到达） */
  resultLines?: FormattedLine[];
  /** ctrl+o 可折叠块的完整展开行（result 被截断时才有） */
  expandableFullLines?: FormattedLine[];
  /** 可折叠块 id（注册用，截断时才有） */
  expandableId?: string;
  /** 可折叠块 kind（'tool_result'） */
  hasExpandable?: boolean;
  /** hook 行（PostToolUse 日志，跟在 result 后） */
  hookLines?: FormattedLine[];
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
  /**
   * 工具块缓冲区（方案 C：视觉位置修复）。
   *
   * 物理本质：快递中转站的"配对货架"。
   * tool_call 进来时把包裹（call 行）放上货架等它的回执（result）；
   * tool_result 到达时凭 toolUseId 找到对应包裹，**成对出货**——
   * call 行紧跟其 result 行，不让 result 跑到别人 call 下面。
   *
   * 为什么需要缓冲：streaming-query 阶段 1 在同一 microtask 背靠背 emit 完所有 call，
   * 阶段 3 才 emit result。若 emit 即落屏，5 个 call 已经印上屏幕，
   * result 来的时候只能追加屏幕底部——视觉脱节。
   * 缓冲吸收这个时序，等配对再 flush，保证 call→result→call→result 交替。
   */
  private toolBuffer: BufferedTool[] = [];
  /** thinking 文本累积（供 ctrl+o 展开用） */
  private thinkingBuffer = '';
  /** 可折叠块存储（thinking + tool_result 的 summary/full）——ctrl+o 临时 alt screen 覆盖层渲染用 */
  private expandable = new ExpandableBlockStore();
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
        this.print(MessageFormatter.format('input', {}, block.text), 'user');
        break;

      case 'thinking_start':
        // thinking 进行时不在消息区显示占位行——对标 Claude Code：
        // thinking 状态在 spinner 行尾部显示 (thinking)，消息区不占位。
        this.openModelBlock();
        this.thinkingActive = true;
        break;

      case 'thinking_delta':
        // 累积 thinking 文本 + 流式渲染（灰色 dim，实时显示思考过程）
        this.thinkingBuffer += block.content;
        this.renderer.appendStreamingThinking(this.thinkingBuffer);
        break;

      case 'thinking_end': {
        // thinking 结束：擦除流式草稿 → 注册可折叠块 → 打印摘要行（折叠）
        if (this.thinkingActive) {
          // 先擦除流式思考草稿区，让摘要行替代它
          this.renderer.eraseStreamingThinking();
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
          // 摘要用 'thinking_summary' role（非 assistant），强制 messages-store 新建消息，
          // 避免 appendLine 续接到已固化的 ● Thinking… 消息导致 InlineApp 跳过渲染。
          this.print(summaryLines, 'thinking_summary');
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
        }
        break;
      }

      case 'tool_call': {
        // 不立即 print——进缓冲区等 result，配对后成对 flush（视觉位置修复）。
        // openModelBlock 推迟到 flushTool 时调用，避免空行位置错乱。
        const toolUseId = block.toolUseId ?? `auto-${this.idCounter++}-${block.name}`;
        const callLines = MessageFormatter.format('tool_call', {
          toolName: block.name,
          toolInput: block.input,
        });
        this.toolBuffer.push({
          toolUseId,
          name: block.name,
          input: block.input,
          callLines,
        });
        break;
      }

      case 'tool_result': {
        // 配对：从缓冲区找到这个 result 对应的 call 项。
        //   1. 有 toolUseId → 精确匹配（并行场景根治）
        //   2. 没 id → 取缓冲区第一个未配对的项（FIFO，streaming-executor 保证顺序）
        //   3. 缓冲区空 → 没有对应 call，直接立即渲染（兜底，理论上不该发生）
        let idx = -1;
        if (block.toolUseId) {
          idx = this.toolBuffer.findIndex(t => t.toolUseId === block.toolUseId);
        }
        if (idx < 0) {
          // FIFO：第一个还没 result 的项
          idx = this.toolBuffer.findIndex(t => t.resultLines === undefined);
        }
        if (idx < 0) {
          // 兜底：没找到对应 call，立即渲染（不丢失 result）
          // 这种情况极少：result 先于 call、或 hook 之外的非工具 result
          this.openBlock();
          const meta = buildToolResultBlock(block.name, block.input, block.output);
          const summaryLines = MessageFormatter.format('tool_result', meta);
          this.print(summaryLines, 'tool');
          this.hasContent = true;
          break;
        }

        const item = this.toolBuffer[idx]!;
        // input 优先级：result 自带 > 配对 call 缓存的 input
        const input = block.input ?? item.input;
        const meta = buildToolResultBlock(block.name, input, block.output);
        const summaryLines = MessageFormatter.format('tool_result', meta);
        item.resultLines = summaryLines;

        // 处理可折叠块（截断时注册）
        if (meta.rawOutput !== undefined && meta.rawOutput !== '') {
          const { truncated } = summarizeOutput(meta.rawOutput, RESULT_PREVIEW_LINES);
          if (truncated) {
            const id = `tool-${++this.idCounter}`;
            const fullLines = meta.rawOutput.split('\n').map((l, i) => ({
              content: `${i === 0 ? '⎿  ' : '   '}${l}`,
              style: BLOCK_STYLES.dim,
              indent: INDENT.nested,
              raw: true,
            }));
            item.expandableId = id;
            item.expandableFullLines = fullLines;
            item.hasExpandable = true;
          }
        }

        // 配对完成 → 立即 flush 该项
        this.flushTool(idx);
        break;
      }

      case 'hook': {
        // PostToolUse hook 日志：紧跟 tool_result 的附属信息。
        //
        // 时序：index.ts 的消息循环里，tool_result 事件 emit 之后同步 await hook，
        // 然后 emit hook 块。所以 hook 到达时，对应工具的 call+result 刚 flush 完，
        // 屏幕底部就是它的 result 行——hook 立即 print 自然紧跟其后。
        // 不另加块间空行（result→hook 是同一工具的附属，视觉上紧贴）。
        const hookLines = [{ content: block.text, style: BLOCK_STYLES.dim, indent: INDENT.nested }];
        this.print(hookLines, 'tool');
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

  /**
   * ctrl+o 临时 alt screen 覆盖层：取最后一个可折叠块的完整展开内容。
   * 返回 { lines, kind } 或 null（无可展开块）。index.ts 的 ctrl+o 处理器
   * 用它进 alt screen 渲染完整内容，按 q 返回主屏（主屏 scrollback 完好）。
   */
  getLastExpandableFullLines(): { lines: FormattedLine[]; kind: 'thinking' | 'tool_result' } | null {
    const lines = this.expandable.getLastFullLines();
    const kind = this.expandable.getLastKind();
    if (!lines || !kind) return null;
    return { lines, kind };
  }

  /** 把 FormattedLine[] 下沉到 renderer（带样式，透传 raw 标记）。
   *  role 透传给 renderer（Ink 侧 store adapter 据此断块/分组）；默认 'system'。 */
  private print(lines: FormattedLine[], role: string = 'system'): void {
    for (const line of lines) {
      this.renderer.printMessage(line.content, role, line.style as Record<string, unknown>, line.raw === true);
    }
  }

  /**
   * flush 单个缓冲工具项：call 行紧跟其 result 行（+ hook）成对落屏。
   *
   * 物理：从货架上取下这个配对完成的包裹，按"call→result→hook"顺序摆上交付台。
   * 落屏后从缓冲区移除（已交付）。
   */
  private flushTool(idx: number): void {
    const item = this.toolBuffer[idx];
    if (!item) return;
    // 块间空行：首个工具前由 openModelBlock 处理（与 thinking/assistant_text 之间也加空行）
    this.openModelBlock();
    // call 行（● Read(...)）
    this.print(item.callLines, 'tool');
    // result 行（⎿ ...）——续接 call，不另加空行
    if (item.resultLines) {
      this.print(item.resultLines, 'tool');
      // 注册可折叠块（截断时）
      if (item.hasExpandable && item.expandableId && item.expandableFullLines) {
        this.expandable.add({
          id: item.expandableId,
          kind: 'tool_result',
          summaryLines: item.resultLines,
          fullLines: item.expandableFullLines,
        });
      }
    }
    this.hasContent = true;
    // 从缓冲区移除（已交付）。注意：hook 来时这一项已经没了，hook 走立即 print 兜底。
    this.toolBuffer.splice(idx, 1);
  }

  /**
   * flush 所有未配对的 call（防丢失）。
   * clear() / clearTurnState() 时调用——result 没到的 call 也得渲染出来。
   */
  private flushAllPending(): void {
    // 按 call 到达顺序（缓冲区顺序）逐个 flush；没 result 的项只渲染 call 行
    while (this.toolBuffer.length > 0) {
      this.flushTool(0);
    }
  }

  /** 提交一帧 */
  commit(): void {
    this.renderer.flushNow();
  }

  /** 清空（新 turn 开始时） */
  clear(): void {
    // 先把未交付的工具块 flush 出去，避免丢失
    this.flushAllPending();
    this.hasContent = false;
    this.assistantGapApplied = false;
    this.thinkingActive = false;
    this.thinkingBuffer = '';
    this.expandable.clear();
    this.renderer.clearMessages();
  }

  /**
   * 仅重置 turn 状态（可折叠块存储），不清屏。
   * 新 turn 开始时调用——上一 turn 的可折叠块不再需要，
   * 但屏幕上的历史消息保留（不清屏）。
   */
  clearTurnState(): void {
    // flush 未交付的工具块（防丢失）
    this.flushAllPending();
    this.thinkingBuffer = '';
    this.expandable.clear();
    // hasContent 保持 true（屏幕上仍有历史内容，新块前要加空行）
  }
}
