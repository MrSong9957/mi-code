// 主屏增长画布渲染器（对齐 Claude Code 默认行为：主屏 + 原生 scrollback + 页脚钉底）
//
// 物理本质（第一性原理）：
// - 把"内容"当成一张可变高度的格子纸（screen.height = 消息行数 + 页脚高度，随内容增长）。
// - 终端只显示这张纸的最后 `rows` 行（viewport）。纸上更靠上的行**自然滚进终端 scrollback**，
//   用户用终端滚动条翻阅（丝滑、原生）。
// - 页脚（状态栏 + 输入框）钉在纸的最底两行 → 永远在 viewport 底部可见。
//
// 每帧（commit）：
//   ① 按当前消息 + 页脚，在内存画一张新 screen（高度 = 内容高度）。
//   ② viewportY = max(0, contentHeight - rows)（已进 scrollback 的行数）。
//   ③ diff(prevScreen, nextScreen) 只比对 y >= viewportY 的可视行；y < viewportY 变了 → fullReset。
//   ④ 内容增长（新行）靠光标 LF（\n）自然滚动进 scrollback。
//   ⑤ 末尾把光标送到页脚输入框的逻辑光标处。
//   ⑥ 单次 writer(buf)，原子。
//
// 这是 Claude Code log-update.ts 的同款算法（viewportY + fullReset + 增长 LF）。

import { Screen } from './screen.js';
import { VirtualScreen } from './virtual-screen.js';
import { MessageBuffer, type MessageRole } from './message-buffer.js';
import { buildStatusBar, type StatusBarState, type ToolStatus } from './status-bar.js';
import { stringToCells, stringWidth, styleKey, type Cell, type Style } from './cell.js';
import { renderMarkdown } from './markdown.js';
import { showCursor, hideCursor } from './ansi.js';

/** 写出接口（默认 process.stdout.write；测试注入 fake） */
export type Writer = (s: string) => void;

export interface RendererOptions {
  rows: number;
  cols: number;
  writer: Writer;
  /** 状态栏静态信息（model/branch/dir） */
  status: Pick<StatusBarState, 'model' | 'branch' | 'dir'>;
  /** 提示符文本（默认 "❯ "） */
  prompt?: string;
  /** 帧间隔（ms），默认 16 */
  frameIntervalMs?: number;
}

const DEFAULT_PROMPT = '❯  ';
const PROMPT_STYLE: Style = { fg: 'green', bold: true };
/** 页脚高度：状态栏 1 行 + 上边框 1 行 + 输入框 1 行 + 下边框 1 行 */
const FOOTER_HEIGHT = 4;
/** 边框样式 */
const BORDER_STYLE: Style = { dim: true };
/** 边框字符（Box Drawing U+2500，isWideCodePoint 已按宽度 1 处理） */
const BORDER_CHAR = '─';

export class Renderer {
  private rows: number;
  private cols: number;
  private writer: Writer;
  private statusInfo: Pick<StatusBarState, 'model' | 'branch' | 'dir'>;
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
  /** 上一帧的 screen（diff 用）+ 它的高度（增长判定） */
  private prevScreen: Screen | null = null;
  private prevHeight = 0;
  /** 上一帧光标在 screen 坐标系里的位置（VirtualScreen 相对记账起点） */
  private prevCursorY = 0;
  private prevCursorX = 0;

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

