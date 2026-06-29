// 消息存储 + 视口
//
// 物理本质：备用屏没有原生 scrollback，得自己管一叠"可以翻页的稿纸"。
// 消息存成"已折好行"的逻辑行数组（每行带 cells + 样式 + role）。
// 视口 = 取最后 N 行；新内容自动跟到底（autoScroll）。

import { stringToCells, stringWidth, type Cell, type Style } from './cell.js';

export type MessageRole = 'user' | 'assistant' | 'system';

/** 一行逻辑行（已折行后的单行） */
export interface MessageRow {
  cells: Cell[];
  role: MessageRole;
}

/** 一条消息的元信息（用于流式追加时定位并重建其行） */
interface MessageEntry {
  /** 这条消息在 lines 数组里的起始行索引 */
  startLine: number;
  role: MessageRole;
  /** 累积的原始文本（未折行） */
  text: string;
  style: Style;
}

/**
 * 消息缓冲：管理所有逻辑行 + 视口取数 + 流式追加。
 *
 * 设计：
 * - lines[] 存所有已折行的逻辑行。
 * - messages[] 记录每条消息的元信息（起始行 + 累积文本 + 样式）。
 * - appendText：若 role 与最后一条相同，截掉该消息的所有行，用累积文本重建；
 *   否则新建一条消息。
 */
export class MessageBuffer {
  private lines: MessageRow[] = [];
  private messages: MessageEntry[] = [];

  /** 折行宽度（0=不折行） */
  private wrapCols: number;

  constructor(wrapCols: number = 0) {
    this.wrapCols = wrapCols;
  }

  /** 设置折行宽度（resize 后调用） */
  setWrapCols(cols: number): void {
    this.wrapCols = Math.max(0, cols);
  }

  /**
   * push 一条消息（cells 是该消息的原始字符流）。会按当前 wrapCols 折行。
   * 每条独立成行（不累积）。
   */
  push(messages: Array<{ cells: Cell[]; role: MessageRole }>, wrapCols?: number): void {
    if (wrapCols !== undefined) this.wrapCols = wrapCols;
    for (const m of messages) {
      const text = m.cells.map(c => c.char).join('');
      this.appendLine(text, m.role, deriveStyle(m.cells));
    }
  }

