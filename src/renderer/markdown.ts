// 轻量 Markdown → cells 解析器
//
// 物理本质：把 Markdown 源码（# 标题、**粗**、代码块等）翻译成"带样式的格子行"。
// 逐行状态机：
// - 代码围栏（```）切换 code 状态；code 行走 highlight 高亮 + 缩进/边框
// - 其余按行类型（标题/列表/引用/分隔线/段落）解析
// - 段落行再做行内解析（粗/斜/行内代码/链接）
//
// 流式友好：未闭合的标记/围栏按原始文本处理，不崩。流式结束后会整体重解析一遍。

import { type Cell, type Style, stringToCells } from './cell.js';
import { highlightCode } from './highlight.js';

const STY_HEADING: Style[] = [
  { bold: true, fg: 'cyan' },    // #
  { bold: true, fg: 'yellow' },  // ##
  { bold: true, fg: 'green' },   // ### 及以上
];
const STY_BOLD: Style = { bold: true };
const STY_ITALIC: Style = { italic: true };
const STY_CODE: Style = { fg: 'yellow' };
const STY_QUOTE: Style = { dim: true };
const STY_HR: Style = { dim: true };
const STY_LINK: Style = { underline: true };
const STY_URL: Style = { dim: true };
const STY_LIST_MARKER: Style = { fg: 'yellow' };
const STY_CHECK_DONE: Style = { fg: 'green' };
const STY_TABLE_HEADER: Style = { bold: true };
const STY_TABLE_BORDER: Style = { dim: true };

/**
 * 解析整段 Markdown，返回"每行的 cells 数组"。
 * 输入用 \n 分行；输出每个元素是一行（已去 Markdown 标记、带样式）。
 * cols 用于水平线等需要知道终端宽度的元素。
 * streaming=true 时跳过内联格式（粗/斜/代码/链接），只解析块级元素，避免流式时格式闪烁。
 */
export function renderMarkdown(text: string, cols: number = 80, streaming: boolean = false): Cell[][] {
  const rawLines = text.split('\n');
  const out: Cell[][] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];

  const flushCode = (): void => {
    if (codeBuf.length === 0) return;
    const code = codeBuf.join('\n');
    const cells = highlightCode(code, codeLang);
    // 按行拆（保留每行的 cells）
    splitCellsByLine(cells).forEach(line => out.push(line));
    codeBuf = [];
  };

  let tableBuf: string[] = [];

  const flushTable = (): void => {
    if (tableBuf.length === 0) return;
    parseTable(tableBuf, cols, streaming).forEach(row => out.push(row));
    tableBuf = [];
  };

  for (const line of rawLines) {
    // 代码围栏检测
    const fence = matchFence(line);
    if (inCode) {
      if (fence !== null) {
        flushCode();
        inCode = false;
        codeLang = '';
        continue;
      }
      codeBuf.push(line);
      continue;
    }
    if (fence !== null) {
      inCode = true;
      codeLang = fence;
      codeBuf = [];
      continue;
    }

    // 表格行检测（以 | 开头或包含 | 的行）
    if (/^\s*\|/.test(line) || (tableBuf.length > 0 && /\|/.test(line))) {
      tableBuf.push(line);
      continue;
    }
    // 非表格行 → 先刷出累积的表格
    flushTable();

    out.push(parseLine(line, cols, streaming));
  }
  flushTable();

  // 流式未闭合围栏：把已累积的代码也输出（不丢内容）
  if (inCode) flushCode();

  return out;
}

// ═══════ 行类型解析 ═══════

/** 匹配代码围栏行，返回语言名（空字符串表示无 lang）；非围栏返回 null。 */
function matchFence(line: string): string | null {
  const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
  if (!m) return null;
  return m[2] ?? '';
}

/** 解析一行非代码内容 → cells。streaming=true 时跳过内联格式。 */
function parseLine(line: string, cols: number = 80, streaming: boolean = false): Cell[] {
  if (line.trim() === '') return [];

  // 分隔线 --- / ***（动态宽度，用 ─ 填满终端宽度）
  if (/^\s*(-\s*){3,}$/.test(line) || /^\s*(\*\s*){3,}$/.test(line)) {
    return stringToCells('─'.repeat(cols), STY_HR);
  }

  // 标题
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) {
    const level = h[1]!.length;
    const sty = STY_HEADING[Math.min(level, 3) - 1]!;
    // 标题内容也允许行内标记（除代码块外）
    return parseInline(h[2]!, { base: sty });
  }

  // 引用 >
  const q = line.match(/^>\s?(.*)$/);
  if (q) {
    const inner = parseInline(q[1]!, { base: STY_QUOTE });
    return [makeCell('▌', STY_QUOTE), makeCell(' ', STY_QUOTE), ...inner];
  }

  // 任务列表 - [x] / - [ ]
  const task = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s*(.*)$/);
  if (task) {
    const indent = task[1]!.length;
    const done = task[2] !== ' ';
    const check = done ? '☑ ' : '☐ ';
    const sty = done ? STY_CHECK_DONE : STY_LIST_MARKER;
    const content = parseInline(task[3]!, { base: done ? { dim: true } : {} });
    return [...pad(indent), ...makeCells(check, sty), ...content];
  }

  // 无序列表 - / *
  const ul = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (ul) {
    const indent = ul[1]!.length;
    const marker = makeCells('• ', STY_LIST_MARKER);
    const content = parseInline(ul[2]!, { base: {} });
    return [...pad(indent), ...marker, ...content];
  }

  // 有序列表 1.
  const ol = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ol) {
    const indent = ol[1]!.length;
    const num = ol[2]!;
    const marker = makeCells(`${num}. `, STY_LIST_MARKER);
    const content = parseInline(ol[3]!, { base: {} });
    return [...pad(indent), ...marker, ...content];
  }

  // 普通段落（流式阶段跳过内联格式，避免未闭合标记闪烁）
  if (streaming) return makeCells(line, {});
  return parseInline(line, { base: {} });
}

