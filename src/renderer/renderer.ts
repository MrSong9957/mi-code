// 主屏渲染器（顺序追加 + 绝对定位底部区）。
//
// 双区解耦模型（废弃画布 diff）：
// - 消息区：只增不减。每条新消息作为新行用 CR+LF 追加写出，满屏后触发终端原生滚动进
//   scrollback，用户用终端滚动条翻阅（丝滑、原生）。lastFlushedLine 游标保证旧行不重画。
// - 底部区（页脚）：状态栏 + 输入框，永远钉在屏幕最后 footerHeight 行，用 CSI CUP 绝对定位
//   重写，不依赖光标当前位置 → 避开画布 diff 在满屏后坐标脱钩的根因。
//
// 每帧（commit，三段式）：
//   ① 消息追加器：用 lastFlushedLine 游标追加新增消息行（CR+LF，满屏触发原生滚动）。
//   ② 流式重写器：原地重画当前流式块（Task 3 实现）。
//   ③ 底部区刷新器：refreshFooter 用 CUP 绝对定位画页脚，末尾光标定位到输入框。
//
// 这是 Claude Code log-update.ts 的同款思路（增长靠 LF 触发终端滚动进 scrollback）。

import { MessageBuffer, type MessageRole } from './message-buffer.js';
import { buildStatusBar, type StatusBarState, type ToolStatus } from './status-bar.js';
import { stringWidth, styleKey, type Cell, type Style } from './cell.js';
import { fg, bg } from './colors.js';
import { renderMarkdown } from './markdown.js';
import { showCursor, hideCursor } from './ansi.js';

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
/** 输入区最大行数 */
const MAX_INPUT_LINES = 3;
/** 计算输入区实际行数（至少 1 行，最多 MAX_INPUT_LINES 行） */
function getInputLineCount(input: string): number {
  return Math.min(MAX_INPUT_LINES, Math.max(1, input.split('\n').length));
}
/** 边框样式 */
const BORDER_STYLE: Style = { dim: true };
/** 边框字符（Box Drawing U+2500，isWideCodePoint 已按宽度 1 处理） */
const BORDER_CHAR = '─';

export class Renderer {
  private rows: number;
  private cols: number;
  private writer: Writer;
  private statusInfo: Pick<StatusBarState, 'model' | 'branch' | 'dir' | 'mode' | 'contextUsage'>;
  private prompt: string;
  private frameIntervalMs: number;

  /** 消息缓冲（存全部消息行；画布按它建） */
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
  /** 消息追加器「已写到哪里」（allLines 的游标；只增不减） */
  private lastFlushedLine = 0;
  /** 流式重写器的块起始行（Task 3 用，本 Task 先声明） */

