// 主屏 + DECSTBM 滚动区域 + 纯追加渲染器
//
// 物理本质（第一性原理）：
// - 不进备用屏，留在主屏——保留终端**原生 scrollback**（用户可用滚动条翻历史、
//   鼠标拖选复制，无需开鼠标追踪、无需自建虚拟滚动）。
// - 用 DECSTBM（滚动区域 `\x1b[top;bottom r`）把屏幕分成两段：
//     · 消息区 [0, contentRows)：LF 在 region 底部触发滚动，旧行**进原生 scrollback**，
//       region 外的页脚钉死不动。
//     · 页脚 [contentRows, rows)：上边框 + 输入框 + 下边框 + 状态栏，永远在屏底可见。
// - **纯追加**：消息一行行写进 region，写完 + LF 后永不回头改（CUP 够不着已进 scrollback 的行）。
//   流式 Markdown 也只追加 delta（接受折行临时不完美）。
// - 页脚变化（输入/工具状态）时，CUP 到 region 外逐行 eraseLine + 重写——region 外 CUP
//   不触发滚动，安全。
//
// 这是 TUI「页脚钉底 + 消息可滚 + 原生选取」的经典手法（less/man/vim 分屏同款）。

import { MessageBuffer, wrapCells, type MessageRole } from './message-buffer.js';
import { buildStatusBar, type StatusBarState, type ToolStatus } from './status-bar.js';
import { stringToCells, stringWidth, styleKey as styleKeyOf, styleTransitionByKey, type Cell, type Style } from './cell.js';
import { renderMarkdown } from './markdown.js';
import { WriteBuffer } from './write-buffer.js';
import { supportsSyncUpdate } from './capabilities.js';
import { FrameScheduler } from './frame-scheduler.js';
import { Spinner } from './spinner.js';
import {
  showCursor, hideCursor, cup, cr, eraseLine,
  setScrollRegion, resetScrollRegion, setCursorStyle,
  enterAltScreen, exitAltScreen,
} from './ansi.js';

/** 写出接口（默认 process.stdout.write；测试注入 fake） */
export type Writer = (s: string) => void;

export interface RendererOptions {
  rows: number;
  cols: number;
  writer: Writer;
  /** 状态栏静态信息（mode/model/branch/dir/contextUsage） */
  status: Pick<StatusBarState, 'model' | 'branch' | 'dir' | 'mode' | 'contextUsage'>;
  /** 提示符文本（默认 "❯ "） */
  prompt?: string;
  /** 帧间隔（ms），默认 16 */
  frameIntervalMs?: number;
}

const DEFAULT_PROMPT = '❯  ';
const PROMPT_STYLE: Style = { fg: 'success', bold: true };
/** 输入区最大行数 */
const MAX_INPUT_LINES = 3;
/** 计算输入区实际行数（至少 1 行，最多 MAX_INPUT_LINES 行） */
function getInputLineCount(input: string): number {
  return Math.min(MAX_INPUT_LINES, Math.max(1, input.split('\n').length));
}
/** 边框样式：border 灰 + dim，对齐 Claude Code promptBorder rgb(136,136,136) */
const BORDER_STYLE: Style = { fg: 'border', dim: true };
/** 边框字符（Box Drawing U+2500，isWideCodePoint 已按宽度 1 处理） */
const BORDER_CHAR = '─';

export class Renderer {
  private rows: number;
  private cols: number;
  private writer: Writer;
  private buffer: WriteBuffer;
  private scheduler: FrameScheduler;
  private spinner = new Spinner();
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private statusInfo: Pick<StatusBarState, 'model' | 'branch' | 'dir' | 'mode' | 'contextUsage'>;
  private prompt: string;
  private frameIntervalMs: number;

  /** 消息缓冲（存全部消息行；纯追加模型下主要供 inspectFrame 诊断用） */
  private messages: MessageBuffer;

  /** 输入态 */
  private input = '';
  private cursorPos = 0;

  /** 工具状态（驱动状态栏） */
  private tool: ToolStatus | null = null;
  /** 提示文本（todo 提醒等） */
  private hint: string | undefined;