// ═══════ 行内解析（粗/斜/行内代码/链接）═══════

interface InlineCtx {
  base: Style;
}

/**
 * 行内解析：处理 **bold**、*italic*、_italic_、`code`、[text](url)。
 * 未闭合的标记按原始文本（含符号）输出，不崩。
 */
function parseInline(text: string, ctx: InlineCtx): Cell[] {
  const out: Cell[] = [];
  let i = 0;
  const n = text.length;
  const pushPlain = (s: string, sty: Style) => {
    for (const ch of s) out.push({ char: ch, style: merge(ctx.base, sty) });
  };

  while (i < n) {
    const rest = text.slice(i);

    // 行内代码 `...`（优先，内部不再解析其它标记）
    const code = rest.match(/^`([^`]+)`/);
    if (code) {
      pushPlain(code[1]!, STY_CODE);
      i += code[0].length;
      continue;
    }
    // 链接 [text](url)
    const link = rest.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (link) {
      pushPlain(link[1]!, STY_LINK);
      pushPlain(` (${link[2]!})`, STY_URL);
      i += link[0].length;
      continue;
    }
    // 粗体 **...** 或 __...__
    const bold = rest.match(/^\*\*([^*]+)\*\*/) ?? rest.match(/^__([^_]+)__/);
    if (bold) {
      pushPlain(bold[1]!, STY_BOLD);
      i += bold[0].length;
      continue;
    }
    // 斜体 *...* 或 _..._
    const ital = rest.match(/^\*([^*]+)\*/) ?? rest.match(/^_([^_]+)_/);
    if (ital) {
      pushPlain(ital[1]!, STY_ITALIC);
      i += ital[0].length;
      continue;
    }
    // 普通字符（连续吃到下一个标记起始符）
    let j = i + 1;
    while (j < n && !'`*_[\\'.includes(text[j]!)) j++;
    pushPlain(text.slice(i, j), {});
    i = j;
  }
  return out;
}

// ═══════ 辅助 ═══════

function makeCell(char: string, style: Style): Cell {
  return { char, style };
}
function makeCells(text: string, style: Style): Cell[] {
  return [...text].map(ch => ({ char: ch, style }));
}
/** 缩进空格 */
function pad(n: number): Cell[] {
  return Array.from({ length: n }, () => ({ char: ' ', style: {} }));
}
/** 合并两个样式（后者覆盖前者） */
function merge(base: Style, override: Style): Style {
  const out: Style = { ...base };
  if (override.fg) out.fg = override.fg;
  if (override.bg) out.bg = override.bg;
  if (override.bold) out.bold = override.bold;
  if (override.dim) out.dim = override.dim;
  if (override.italic) out.italic = override.italic;
  if (override.underline) out.underline = override.underline;
  return out;
}
/** 把含换行的 cells 按 \n 拆成多行 */
function splitCellsByLine(cells: Cell[]): Cell[][] {
  const lines: Cell[][] = [[]];
  for (const c of cells) {
    if (c.char === '\n') lines.push([]);
    else lines[lines.length - 1]!.push(c);
  }
  return lines;
}

// ═══════ 表格解析 ═══════

/** 解析表格行数组 → 每行的 cells（带对齐）。 */
function parseTable(lines: string[], cols: number, streaming: boolean): Cell[][] {
  // 解析所有行的单元格
  const rows: string[][] = [];
  let isSeparator: boolean[] = [];
  for (const line of lines) {
    // 跳过分隔行 |---|---|
    if (/^\s*\|?\s*[-:]+[-| :]*$/.test(line.trim())) {
      isSeparator.push(true);
      continue;
    }
    isSeparator.push(false);
    // 按 | 分割，去掉首尾空列
    const cells = line.split('|').map(c => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells[cells.length - 1] === '') cells.pop();
    rows.push(cells);
  }

  if (rows.length === 0) return [];

  // 计算每列最大宽度
  const colCount = Math.max(...rows.map(r => r.length));
  const colWidths: number[] = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let ci = 0; ci < row.length; ci++) {
      colWidths[ci] = Math.max(colWidths[ci]!, [...row[ci]!].length);
    }
  }

  // 渲染每行
  const out: Cell[][] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const isHeader = ri === 0;
    const row = rows[ri]!;
    const cells: Cell[] = [];
    const sty = isHeader ? STY_TABLE_HEADER : {};
    cells.push(...makeCells('│ ', STY_TABLE_BORDER));
    for (let ci = 0; ci < colCount; ci++) {
      const text = (row[ci] ?? '').padEnd(colWidths[ci]!);
      const content = streaming ? makeCells(text, sty) : parseInline(text, { base: sty });
      cells.push(...content);
      cells.push(...makeCells(' │ ', STY_TABLE_BORDER));
    }
    out.push(cells);

    // 表头后加分隔行
    if (isHeader) {
      const sep: Cell[] = [];
      sep.push(...makeCells('├─', STY_TABLE_BORDER));
      for (let ci = 0; ci < colCount; ci++) {
        sep.push(...makeCells('─'.repeat(colWidths[ci]!), STY_TABLE_BORDER));
        if (ci < colCount - 1) sep.push(...makeCells('─┼─', STY_TABLE_BORDER));
      }
      sep.push(...makeCells('─┤', STY_TABLE_BORDER));
      out.push(sep);
    }
  }
  return out;
}
