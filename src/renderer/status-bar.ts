// 状态栏内容拼装
//
// 物理本质：把"当前在用什么模型、在哪个分支、正在跑什么工具"这些状态，
// 拼成一行格子（cells），钉在屏幕底部状态栏那一行。
// 整体低调（dim），工具运行中的标记醒目（彩色）。

import { stringToCells, truncateToWidth, type Cell, type Style } from './cell.js';

export interface ToolStatus {
  name: string;
  status: 'running' | 'done' | 'error';
}

export interface StatusBarState {
  /** 模式（Plan / Act 等） */
  mode?: string;
  model: string;
  branch: string;
  /** 可选：短目录名 */
  dir?: string;
  /** 可选：当前工具状态（来自 StreamEventBus） */
  tool?: ToolStatus;
  /** 上下文窗口使用率 0-1 */
  contextUsage?: number;
  /** 终端列数（用于截断） */
  cols: number;
  /** 可选：自定义提示文本（如 todo 提醒） */
  hint?: string;
}

// 状态栏配色：truecolor RGB（绕过终端配色映射）+ bold 提亮
// 全部高亮度 RGB 值（每通道 >= 180），确保深色背景下高对比可读
// 注意：不用 dim 属性——dim 是粘性的，会污染后续段的渲染
const SEP: Style = { fg: 'rgb:140,140,140' };               // 分隔符 │ 中灰（不用 dim）
const MODE: Style = { fg: 'rgb:120,230,230', bold: true };   // 模式 —— 高亮 cyan
const MODEL: Style = { fg: 'rgb:140,190,255', bold: true };  // 模型名 —— 高亮 blue
const DIR: Style = { fg: 'rgb:235,235,235', bold: true };    // 路径 —— 高亮白
const BRANCH: Style = { fg: 'rgb:255,225,110', bold: true }; // git 分支 —— 高亮 yellow
const TOOL_RUN: Style = { fg: 'rgb:255,225,110', bold: true };   // 工具运行中
const TOOL_DONE: Style = { fg: 'rgb:140,235,140', bold: true };  // 工具完成
const ERR: Style = { fg: 'rgb:255,130,150', bold: true };        // 错误
const BAR_FILL: Style = { fg: 'rgb:120,230,230', bold: true };   // 进度条填充
const BAR_EMPTY: Style = { fg: 'rgb:140,140,140' };              // 进度条空白
const HINT: Style = { fg: 'rgb:140,235,140', bold: true };       // 提示

/** 构建进度条文本（10 格 + 百分比） */
function buildProgressBar(ratio: number, totalWidth = 10): string {
  const pct = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(pct * totalWidth);
  const empty = totalWidth - filled;
  const pctStr = `${Math.round(pct * 100)}%`;
  return '█'.repeat(filled) + '░'.repeat(empty) + ' ' + pctStr;
}

/** 由状态构建状态栏一行的 cells。格式：mode | model | dir | branch | progress */
export function buildStatusBar(state: StatusBarState): Cell[] {
  if (state.cols <= 0) return [];

  const sep = ' │ ';
  const segments: Array<{ text: string; style: Style }> = [];

  // 工具状态（若有，放在最前，最醒目）
  if (state.tool) {
    const mark = state.tool.status === 'running' ? '⏳'
      : state.tool.status === 'error' ? '✗'
        : '✓';
    const sty = state.tool.status === 'running' ? TOOL_RUN
      : state.tool.status === 'error' ? ERR
        : TOOL_DONE;
    segments.push({ text: `${mark} ${state.tool.name}`, style: sty });
    segments.push({ text: sep, style: SEP });
  }

  // 模式
  if (state.mode) {
    segments.push({ text: state.mode, style: MODE });
    segments.push({ text: sep, style: SEP });
  }

  // 模型
  segments.push({ text: state.model, style: MODEL });
  segments.push({ text: sep, style: SEP });

  // 路径（最后 2 个层级）
  if (state.dir) {
    const parts = state.dir.replace(/\\/g, '/').split('/').filter(Boolean);
    const short = parts.slice(-2).join('/');
    segments.push({ text: '~/' + short, style: DIR });
    segments.push({ text: sep, style: SEP });
  }

  // 分支
  segments.push({ text: state.branch, style: BRANCH });

  // 上下文窗口进度条
  if (state.contextUsage !== undefined) {
    segments.push({ text: sep, style: SEP });
    const bar = buildProgressBar(state.contextUsage);
    segments.push({ text: bar, style: BAR_FILL });
  }

  // 提示
  if (state.hint) {
    segments.push({ text: sep, style: SEP });
    segments.push({ text: state.hint, style: HINT });
  }

  // 拼成 cells
  let cells: Cell[] = [];
  for (const seg of segments) {
    cells = cells.concat(stringToCells(seg.text, seg.style));
  }

  return truncateToWidth(cells, state.cols);
}
