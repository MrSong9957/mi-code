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
  model: string;
  branch: string;
  /** 可选：短目录名 */
  dir?: string;
  /** 可选：当前工具状态（来自 StreamEventBus） */
  tool?: ToolStatus;
  /** 终端列数（用于截断） */
  cols: number;
  /** 可选：自定义提示文本（如 todo 提醒） */
  hint?: string;
}

const DIM: Style = { dim: true };
const ACCENT: Style = { fg: 'cyan' };
const WARN: Style = { fg: 'yellow' };
const ERR: Style = { fg: 'red' };

/** 由状态构建状态栏一行的 cells。结果按 cols 截断。 */
export function buildStatusBar(state: StatusBarState): Cell[] {
  if (state.cols <= 0) return [];

  const segments: Array<{ text: string; style: Style }> = [];

  // 工具状态（若有，放在最前，最醒目）
  if (state.tool) {
    const mark = state.tool.status === 'running' ? '⏳'
      : state.tool.status === 'error' ? '✗'
        : '✓';
    const sty = state.tool.status === 'running' ? WARN
      : state.tool.status === 'error' ? ERR
        : ACCENT;
    segments.push({ text: `${mark} ${state.tool.name}`, style: sty });
    segments.push({ text: '  ', style: DIM });
  }

  // 模型
  segments.push({ text: state.model, style: DIM });
  // 分隔
  segments.push({ text: ' · ', style: DIM });
  // 分支
  segments.push({ text: `⎇ ${state.branch}`, style: DIM });
  if (state.dir) {
    segments.push({ text: ' · ', style: DIM });
    segments.push({ text: state.dir, style: DIM });
  }
  if (state.hint) {
    segments.push({ text: ' · ', style: DIM });
    segments.push({ text: state.hint, style: ACCENT });
  }

  // 拼成 cells
  let cells: Cell[] = [];
  for (const seg of segments) {
    cells = cells.concat(stringToCells(seg.text, seg.style));
  }

  // 按 cols 截断（不溢出状态栏）
  return truncateToWidth(cells, state.cols);
}