  /** 是否已启动 */
  private entered = false;
  /** 流式 Markdown：已发送到终端的累积文本长度（delta 追加用） */
  private lastStreamedLen = 0;
  /** 流式块首行前缀（● 等）是否已加（避免每段重复加前缀） */
  private streamingPrefixApplied = false;
  /** 流式：当前视觉行的列位置（下一字符写到哪一列）。跨 token 续写同一行用。 */
  private streamCol = 0;
  /** 流式：当前块续行的缩进列数（折行后续行回退到此列）。 */
  private streamIndent = 0;
  /** 消息区光标 Y（region 内 0-based，受 regionBottom 钳位）。纯追加模型的核心记账：
   *  每条消息写到 messageRow，写完 LF 推进；到 region 底部时 LF 触发滚动（messageRow 钉底）。 */
  private messageRow = 0;

  /** 流式是否活跃（流式块开始 → isFinal 期间为 true）。
   *  用于：1) 流式期间光标保持 hidden；2) 跳过 MessageBuffer push；3) 页脚懒重绘。 */
  private streamingActive = false;
  /** 页脚是否需要重绘（setInput / setToolStatus / setHint 时标记，流式结束后统一重绘） */
  private footerDirty = false;

  constructor(opts: RendererOptions) {
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.writer = opts.writer;
    // 探测终端是否支持 DEC 2026 同步更新；支持则 flush 包裹 BSU/ESU 防闪烁
    this.buffer = new WriteBuffer(opts.writer, { useSyncUpdate: supportsSyncUpdate() });
    // 帧调度器：合并多源 flush 请求（按键/流式/spinner），idle 自动停摆省 CPU。
    // doFlush 承载原 flushFrame 逻辑（drawFooter + placeCursor + buffer.flush）。
    this.scheduler = new FrameScheduler(() => this.doFlush());
    this.statusInfo = opts.status;
    this.prompt = opts.prompt ?? DEFAULT_PROMPT;
    this.frameIntervalMs = opts.frameIntervalMs ?? 16;
    this.messages = new MessageBuffer(this.cols);
  }

  // ═══════ 生命周期 ═══════

