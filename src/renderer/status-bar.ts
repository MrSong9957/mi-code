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

const DIM: Style = { dim: true };
// 状态栏配色：用 truecolor RGB（绕过终端配色方案映射，深底下颜色精确明亮）
// RGB 值对齐 Claude Code dark 主题的高亮色，确保深色背景下高对比可读
const SEP: Style = { fg: 'rgb:102,102,102' };              // 分隔符 │ 中灰（低调但不暗）
const MODE: Style = { fg: 'rgb:88,204,204', bold: true };   // 模式 —— 明亮 cyan
const MODEL: Style = { fg: 'rgb:110,170,255', bold: true }; // 模型名 —— 明亮 blue
const DIR: Style = { fg: 'rgb:220,220,220', bold: true };   // 路径 —— 明亮白
const BRANCH: Style = { fg: 'rgb:240,200,80', bold: true }; // git 分支 —— 明亮 yellow
const TOOL_RUN: Style = { fg: 'rgb:240,200,80', bold: true };   // 工具运行中 —— 明亮 yellow
const TOOL_DONE: Style = { fg: 'rgb:110,210,110', bold: true }; // 工具完成 —— 明亮 green
const ERR: Style = { fg: 'rgb:255,110,130', bold: true };       // 错误 —— 明亮 red
const BAR_FILL: Style = { fg: 'rgb:88,204,204', bold: true };   // 进度条填充 —— 明亮 cyan
const BAR_EMPTY: Style = { fg: 'rgb:102,102,102' };             // 进度条空白 —— 中灰
const HINT: Style = { fg: 'rgb:110,210,110', bold: true };      // 提示 —— 明亮 green

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
  segments.push({ text: sep, style: DIM });

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