  /** 启动：主屏模式，隐藏光标（自己管位置），画首帧。 */
  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.writer(hideCursor());
    this.commit();
  }

  /** 退出：恢复光标可见。幂等。 */
  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    this.writer(showCursor());
  }

  // ═══════ 消息输出 ═══════

  /** 固化一条消息（按 \n 拆行，经 Markdown 渲染成带样式 cells，每行独立消息）。 */
  printMessage(text: string, role: MessageRole, _style: Style = {}): void {
    const rows = text === '' ? [[]] : renderMarkdown(text);
    this.messages.push(rows.map(r => ({ cells: r, role })));
    this.scheduleRender();
  }

  /** 流式 Markdown：累积文本经 renderMarkdown 转 cells，替换当前 assistant 消息。 */
  appendStreamingMarkdown(text: string, _isFinal: boolean): void {
    const rows = renderMarkdown(text);
    this.messages.setStreamingRows(rows);
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

  /** 清空消息区。 */
  clearMessages(): void {
    this.messages.clear();
    this.scheduleRender();
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

  /** 画一帧：构建增长 screen → 逐行 diff（跳 scrollback，用 LF 推进新行）→ 光标回输入框 → 单次写。
   *  算法对齐 Claude Code log-update.ts：增长靠 LF（触发终端滚动进 scrollback），
   *  不是 cursor-down（在底部静默失败不滚动）。 */
  private commit(): void {
    if (!this.entered) return;
    this.writer(hideCursor());

    // ① 构建新 screen：高度 = 消息行数 + 页脚高度（至少 1 行）
    const msgLines = this.messages.allLines();
    const contentHeight = msgLines.length + FOOTER_HEIGHT;
    const next = new Screen(Math.max(1, contentHeight), this.cols);
    for (let i = 0; i < msgLines.length; i++) {
      this.writeCellsRow(next, i, msgLines[i]!.cells, 0);
    }
    // 页脚钉在 screen 底部（4 行：状态栏 + 上边框 + 输入框 + 下边框）
    const statusY = next.rows - FOOTER_HEIGHT;
    const borderTopY = statusY + 1;
    const inputY = statusY + 2;
    const borderBottomY = statusY + 3;
    // 状态栏
    const statusCells = buildStatusBar({
      model: this.statusInfo.model, branch: this.statusInfo.branch, dir: this.statusInfo.dir,
      cols: this.cols, tool: this.tool ?? undefined, hint: this.hint,
    });
    this.writeCellsRow(next, statusY, statusCells, 0);
    // 上边框（每个 ─ 占 2 列，所以只需 this.cols/2 个字符填满宽度）
    const borderCount = Math.ceil(this.cols / stringWidth(BORDER_CHAR));
    const borderCells = stringToCells(BORDER_CHAR.repeat(borderCount), BORDER_STYLE);
    this.writeCellsRow(next, borderTopY, borderCells, 0);
    // 输入框
    const promptCells = stringToCells(this.prompt, PROMPT_STYLE);
    const inputCells = stringToCells(this.input, {});
    this.writeCellsRow(next, inputY, [...promptCells, ...inputCells], 0);
    // 下边框
    this.writeCellsRow(next, borderBottomY, borderCells, 0);

    // ③ 首帧或 resize 后 prev 失准：整屏重画
    if (!this.prevScreen) {
      this.renderFull(next, Math.max(0, next.rows - this.rows));
      this.prevScreen = next;
      this.prevHeight = next.rows;
      this.prevCursorY = inputY;
      this.prevCursorX = this.computeInputCursorCol();
      return;
    }

    const prev = this.prevScreen;
    // ═══════ 对齐 Claude Code log-update.ts 的两段式 diff ═══════
    // 1) 现有行(0..prevHeight)：用 cursorMove(相对) 重画变化格；y < viewportY 的够不着 → fullReset
    // 2) 增长行(prevHeight..nextHeight)：用 CR+LF 推进——LF 在视口底部触发滚动进 scrollback
    // 3) 光标恢复：用 LF 到输入框行（创建底部行 / 触发溢出滚动）
    const prevHeight = prev.rows;
    const cursorAtBottom = this.prevCursorY >= prevHeight;
    const prevHadScrollback = cursorAtBottom && prevHeight >= this.rows;
    const growing = next.rows > prevHeight;
    const cursorRestoreScroll = prevHadScrollback ? 1 : 0;
    // viewportY：已进 scrollback 的行数。growing 用 prev 状态；非 growing 用 max(prev,next)
    const viewportY = growing
      ? Math.max(0, prevHeight - this.rows + cursorRestoreScroll)
      : Math.max(prevHeight, next.rows) - this.rows + cursorRestoreScroll;

    const vs = new VirtualScreen({ x: this.prevCursorX, y: this.prevCursorY });
    let needsFullReset = false;

    // —— 第 1 段：现有行 diff（cursorMove 相对移动；跳过 scrollback 行）——
    const commonRows = Math.min(prevHeight, next.rows);
    for (let y = 0; y < commonRows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const pc = prev.getCell(x, y);
        const nc = next.getCell(x, y);
        if (pc.char === nc.char && styleKey(pc.style) === styleKey(nc.style)) continue;
        // 变化但在 scrollback → fullReset
        if (y < viewportY) { needsFullReset = true; break; }
        vs.moveTo(x, y); // 相对移动（cursor-up/down/forward/back）
        if (nc.char === ' ') continue;
        vs.writeCell(nc);
      }
      if (needsFullReset) break;
    }

    if (needsFullReset) {
      this.renderFull(next, Math.max(0, next.rows - this.rows));
    } else {
      // —— 第 1.5 段：缩小时清理旧行（next.rows..prevHeight 的行在新 screen 中不存在）——
      if (!growing && next.rows < prevHeight) {
        for (let y = next.rows; y < prevHeight; y++) {
          if (y < viewportY) { needsFullReset = true; break; }
          vs.moveTo(0, y);
          vs.eraseLine();
        }
      }

      // —— 第 2 段：增长行（prevHeight..next.rows）用 CR+LF 推进 ——
      if (growing) {
        for (let y = prevHeight; y < next.rows; y++) {
          // LF 推进到新行（视口底部时触发滚动进 scrollback）
          while (vs.cursor.y < y) vs.lineFeed();
          // 钳位虚拟光标到视口底部——终端滚动时物理光标停在底部，
          // 但 lineFeed 会让虚拟光标超过视口高度，导致后续 moveTo 的相对偏移全部错位。
          if (vs.cursor.y >= this.rows) vs.cursor.y = this.rows - 1;
          vs.moveTo(0, vs.cursor.y);
          for (let x = 0; x < this.cols; x++) {
            const nc = next.getCell(x, y);
            if (nc.char === ' ' || nc.char === ' ') continue;
            vs.moveTo(x, vs.cursor.y);
            vs.writeCell(nc);
          }
        }
      }
      // —— 第 3 段：光标恢复到输入框（用视口相对坐标）——
      // 增长后 viewportY 可能变化，需要重新计算
      const vpY = Math.max(0, next.rows - this.rows);
      const inputVY = inputY - vpY;
      while (vs.cursor.y < inputVY) vs.lineFeed();
      vs.moveTo(this.computeInputCursorCol(), inputVY);
      const buf = vs.flush();
      if (buf) this.writer(buf);
      this.writer(showCursor());
    }

    // ⑥ 记账
    this.prevScreen = next;
    this.prevHeight = next.rows;
    this.prevCursorY = inputY;
    this.prevCursorX = this.computeInputCursorCol();
  }

  /** 整屏重画（首帧 / fullReset）：擦屏 + 回原点 + 从 viewportY 起用 LF 推进画可视行 + 光标回输入框。
   *  fullReset 会闪（主屏固有代价）。 */
  private renderFull(next: Screen, viewportY: number): void {
    this.writer(hideCursor());
    const vs = new VirtualScreen({ x: 0, y: 0 });
    vs.raw('\x1b[2J\x1b[H'); // 擦屏 + 回原点
    // 从 viewportY 起画到末尾（用 LF 推进，对齐 commit 的行推进机制）
    for (let y = viewportY; y < next.rows; y++) {
      while (vs.cursor.y < y - viewportY) vs.lineFeed();
      vs.moveTo(0, y - viewportY);
      vs.eraseLine();
      for (let x = 0; x < this.cols; x++) {
        const cell = next.getCell(x, y);
        if (cell.char === ' ' || cell.char === ' ') continue;
        vs.moveTo(x, y - viewportY);
        vs.writeCell(cell);
      }
    }
    // 光标回输入框（可视坐标 = screen 坐标 - viewportY）
    // 必须与 commit() 中的 inputY 计算一致：next.rows - FOOTER_HEIGHT + 2
    const inputY = next.rows - FOOTER_HEIGHT + 2;
    while (vs.cursor.y < inputY - viewportY) vs.lineFeed();
    vs.moveTo(this.computeInputCursorCol(), inputY - viewportY);
    const buf = vs.flush();
    if (buf) this.writer(buf);
    this.writer(showCursor());
  }

  /** 计算输入框光标的列（screen/终端通用，0-based）。 */
  private computeInputCursorCol(): number {
    const promptWidth = stringWidth(this.prompt);
    const beforeChars = [...this.input].slice(0, this.cursorPos).join('');
    const beforeWidth = stringWidth(beforeChars);
    return promptWidth + beforeWidth;
  }

  /** 把一组 cells 从某行某列起铺进 screen（宽字符占两格）。 */
  private writeCellsRow(frame: Screen, y: number, cells: Cell[], startX: number): void {
    let x = startX;
    for (const cell of cells) {
      if (x >= this.cols) break;
      frame.setCell(x, y, cell);
      const w = stringWidth(cell.char);
      if (w === 2 && x + 1 < this.cols) {
        frame.setCell(x + 1, y, { char: ' ', style: cell.style });
        x += 2;
      } else {
        x += 1;
      }
    }
  }

  // ═══════ resize ═══════

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.messages.setWrapCols(cols);
    // resize 后 prevScreen 失准 → 下一帧 fullReset
    this.prevScreen = null;
    this.scheduleRender();
  }

  /** 调试/测试：返回当前 screen 各行文本（不含样式）。 */
  inspectFrame(): string[] {
    const msgLines = this.messages.allLines();
    const contentHeight = msgLines.length + FOOTER_HEIGHT;
    const probe = new Screen(Math.max(1, contentHeight), this.cols);
    for (let i = 0; i < msgLines.length; i++) {
      this.writeCellsRow(probe, i, msgLines[i]!.cells, 0);
    }
    const statusY = probe.rows - FOOTER_HEIGHT;
    const inputY = probe.rows - FOOTER_HEIGHT + 1;
    const statusCells = buildStatusBar({
      model: this.statusInfo.model, branch: this.statusInfo.branch, dir: this.statusInfo.dir,
      cols: this.cols, tool: this.tool ?? undefined, hint: this.hint,
    });
    this.writeCellsRow(probe, statusY, statusCells, 0);
    const promptCells = stringToCells(this.prompt, PROMPT_STYLE);
    const inputCells = stringToCells(this.input, {});
    this.writeCellsRow(probe, inputY, [...promptCells, ...inputCells], 0);
    const lines: string[] = [];
    for (let y = 0; y < probe.rows; y++) {
      let line = '';
      for (let x = 0; x < this.cols; x++) {
        const ch = probe.getCell(x, y).char;
        line += ch === ' ' ? '' : ch;
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  }
}