  /** 启动：进 alt screen（主屏原样保留，退出时自动恢复），设 scroll region，画首帧页脚。
   *  alt screen 模式对齐 Claude Code：退出时 \x1b[?1049l 切回主屏，恢复进入前原样。 */
  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.messageRow = 0;
    this.resetStreamingState();
    // 进 alt screen（保存主屏光标 + 切备用屏 + 清备用屏）
    this.buffer.write(enterAltScreen());
    // 光标样式：steady 块状（2），对齐 Claude Code
    this.buffer.write(setCursorStyle(2));
    // 消息区 scroll region：[0, contentRows)，页脚钉 region 外
    this.buffer.write(setScrollRegion(0, this.contentRows() - 1));
    // 清备用屏（alt screen 本来是空的，但保险起见）
    this.buffer.write(cup(0, 0));
    this.buffer.write('\x1b[J');
    // 画页脚
    this.drawFooter();
    // 光标到输入框
    this.placeCursorInInput();
    this.buffer.write(showCursor());
    this.buffer.flushRaw();
  }

  /** 退出：恢复光标 + 重置 scroll region + 退出 alt screen（切回主屏恢复原样）。
   *  alt screen 模式下退出时 \x1b[?1049l 自动恢复主屏进入前的内容，无需手动清屏。 */
  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    this.buffer.write(showCursor());
    this.buffer.write(setCursorStyle(0));   // 恢复默认光标样式
    this.buffer.write(resetScrollRegion()); // 恢复全屏滚动
    // 退出 alt screen：切回主屏，恢复进入前的光标和内容
    this.buffer.write(exitAltScreen());
    this.buffer.flushRaw();
  }

  /** 设置 scroll region [0, contentRows)。DECSTBM 设完光标会移到 region 左上角。 */
  private applyScrollRegion(): void {
    this.buffer.write(setScrollRegion(0, this.contentRows() - 1));
  }

  /** 消息区行数 = 终端行数 - 页脚高度。
   *  页脚布局：上边框 + 输入区(inputLineCount) + 下边框 + spinner行 + 状态栏。 */
  private contentRows(): number {
    const inputLineCount = getInputLineCount(this.input);
    const footerHeight = 2 + inputLineCount + 1 + 1; // 上边框 + 输入区 + 下边框 + spinner + 状态栏
    return Math.max(1, this.rows - footerHeight);
  }

  // ═══════ 消息输出（纯追加）═══════

  /**
   * 固化一条消息（按 \n 拆行，经 Markdown 渲染成带样式 cells）。
   * 纯追加：每行写进消息区 region + LF，写完永不回头改。
   * style 作为基础层叠加到每个 cell（cell 自身 style 优先）。
   *
   * raw=true 时跳过 Markdown 渲染，原样显示文本（用于工具输出等不该被
   * Markdown 误判的内容，如 frontmatter 的 --- 不被当成 hr）。
   */
  printMessage(text: string, role: MessageRole, style: Style = {}, raw: boolean = false): void {
    if (!this.entered) return;
    const rows = text === '' ? [[]]
      : raw ? [stringToCells(text, {})]
      : renderMarkdown(text, this.cols);
    const hasStyle = style && Object.keys(style).length > 0;
    // 缓冲到 MessageBuffer（诊断/快照用）——流式期间跳过以减少开销
    const styledRows = hasStyle
      ? rows.map(r => r.map(c => ({ ...c, style: mergeBaseStyle(c.style, style) })))
      : rows;
    if (!this.streamingActive) {
      this.messages.push(styledRows.map(r => ({ cells: r, role })));
    }
    // 每个 Markdown 逻辑行手动折行（≤ cols，不触发 DECAWM），每个视觉行占一个屏幕行
    const visualLines: Cell[][] = [];
    for (const row of styledRows) {
      for (const vl of wrapCells(row, this.cols)) visualLines.push(vl);
    }
    // 逐视觉行写进 region：CUP 到 messageRow，写一行 + LF 推进（到底部触发滚动进 scrollback）
    this.buffer.write(hideCursor());
    const regionBottom = this.contentRows() - 1;
    for (const vl of visualLines) {
      this.buffer.write(cup(this.messageRow, 0));
      this.writeCellsLine(vl);
      this.buffer.write(cr() + '\n'); // CR+LF：LF 在 region 底部触发原生滚动
      if (this.messageRow < regionBottom) this.messageRow++;
    }
    this.buffer.write('\x1b[0m'); // 样式复位
    // 标记页脚需重绘（消息滚动后页脚可能被覆盖，延迟到 flushFrame 统一重绘）
    this.footerDirty = true;
    if (!this.streamingActive) {
      this.buffer.write(showCursor());
      this.requestFrame();
    }
  }

  /**
   * 流式 Markdown：纯追加 delta（只发未发送的部分）。
   * 调用方传累积全文 text，本方法内部算 delta = text.slice(lastStreamedLen)。
   *
   * 关键：跨 token 续写同一视觉行（用 streamCol 记账当前列），而非每个 token 换行。
   * 手动折行（写满 cols 才 LF），messageRow 按真实视觉行推进。
   * 首次调用加 opts.firstLinePrefix（如 ● ）+ indent 缩进；续行回退到 indent 列。
   * isFinal 时封口（LF + 分隔），重置所有流式状态。
   *
   * 性能优化：流式期间光标保持 hidden（不逐 token hide/show），页脚懒重绘。
   */
  appendStreamingMarkdown(
    text: string,
    isFinal: boolean,
    opts: { indent?: number; firstLinePrefix?: string; firstLineStyle?: Style } = {},
  ): void {
    if (!this.entered) return;
    const delta = text.slice(this.lastStreamedLen);
    this.lastStreamedLen = text.length;
    const regionBottom = this.contentRows() - 1;
    const indent = opts.indent ?? 0;
    if (delta.length > 0) {
      // 流式开始时：隐藏光标（整个流式块期间保持 hidden）
      if (!this.streamingActive) {
        this.streamingActive = true;
        this.buffer.write(hideCursor());
      }
      // 块首行前缀（● 等）只加一次，加在 streamCol 当前位置
      // 注意：首行不加 indent（悬挂缩进：● 在第 0 列，续行才缩进到 indent 列）
      if (!this.streamingPrefixApplied) {
        this.streamIndent = indent;
        const prefix = opts.firstLinePrefix ?? '';
        if (prefix) {
          this.streamWriteCells(stringToCells(prefix, opts.firstLineStyle ?? {}), regionBottom);
        }
        this.streamingPrefixApplied = true;
      }
      // delta 按 \n 拆段：段内续写当前行，段间强制换行
      const segments = delta.split('\n');
      for (let si = 0; si < segments.length; si++) {
        if (si > 0) {
          // 段间换行：LF 推进，续行回退到 indent 列
          this.streamLineFeed(regionBottom);
          if (indent > 0) {
            this.streamWriteCells(stringToCells(' '.repeat(indent), {}), regionBottom);
          }
        }
        const seg = segments[si]!;
        if (seg.length > 0) {
          // 流式 delta 走 markdown streaming 模式（剥离 ** / * / ` 标记，避免丑陋星号）
          const segRows = renderMarkdown(seg, this.cols, true);
          const segCells = segRows.length > 0 ? segRows[0]! : stringToCells(seg, {});
          this.streamWriteCells(segCells, regionBottom);
        }
      }
      this.buffer.write('\x1b[0m');
      // 流式 delta 走帧调度合并（80ms 内多个 token 合并成一帧，减少写屏次数）。
      // 不直接 buffer.flush()：避免与按键/spinner 的 flush 交叉写屏闪烁。
      this.requestFrame();
    }
    if (isFinal) {
      // 封口：LF 推进一行，下次 append 从新行起
      this.streamLineFeed(regionBottom);
      this.resetStreamingState();
      this.streamingActive = false;
      this.footerDirty = true;
      this.buffer.write(showCursor());
      this.requestFrame();
    }
  }

  /**
   * 流式写一组 cells 到当前视觉行（streamCol 起），写满 cols 则换行（LF + 回 indent）。
   * 维护 streamCol / messageRow。词边界不回退（纯追加，不回头改）——超长词强制断。
   */
  private streamWriteCells(cells: Cell[], regionBottom: number): void {
    for (const cell of cells) {
      const w = stringWidth(cell.char);
      // 当前行放不下 → 先换行
      if (this.streamCol + w > this.cols && this.streamCol > 0) {
        this.streamLineFeed(regionBottom);
        // 续行回退到 indent 列（补缩进空格）
        if (this.streamIndent > 0) {
          const padCells = stringToCells(' '.repeat(this.streamIndent), {});
          // 直接写缩进（streamCol 已在 LF 后归 0，这里手动推进）
          this.buffer.write(cup(this.messageRow, 0));
          let padKey = '';
          for (const pc of padCells) {
            const k = styleKeyOf(pc.style);
            if (k !== padKey) { this.buffer.write(styleTransitionByKey(padKey, k)); padKey = k; }
            this.buffer.write(pc.char);
          }
          this.streamCol = this.streamIndent;
        }
      }
      // 定位到 (messageRow, streamCol) 并写一个 cell
      this.buffer.write(cup(this.messageRow, this.streamCol));
      const key = styleKeyOf(cell.style);
      // 简化：每个 cell 发自己的样式（流式期间样式不优化，可接受）
      this.buffer.write(styleTransitionByKey('', key));
      this.buffer.write(cell.char);
      this.streamCol += w;
    }
  }

  /** 流式换行：CR+LF，messageRow++（到 region 底部触发滚动），streamCol 归 0。 */
  private streamLineFeed(regionBottom: number): void {
    this.buffer.write(cr() + '\n');
    if (this.messageRow < regionBottom) this.messageRow++;
    this.streamCol = 0;
  }

  /** 重置流式状态（seal/finalize/clear 后）。 */
  private resetStreamingState(): void {
    this.lastStreamedLen = 0;
    this.streamingPrefixApplied = false;
    this.streamCol = 0;
    this.streamIndent = 0;
  }

  /** 流式追加纯文本（thinking 等）——纯追加 + 手动折行，语义同 appendStreamingMarkdown。 */
  appendStreaming(text: string, style: Style = {}): void {
    if (!this.entered) return;
    if (text.length > 0) {
      const regionBottom = this.contentRows() - 1;
      if (!this.streamingActive) {
        this.streamingActive = true;
        this.buffer.write(hideCursor());
      }
      const segments = text.split('\n');
      for (let si = 0; si < segments.length; si++) {
        if (si > 0) this.streamLineFeed(regionBottom);
        const seg = segments[si]!;
        if (seg.length > 0) this.streamWriteCells(stringToCells(seg, style), regionBottom);
      }
      this.buffer.write('\x1b[0m');
      this.requestFrame(); // 流式 delta 走帧调度合并
    }
  }

  /** 流式结束：封口（LF + 分隔）。 */
  finalizeStreaming(): void {
    if (!this.entered) return;
    const regionBottom = this.contentRows() - 1;
    this.streamLineFeed(regionBottom);
    this.resetStreamingState();
    this.streamingActive = false;
    this.footerDirty = true;
    this.buffer.write(showCursor());
    this.requestFrame();
  }

  /** 封口流式（插分隔符，温和版）。纯追加模型下 = 一个空行分隔。 */
  sealStreaming(): void {
    if (!this.entered) return;
    const regionBottom = this.contentRows() - 1;
    this.streamLineFeed(regionBottom);
    this.resetStreamingState();
    this.streamingActive = false;
    this.footerDirty = true;
    this.buffer.write(showCursor());
    this.requestFrame();
  }

  /** 清空消息区（仅清 region 内可视区，不动 scrollback）。 */
  clearMessages(): void {
    if (!this.entered) return;
    this.messages.clear();
    this.resetStreamingState();
    this.streamingActive = false;
    this.messageRow = 0;
    this.buffer.write(hideCursor());
    // 擦消息区 region 内所有行
    for (let y = 0; y < this.contentRows(); y++) {
      this.buffer.write(cup(y, 0));
      this.buffer.write(eraseLine());
    }
    this.buffer.write(cup(0, 0));
    this.drawFooter();
    this.placeCursorInInput();
    this.buffer.write(showCursor());
    this.buffer.flushRaw(); // clearMessages 后立即重建，不走 BSU 避免空屏闪烁
  }

  // ═══════ 输入态 / 状态栏（只重画页脚）═══════

  setInput(text: string, cursorPos: number): void {
    this.input = text;
    const max = [...text].length;
    this.cursorPos = Math.max(0, Math.min(cursorPos, max));
    this.applyScrollRegion();
    this.footerDirty = true;
    this.requestFrame();
  }

  setToolStatus(name: string, status: ToolStatus['status']): void {
    this.tool = { name, status };
    this.footerDirty = true;
    this.requestFrame();
  }
  clearToolStatus(): void {
    this.tool = null;
    this.footerDirty = true;
    this.requestFrame();
  }
  setHint(hint: string | undefined): void {
    this.hint = hint;
    this.footerDirty = true;
    this.requestFrame();
  }

  // ═══════ spinner 控制（钉死页脚区，不进 scrollback） ═══════

  /** 启动 spinner 显示 label，并开始 120ms 帧循环。
   *  每次 tick 推进 spinner 帧 + requestFrame 触发页脚重绘（spinner 行在页脚区）。
   *  幂等：重复 start 会先停旧定时器再启新的。 */
  startSpinner(label: string): void {
    this.spinner.start(label);
    this.stopSpinnerTimer();
    this.spinnerTimer = setInterval(() => {
      this.spinner.tick();
      this.footerDirty = true;
      this.requestFrame();
    }, 120);
    this.footerDirty = true;
    this.requestFrame();
  }

  /** 运行中切换 spinner 文案（不停 spinner）。 */
  setSpinnerLabel(label: string): void {
    if (!this.spinner.isActive()) return;
    this.spinner.setLabel(label);
    this.footerDirty = true;
    this.requestFrame();
  }

  /** 收到 token：重置 spinner stall 计时器（避免 3 秒无 token 变红）。 */
  spinnerOnToken(): void {
    this.spinner.onToken();
  }

  /** 停止 spinner（熄灭）+ 清帧循环定时器。 */
  stopSpinner(): void {
    this.spinner.stop();
    this.stopSpinnerTimer();
    this.footerDirty = true;
    this.requestFrame();
  }

  /** 清 spinner 帧循环定时器（内部）。 */
  private stopSpinnerTimer(): void {
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  getPrompt(): string {
    return this.prompt;
  }

  // ═══════ flush ══════

  /** 实际刷新逻辑：页脚脏标记时重绘页脚，然后一次性写出所有缓冲的 ANSI 序列。
   *  由 FrameScheduler 在 tick 时调用（合并多源请求），或由 flushNow 立即调用。
   *
   *  流式期间（streamingActive）跳过 drawFooter：流式 token 在 messageRow 推进，
   *  此时画 footer 的 borderTopY（=contentRows）可能落在消息区，造成"边框画在消息中间"。
   *  footerDirty 保留，流式封口（sealStreaming/finalizeStreaming）时统一重画。 */
  private doFlush(): void {
    if (this.footerDirty && !this.streamingActive) {
      this.drawFooter();
      this.footerDirty = false;
    }
    // drawFooter 会把光标移到状态栏行，必须重新定位到输入框。
    // 流式期间不画 footer，但光标定位仍需执行（保持输入框光标正确）。
    this.placeCursorInInput();
    this.buffer.flush();
  }

  /** 请求下一帧刷新（标记脏，延迟到下次 scheduler tick 合并）。
   *  内部方法（setInput/printMessage 等）用这个，避免高频调用直接刷屏闪烁。 */
  private requestFrame(): void {
    this.scheduler.requestFrame();
  }

  /** 立即强制刷新（绕过调度，用于 enter/exit/resize/测试断言）。 */
  flushFrame(): void {
    this.scheduler.flushNow();
  }

  flushNow(): void {
    this.scheduler.flushNow();
  }

  /** 销毁渲染器：停止帧调度器和 spinner 定时器（清 setInterval）。进程退出前调用。 */
  destroy(): void {
    this.stopSpinnerTimer();
    this.scheduler.stop();
  }

  // ═══════ 页脚绘制 + 光标定位 ═══════

  /**
   * 画页脚：CUP 到 region 外逐行 eraseLine + 写。
   * region 外 CUP 不触发滚动，安全。
   * 页脚布局（从 contentRows 起）：spinner行 / 上边框 / 输入区(inputLineCount 行) / 下边框 / 状态栏。
   * spinner 在输入框上方（用户期望：转圈动画紧邻输入框上方，不在下方）。
   */
  private drawFooter(): void {
    if (!this.entered) return;
    const contentRows = this.contentRows();
    const inputLineCount = getInputLineCount(this.input);
    const spinnerY = contentRows;                    // spinner 紧贴消息区下方（输入框上方）
    const borderTopY = contentRows + 1;              // 上边框
    const inputStartY = contentRows + 2;             // 输入区
    const borderBottomY = inputStartY + inputLineCount;
    const statusY = borderBottomY + 1;               // 状态栏在最底

    // spinner 行（上边框上方；inactive 时空行占位保持布局稳定）
    const spinnerRender = this.spinner.render();
    if (spinnerRender.text) {
      this.writeFooterCells(spinnerY, stringToCells(spinnerRender.text, spinnerRender.style));
    } else {
      this.writeFooterLine(spinnerY, '', {});
    }
    // 上边框
    this.writeFooterLine(borderTopY, BORDER_CHAR.repeat(this.cols), BORDER_STYLE);
    // 输入区
    const inputLines = this.input.split('\n');
    for (let li = 0; li < inputLineCount; li++) {
      const y = inputStartY + li;
      const line = inputLines[li] ?? '';
      const cells = li === 0
        ? [...stringToCells(this.prompt, PROMPT_STYLE), ...stringToCells(line, {})]
        : stringToCells(line, {});
      this.writeFooterCells(y, cells);
    }
    // 下边框
    this.writeFooterLine(borderBottomY, BORDER_CHAR.repeat(this.cols), BORDER_STYLE);
    // 状态栏
    const statusCells = buildStatusBar({
      mode: this.statusInfo.mode, model: this.statusInfo.model,
      branch: this.statusInfo.branch, dir: this.statusInfo.dir,
      contextUsage: this.statusInfo.contextUsage,
      cols: this.cols, tool: this.tool ?? undefined, hint: this.hint,
    });
    this.writeFooterCells(statusY, statusCells);
    this.buffer.write('\x1b[0m');
  }

  /** 写页脚某行（CUP + eraseLine + 截断到 cols + 写文本 + 样式）。 */
  private writeFooterLine(y: number, text: string, style: Style): void {
    this.writeFooterCells(y, stringToCells(text, style));
  }

  /** 写页脚某行的 cells：CUP 到行首 + eraseLine + 逐 cell（带 SGR）截断到 cols。 */
  private writeFooterCells(y: number, cells: Cell[]): void {
    this.buffer.write(cup(y, 0));
    this.buffer.write(eraseLine());
    this.writeCellsAt(cells, 0);
  }

  /** 从当前光标位置起写一组 cells（带 SGR 样式转换），截断到 cols。 */
  private writeCellsAt(cells: Cell[], _startX: number): void {
    let curKey = '';
    let x = 0;
    for (const cell of cells) {
      const w = stringWidth(cell.char);
      if (x + w > this.cols) break;
      const key = styleKeyOf(cell.style);
      if (key !== curKey) {
        this.buffer.write(styleTransitionByKey(curKey, key));
        curKey = key;
      }
      this.buffer.write(cell.char);
      x += w;
    }
    this.buffer.write('\x1b[0m');
  }

  /**
   * 写消息区一行（纯追加，不 CUP——顺着当前光标）。
   * 光标应在行首。写完光标在行尾（调用方负责发 LF 推进）。
   */
  private writeCellsLine(cells: Cell[]): void {
    let curKey = '';
    let x = 0;
    for (const cell of cells) {
      const w = stringWidth(cell.char);
      if (x + w > this.cols) break;
      const key = styleKeyOf(cell.style);
      if (key !== curKey) {
        this.buffer.write(styleTransitionByKey(curKey, key));
        curKey = key;
      }
      this.buffer.write(cell.char);
      x += w;
    }
    this.buffer.write('\x1b[0m');
  }

  /** 光标定位到输入框逻辑位置（屏幕坐标）。 */
  private placeCursorInInput(): void {
    if (!this.entered) return;
    const cursor = this.computeInputCursorPos();
    // 输入区起点 = contentRows + 2（spinner 占 +0，上边框占 +1，输入区从 +2 开始）
    const inputStartY = this.contentRows() + 2;
    this.buffer.write(cup(inputStartY + cursor.row, cursor.col));
  }

  /** 计算输入框光标的 (行偏移, 列) （0-based，行偏移相对于 inputStartY）。 */
  private computeInputCursorPos(): { row: number; col: number } {
    const lines = this.input.split('\n');
    let remaining = this.cursorPos;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = [...lines[i]!].length;
      if (remaining <= lineLen) {
        const promptW = i === 0 ? stringWidth(this.prompt) : 0;
        const beforeWidth = stringWidth([...lines[i]!].slice(0, remaining).join(''));
        return { row: i, col: promptW + beforeWidth };
      }
      remaining -= lineLen + 1;
    }
    const lastRow = Math.max(0, lines.length - 1);
    const lastLine = lines[lastRow]!;
    const promptW = lastRow === 0 ? stringWidth(this.prompt) : 0;
    return { row: lastRow, col: promptW + stringWidth(lastLine) };
  }

  // ═══════ resize ═══════

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.messages.setWrapCols(cols);
    if (this.entered) {
      // 重设 scroll region + 重画页脚（消息区内容保留原样，可能需手动调整）
      this.applyScrollRegion();
      this.footerDirty = true;
      this.placeCursorInInput();
      this.flushFrame(); // resize 必须立即重画，不走延迟调度
    }
  }

  /** 调试/测试：返回当前消息缓冲各行文本（不含样式）。 */
  inspectFrame(): string[] {
    return this.messages.allLines().map(row => {
      let line = '';
      for (const cell of row.cells) {
        line += cell.char === '' ? '' : cell.char;
      }
      return line.replace(/\s+$/, '');
    });
  }
}

/**
 * 把 base style 合并到 cell 的 style 之上：cell 自身属性优先，base 仅补齐空缺。
 */
function mergeBaseStyle(cellStyle: Style, base: Style): Style {
  return { ...base, ...cellStyle };
}
