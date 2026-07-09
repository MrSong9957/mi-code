// src/tui/selection/row-text-map.ts
// 统一行文本映射：屏幕全局行 → 该行完整文本（跨 LOGO/消息/边框/输入/状态栏）。
//
// 物理本质：全屏选区的「文本真相源」。鼠标选区坐标是屏幕全局行，
// 复制时要从任意区域（LOGO、消息、边框、输入框、状态栏）提取文本。
// 本模块把分散在各组件的数据汇总成一张「行→文本」表。
//
// 行布局（自上而下，行号 0-based 全局）：
//   [0, LOGO_ROWS-1]                          LOGO（3 行 ASCII art + version/dir）
//   [LOGO_ROWS, footerTopRow-1]               消息区（按 scrollTop 偏移取 messages[].lines）
//   footerTopRow                              上边框 ─×cols
//   [inputRowY, inputRowY+inputLineCount-1]   输入行（首行 ❯ + input，多行按 \n 拆）
//   inputRowY + inputLineCount                下边框 ─×cols
//   最后一行                                   状态栏
//
// 注意：inputRowY 由调用方（App.tsx）算好传入（含 spinner/completion 偏移），
// 本模块不自己猜 spinner 行——spinner/completion 是否激活只影响 inputRowY 的计算（在 App 里）。

import type { TuiMessage } from '../types.js';
import type { StatusBarData } from '../types.js';

/** LOGO 占的行数（与 App.tsx LOGO_ROWS 一致） */
const LOGO_ROWS = 3;

/** 进度条宽度（与 StatusBar.tsx BAR_WIDTH 一致） */
const BAR_WIDTH = 10;

export interface RowTextMap {
  /** 屏幕全局行 → 该行完整文本；null=该行无文本/不可选/越界 */
  getLineContent: (row: number) => string | null;
  /** 总行数（= rows） */
  readonly totalRows: number;
}

export interface RowTextMapParams {
  rows: number;
  cols: number;
  logo: { version: string; dir: string };
  messages: TuiMessage[];
  /** ScrollBox 当前 scrollTop */
  scrollTop: number;
  /** ScrollBox 可见行数 */
  visibleRows: number;
  /** 输入文本（可能多行，含 \n） */
  input: string;
  /** 输入行（首行）的全局 y 坐标（已含 spinner/completion 偏移，由 App 算） */
  inputRowY: number;
  status: StatusBarData;
  /** spinner 是否激活（影响 inputRowY 计算，本模块不直接用，预留） */
  spinnerActive: boolean;
  /** 补全条是否可见（影响 inputRowY 计算，本模块不直接用，预留） */
  completionVisible: boolean;
}

/** LOGO 3 行模板（与 LogoBox.tsx 逐字符一致） */
function logoLine(row: number, logo: { version: string; dir: string }): string {
  switch (row) {
    case 0: return ` ▐▛███▜▌   MiCode v${logo.version}`;
    case 1: return '▝▜█████▛▘  TypeScript CLI · Node.js Runtime';
    case 2: return `  ▘▘ ▝▝    ${logo.dir}`;
    default: return '';
  }
}

/** 状态栏组合字符串（与 StatusBar.tsx 渲染一致） */
function statusBarText(status: StatusBarData): string {
  const clamped = Math.max(0, Math.min(1, status.contextPct));
  const filled = Math.round(clamped * BAR_WIDTH);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
  const label = `${Math.round(clamped * 100)}%`;
  return `${status.mode} │ ${status.model} │ ${status.dir} │ ${status.branch} │ ${bar} ${label}`;
}

/** 多行 input 拆成行数组（首行渲染时带 prompt，由调用方加） */
function inputLines(input: string): string[] {
  return input.split('\n');
}

/** 构建统一行文本映射 */
export function buildRowTextMap(params: RowTextMapParams): RowTextMap {
  const { rows, cols, logo, messages, scrollTop, input, inputRowY, status } = params;
  const borderText = '─'.repeat(Math.max(0, cols));
  const inputSplit = inputLines(input);
  const inputLineCount = inputSplit.length;
  const upperBorderRow = inputRowY - 1;
  const lowerBorderRow = inputRowY + inputLineCount;
  const statusBarRow = lowerBorderRow + 1;
  const sbText = statusBarText(status);

  /** 消息带行 → 文本（跳过流式块）。
   *  滚动语义：scrollTop = 隐藏在顶部的消息行数；屏幕行 LOGO_ROWS 显示消息索引 scrollTop。
   *  故 flatRow = row - LOGO_ROWS + scrollTop（消息在 messages 拉平后的索引）。 */
  function messageLineText(row: number): string | null {
    const flatRow = row - LOGO_ROWS + scrollTop;
    if (flatRow < 0) return null;
    let acc = 0;
    for (const msg of messages) {
      if (!msg.finalized) continue; // 流式块不可定位
      if (flatRow < acc + msg.lines.length) {
        return msg.lines[flatRow - acc]?.content ?? null;
      }
      acc += msg.lines.length;
    }
    return null;
  }

  function getLineContent(row: number): string | null {
    if (row < 0 || row >= rows) return null;

    // LOGO 带
    if (row < LOGO_ROWS) {
      return logoLine(row, logo);
    }

    // 上边框
    if (row === upperBorderRow) {
      return borderText;
    }

    // 输入带（首行带 prompt，续行不带）
    if (row >= inputRowY && row < inputRowY + inputLineCount) {
      const idx = row - inputRowY;
      return idx === 0 ? `❯ ${inputSplit[idx] ?? ''}` : (inputSplit[idx] ?? '');
    }

    // 下边框
    if (row === lowerBorderRow) {
      return borderText;
    }

    // 状态栏
    if (row === statusBarRow) {
      return sbText;
    }

    // 消息带（在 LOGO 之后、上边框之前）
    if (row > LOGO_ROWS - 1 && row < upperBorderRow) {
      return messageLineText(row);
    }

    // 其它（消息带空白区、Footer 之外的空行）
    return null;
  }

  return { getLineContent, totalRows: rows };
}