  /**
   * 追加一段文本，归入"最后一条同 role 消息"或新建一条。
   * 这是流式 token 累积的入口（appendStreaming 用）。
   */
  appendText(text: string, role: MessageRole, style: Style): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === role && styleEq(last.style, style)) {
      // 累积进同一条消息
      last.text += text;
      this.rebuildMessage(last);
    } else {
      // 新建一条消息（按 \n 拆行、每段独立 entry）
      this.appendLine(text, role, style);
    }
  }

  /**
   * 追加一条**整行消息**：按 `\n` 拆成多段，**每段作为独立消息（绝不累积）**。
   * 用于 banner、用户输入、工具结果等"整行固化"场景——即便与上一条 role+style 相同，
   * 也各自独立成行，不会被当成流式 token 拼接。
   */
  appendLine(text: string, role: MessageRole, style: Style): void {
    const segments = text.split('\n');
    for (const seg of segments) {
      this.appendMessageEntry(seg, role, style);
    }
  }

  /** 新建一条消息 entry（按当前 wrapCols 折行追加到 lines 末尾） */
  private appendMessageEntry(text: string, role: MessageRole, style: Style): void {
    const entry: MessageEntry = { startLine: this.lines.length, role, text, style };
    this.messages.push(entry);
    this.rebuildMessage(entry);
  }

  /** 根据累积文本重建某条消息的所有逻辑行（截掉旧行再追加新行） */
  private rebuildMessage(entry: MessageEntry): void {
    // 截掉该消息及其之后所有行（流式时它总是最后一条）
    this.lines.length = entry.startLine;
    // 也截掉其后的消息元信息
    const idx = this.messages.indexOf(entry);
    if (idx >= 0) this.messages.length = idx + 1;
    // 按 \n 拆行，每行独立折行（thinking 文本可能含换行）
    const segments = entry.text.split('\n');
    for (const seg of segments) {
      const cells = stringToCells(seg, entry.style);
      for (const line of wrapCells(cells, this.wrapCols)) {
        this.lines.push({ cells: line, role: entry.role });
      }
    }
  }

  /**
   * 设置当前"流式 assistant 消息"的内容为预渲染好的若干行（每行已是带样式的 cells）。
   * 若最后一条消息不是 assistant，则新建一条；否则替换其所有行。
   * 每行会再按 wrapCols 折行（防止超宽）。
   *
   * 用于 Markdown 流式渲染：上层把累积文本经 renderMarkdown 转成 Cell[][]，
   * 整体替换当前消息——这样行内标记/代码块/标题等都能成型。
   */
  setStreamingRows(rows: Cell[][]): void {
    const role: MessageRole = 'assistant';
    let entry = this.messages[this.messages.length - 1];
    if (!entry || entry.role !== role) {
      entry = { startLine: this.lines.length, role, text: '', style: {} };
      this.messages.push(entry);
    }
    // 截掉该消息及其之后的行
    this.lines.length = entry.startLine;
    const idx = this.messages.indexOf(entry);
    if (idx >= 0) this.messages.length = idx + 1;
    // 逐行折行追加（保留每 cell 的样式）
    for (const row of rows) {
      for (const seg of wrapCells(row, this.wrapCols)) {
        this.lines.push({ cells: seg, role });
      }
    }
  }

  /** 取最后 height 行的视口（主屏模式：可视窗口 = 最后 height 行）。 */
  viewport(height: number): MessageRow[] {
    if (height <= 0) return [];
    const total = this.lines.length;
    if (total === 0) return [];
    const start = Math.max(0, total - height);
    return this.lines.slice(start);
  }

  /**
   * 取最后 height 行，不足时前面补空行（底部对齐）。
   * 渲染层把消息区底部钉齐时用：空行画空白，实际行画内容。
   */
  viewportFit(height: number): MessageRow[] {
    if (height <= 0) return [];
    const total = this.lines.length;
    if (total === 0) {
      return new Array(height).fill(null).map(() => ({ cells: [], role: 'system' as MessageRole }));
    }
    const start = Math.max(0, total - height);
    const slice = this.lines.slice(start, start + height);
    const pad = height - slice.length;
    const empty: MessageRow[] = [];
    for (let i = 0; i < pad; i++) {
      empty.push({ cells: [], role: 'system' as MessageRole });
    }
    return [...empty, ...slice];
  }

  /** 当前逻辑行总数 */
  get lineCount(): number {
    return this.lines.length;
  }

  /** 返回全部消息行（主屏增长画布模型：画布按全部内容建，旧的靠终端滚进 scrollback）。 */
  allLines(): MessageRow[] {
    return this.lines;
  }

  /** 清空所有消息。 */
  clear(): void {
    this.lines = [];
    this.messages = [];
  }
}

/**
 * 把一串 cells 按 wrapCols 折成多行（每行宽度不超过 wrapCols）。
 * wrapCols<=0 表示不折行（返回单行）。
 * 词边界换行：遇到超宽时回退到最近的空格处断行，避免单词中间断开。
 * 宽字符不拆半：若本行剩余宽度不足以容纳下一个宽字符，换到下一行。
 */
function wrapCells(cells: Cell[], wrapCols: number): Cell[][] {
  if (cells.length === 0) return [[]];
  if (wrapCols <= 0) return [cells];
  const lines: Cell[][] = [];
  let cur: Cell[] = [];
  let width = 0;
  // 记录当前行中最后一个空格的位置（用于词边界回退）
  let lastSpaceIdx = -1;
  let lastSpaceWidth = 0;
  for (const cell of cells) {
    const w = stringWidth(cell.char);
    if (width + w > wrapCols && cur.length > 0) {
      // 词边界回退：如果有空格，回退到空格处断行
      if (lastSpaceIdx >= 0 && lastSpaceIdx < cur.length - 1) {
        // 空格后的部分作为下一行的开头
        const nextLineStart = cur.slice(lastSpaceIdx + 1);
        cur.length = lastSpaceIdx; // 截断到空格处（含空格）
        lines.push(cur);
        cur = nextLineStart;
        // 重新计算下一行的宽度
        width = 0;
        for (const c of cur) width += stringWidth(c.char);
        lastSpaceIdx = -1;
        // 重新扫描下一行中的空格
        for (let i = 0; i < cur.length; i++) {
          if (cur[i]!.char === ' ') { lastSpaceIdx = i; lastSpaceWidth = width; }
        }
      } else {
        // 没有空格可回退，强制断行
        lines.push(cur);
        cur = [];
        width = 0;
        lastSpaceIdx = -1;
      }
    }
    cur.push(cell);
    width += w;
    if (cell.char === ' ') {
      lastSpaceIdx = cur.length - 1;
      lastSpaceWidth = width;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

/** 从一组 cells 推断它们的统一样式（取首个 cell 的样式） */
function deriveStyle(cells: Cell[]): Style {
  return cells[0]?.style ?? {};
}

function styleEq(a: Style, b: Style): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}