  /** 节流状态 */
  private scheduled = false;
  private trailingPending = false;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RendererOptions) {
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.writer = opts.writer;
    this.statusInfo = opts.status;
    this.prompt = opts.prompt ?? DEFAULT_PROMPT;
    this.frameIntervalMs = opts.frameIntervalMs ?? 16;
    this.messages = new MessageBuffer(this.cols);
  }

  // ═══════ 生命周期 ═══════

  /** 启动：清屏 + 画首帧（renderFull 重置 lastFlushedLine 后委托 commit）。 */
  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.renderFull();
  }

  /** 退出：恢复光标可见。幂等。 */
  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    // 重置 scroll region 为全屏（DECSTBM 默认），避免残留影响后续输出
    this.writer('\x1b[r');
    this.writer(showCursor());
  }

  private writeMsgLine(line: { cells: Cell[]; role: MessageRole }): void {
    this.writer('\x1b[2K'); // 擦当前行
    this.writer(cellsToStyledString(line.cells)); // 带 SGR 颜色写出
    this.writer('\r\n'); // CR+LF（满屏时触发终端原生滚动）
  }

  // ═══════ 消息输出 ═══════

  /** 固化一条消息（按 \n 拆行，经 Markdown 渲染成带样式 cells，每行独立消息）。
   *  传入的 style 作为「基础层」叠加到每个 cell：cell 自身已有的 style 属性优先
   *  （避免覆盖 Markdown 解析出的标题/代码等颜色），未设置的属性由 style 补齐。
   *  这样 MessageFormatter 的 ● (magenta) / ⎿ (dim) 才能真正着色。 */
  printMessage(text: string, role: MessageRole, style: Style = {}): void {
    // 新内容到来前，先把冻结的流式块用 CR+LF 固化进消息流（交还段1 追加）。
    const rows = text === '' ? [[]] : renderMarkdown(text, this.cols);
    const hasStyle = style && Object.keys(style).length > 0;
    const styledRows = hasStyle
      ? rows.map(r => r.map(c => ({ ...c, style: mergeBaseStyle(c.style, style) })))
      : rows;
    this.messages.push(styledRows.map(r => ({ cells: r, role })));
    this.scheduleRender();
  }

  /** 流式 Markdown：累积文本经 renderMarkdown 转 cells，替换当前 assistant 消息。 */
  /** 流式 Markdown：累积文本经 renderMarkdown 转 cells，替换当前 assistant 消息。
   *  统一块格式：首行加 `● ` 前缀、所有行加 2 空格缩进（与 thinking/tool 块对齐）。
   *  软换行续行也带 2 空格缩进（不顶到 0 列）。 */
  /** 流式 Markdown：累积文本经 renderMarkdown 转 cells，替换当前 assistant 消息。
   *  opts 控制块格式（前缀/缩进/样式）；缺省时用 assistant 默认契约（● 第0列 + 续行2空格）。 */
  appendStreamingMarkdown(
    text: string,
    isFinal: boolean,
    opts: { indent?: number; firstLinePrefix?: string; firstLineStyle?: Style } =
      { indent: 2, firstLinePrefix: '● ', firstLineStyle: { fg: 'magenta' } },
  ): void {
    // 纯追加策略：setStreamingRows 更新 MessageBuffer（markdown 重渲染），
    // commit 段1 自然追加新增行。不维护 streamingBlockStartRow，不退格重写。
    const rows = renderMarkdown(text, this.cols, !isFinal);
    this.messages.setStreamingRows(rows, opts);
    this.scheduleRender();
  }

  /** 流式追加纯文本（thinking 等）。 */
  appendStreaming(text: string, style: Style = {}): void {
    this.messages.appendText(text, 'assistant', style);
    this.scheduleRender();
  }

  /** 流式结束：把当前 assistant 消息"封口"（下次 appendStreaming 会新建一条）。 */
  finalizeStreaming(): void {
    this.flushNow();
    // 插入一个空的 system 消息作为分隔符，确保下一次 appendStreamingMarkdown
    // 不会替换已固化的 assistant 消息（setStreamingRows 检查最后一条的 role）。
    this.messages.appendLine('', 'system', {});
    this.scheduleRender();
  }

  /** 封口流式（仅插分隔符，不强制 flushNow）：供 pipeline 在 assistant isFinal 后调用。
   *  比 finalizeStreaming 温和——不触发额外 commit 帧，减少渲染竞态。 */
  sealStreaming(): void {
    // 封口分隔符前，先把冻结的流式块固化进消息流（与 printMessage 同语义）。
    this.messages.appendLine('', 'system', {});
    this.scheduleRender();
  }

  /** 清空消息区。 */
  clearMessages(): void {
    this.messages.clear();
    this.lastFlushedLine = 0;
    // 不触发 renderFull——由调用方（如 BlockPipeline.redraw 的 flushNow）统一画，
    // 避免中间帧（清屏后立即画空屏，再重放又画）导致闪烁/重复。
    this.writer(hideCursor());
    this.writer('[2J[H'); // 清屏（清掉旧内容，准备重放）
    this.writer('[1;' + this.computeContentRows() + 'r'); // 重设 scroll region
  }


  /** 截断 MessageBuffer 到前 lineCount 行（保留历史，丢弃之后）。
   *  redraw 用：截断到当前轮起点，再重放当前轮 snapshot。不清屏（commit 自然重画）。 */
  truncateMessagesTo(lineCount: number): void {
    this.messages.truncateTo(lineCount);
    this.lastFlushedLine = Math.min(this.lastFlushedLine, lineCount);
  }

  /** 当前 MessageBuffer 总行数。 */
  get messageLineCount(): number {
    return this.messages.lineCountTotal;
  }
  // ═══════ 输入态 / 状态栏 ═══════

  setInput(text: string, cursorPos: number): void {
    this.input = text;
    const max = [...text].length;
    this.cursorPos = Math.max(0, Math.min(cursorPos, max));
    this.scheduleRender();
  }

  setToolStatus(name: string, status: ToolStatus['status']): void {
    this.tool = { name, status };
    this.scheduleRender();
  }
  clearToolStatus(): void {
    this.tool = null;
    this.scheduleRender();
  }
  setHint(hint: string | undefined): void {
    this.hint = hint;
    this.scheduleRender();
  }
  getPrompt(): string {
    return this.prompt;
  }

  // ═══════ 节流 + commit ═══════

  private scheduleRender(): void {
    if (this.scheduled) {
      this.trailingPending = true;
      return;
    }
    this.scheduled = true;
    this.commit();
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.scheduled = false;
      if (this.trailingPending) {
        this.trailingPending = false;
        this.scheduleRender();
      }
    }, this.frameIntervalMs);
  }

  flushNow(): void {
    this.commit();
  }

  /** 画一帧（三段式，废弃画布 diff）：
   *  ① 消息追加器（只增不减）：用 lastFlushedLine 游标追加新增消息行（CR+LF），
   *     满屏时触发终端原生滚动进 scrollback。
   *  ② 流式重写器（Task 3 实现，此处暂留空）：原地重画当前流式块。
   *  ③ 底部区刷新器：refreshFooter 用 CUP 绝对定位画页脚，末尾光标定位到输入框。 */
  private commit(): void {
    if (!this.entered) return;
    this.writer(hideCursor());
    // 消息区：逐行 CUP + eraseLine + 写（不清整屏，避免闪烁）。
    // 每帧重画可视区最后 contentRows 行；流式块（setStreamingRows 截断）也能正确显示。
    // scroll region 隔离 footer；满屏时旧行靠 region 滚动进 scrollback。
    const contentRows0 = Math.max(1, this.rows - (2 + getInputLineCount(this.input) + 1));
    const allLines = this.messages.allLines();
    const startLine = Math.max(0, allLines.length - contentRows0);
    for (let i = startLine; i < allLines.length; i++) {
      const screenRow = (i - startLine) + 1; // 1-based，scroll region 内行号
      this.writer('[' + screenRow + ';1H');  // CUP 到该行
      this.writer('[2K');                          // eraseLine（单行，不闪）
      this.writer(cellsToStyledString(allLines[i]!.cells));      // 写内容（带 SGR）
    }
    this.lastFlushedLine = allLines.length;

  
    // 段 3：底部区刷新器
    this.refreshFooter();

    // 光标定位（CUP 到输入框位置）
    const cursor = this.computeInputCursorPos();
    const footerHeight = 2 + getInputLineCount(this.input) + 1;
    const inputScreenRow = this.rows - footerHeight + 2 + cursor.row; // 1-based，+2 跳过上边框到输入框
    this.writer('\x1b[' + inputScreenRow + ';' + (cursor.col + 1) + 'H');
    this.writer(showCursor());
  }

  /** 全清屏 + 委托 commit（首帧 / resize 调用）。
   *  重置 lastFlushedLine=0，使 commit 段 1 从头追加所有消息行。 */
  private renderFull(): void {
    this.writer(hideCursor());
    this.writer('\x1b[2J\x1b[H'); // 全清屏（首帧/resize）
    // 设置 scroll region：消息区（rows 1..contentRows，1-based）。
    // footer 区在 region 之外，消息追加器的 LF 只在 region 内滚动，
    // 不会推进到 footer；footer 由 refreshFooter 用 CUP（不受 region 限制）重画。
    this.writer('\x1b[1;' + this.computeContentRows() + 'r');
    this.lastFlushedLine = 0;
    this.commit();
  }

  /** 消息区行数（= 终端高度 - 页脚高度）；scroll region 顶部固定为 1。 */
  private computeContentRows(): number {
    const footerHeight = 2 + getInputLineCount(this.input) + 1;
    return Math.max(1, this.rows - footerHeight);
  }

  /** 底部区刷新器（CUP 绝对定位）：把页脚（上边框 + 输入框 + 下边框 + 状态栏）
   *  直接用 CSI CUP（\x1b[r;1H）写到屏幕最后 footerHeight 行，不依赖光标当前位置，
   *  避开满屏后坐标脱钩的根因。段3 边框 dim、prompt green+bold、状态栏 cells 带 SGR。
   *
   *  实现：把所有字节攒到一个字符串里，单次 this.writer 原子输出，也让「最后一帧」
   *  = 完整底部区内容。画完页脚后把光标 CUP 到输入框逻辑位置（commit 末尾也会再定位一次）。 */
  private refreshFooter(): void {
    const inputLineCount = getInputLineCount(this.input);
    const footerHeight = 2 + inputLineCount + 1;
    const borderTopRow = this.rows - footerHeight + 1;
    const inputStartRow = borderTopRow + 1;
    const borderBottomRow = inputStartRow + inputLineCount;
    const statusRow = borderBottomRow + 1;
    const borderCount = Math.ceil(this.cols / 1);
    const cursor = this.computeInputCursorPos();
    let out = "";
    // 上边框
    out += "\x1b[" + borderTopRow + ";1H\x1b[2K";
    out += "[2m" + BORDER_CHAR.repeat(borderCount) + "[0m";
    // 输入框
    const inputLines = this.input.split("\n");
    for (let li = 0; li < inputLineCount; li++) {
      const row = inputStartRow + li;
      const line = inputLines[li] ?? "";
      out += "\x1b[" + row + ";1H\x1b[2K";
      if (li === 0) out += "[32m[1m" + this.prompt + "[0m";
      out += line;
    }
    // 下边框
    out += "\x1b[" + borderBottomRow + ";1H\x1b[2K";
    out += "[2m" + BORDER_CHAR.repeat(borderCount) + "[0m";
    // 状态栏
    out += "\x1b[" + statusRow + ";1H\x1b[2K";
    const statusCells = buildStatusBar({
      mode: this.statusInfo.mode, model: this.statusInfo.model,
      branch: this.statusInfo.branch, dir: this.statusInfo.dir,
      contextUsage: this.statusInfo.contextUsage,
      cols: this.cols, tool: this.tool ?? undefined, hint: this.hint,
    });
    out += cellsToStyledString(statusCells); // 带 SGR 颜色（dim/彩色）
    // 光标 CUP 到输入框逻辑位置（commit 末尾也会再 CUP 一次，保证最终光标位置正确）
    const cursorRow = inputStartRow + cursor.row;
    const cursorCol = cursor.col + 1; // 1-based
    out += "\x1b[" + cursorRow + ";" + cursorCol + "H";
    this.writer(out);
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
      remaining -= lineLen + 1; // +1 for the '\n'
    }
    // 光标在末尾
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
    // resize → 重置追加游标并整屏重画
    this.renderFull();
  }

}

/**
 * 把 Style 转为绝对 SGR 转义串（复位 + 设置）。与 cell.ts buildStyle 同语义，
 * 但放在 renderer 内便于段1/2/3 三处复用（消息行、流式块、状态栏）。 */
function styleToAnsi(style: Style): string {
  if (!style || styleKey(style) === '') return '';
  let s = '[0m'; // 先复位，再绝对设置（避免与上一段样式叠加）
  if (style.bold) s += '[1m';
  if (style.dim) s += '[2m';
  if (style.italic) s += '[3m';
  if (style.underline) s += '[4m';
  s += fg(style.fg);
  s += bg(style.bg);
  return s;
}

/**
 * 把一行 cells 序列化为带 SGR 的字符串：只在 styleKey 变化时发样式字节
 * （同 Claude Code stylePool.transition 思路），结尾复位。 */
function cellsToStyledString(cells: Cell[]): string {
  let out = '';
  let lastKey = '';
  for (const cell of cells) {
    if (cell.char === ' ') continue; // 跳过宽字符占位
    const key = styleKey(cell.style);
    if (key !== lastKey) {
      out += styleToAnsi(cell.style);
      lastKey = key;
    }
    out += cell.char;
  }
  if (lastKey !== '') out += '[0m'; // 尾部复位
  return out;
}


/**
 * 把 base style 合并到 cell 的 style 之上：cell 自身属性优先，base 仅补齐空缺。
 * 用于 printMessage：让传入的 ● magenta / ⎿ dim 等样式着色，又不破坏 Markdown 颜色。
 */
function mergeBaseStyle(cellStyle: Style, base: Style): Style {
  return { ...base, ...cellStyle };
}
