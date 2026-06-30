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
  /** 可选：思考状态 */
  thinking?: { elapsed: number; collapsed: boolean };
}

const DIM: Style = { dim: true };
const ACCENT: Style = { fg: 'cyan' };
const WARN: Style = { fg: 'yellow' };
const ERR: Style = { fg: 'red' };
const BAR_FILL: Style = { fg: 'cyan' };
const BAR_EMPTY: Style = { dim: true };

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

  // 思考状态（若有，放在最前）
  if (state.thinking) {
    if (state.thinking.collapsed) {
      segments.push({ text: `Thought for ${state.thinking.elapsed}s (ctrl+o to expand)`, style: DIM });
    } else {
      segments.push({ text: `● Thinking for ${state.thinking.elapsed}s… (ctrl+o to expand)`, style: {} });
    }
    segments.push({ text: sep, style: DIM });
  }

  // 工具状态（若有）
  if (state.tool) {
    const mark = state.tool.status === 'running' ? '⏳'
      : state.tool.status === 'error' ? '✗'
        : '✓';
    const sty = state.tool.status === 'running' ? WARN
      : state.tool.status === 'error' ? ERR
        : ACCENT;
    segments.push({ text: `${mark} ${state.tool.name}`, style: sty });
    segments.push({ text: sep, style: DIM });
  }

  // 模式
  if (state.mode) {
    segments.push({ text: state.mode, style: ACCENT });
    segments.push({ text: sep, style: DIM });
  }

  // 模型
  segments.push({ text: state.model, style: DIM });
  segments.push({ text: sep, style: DIM });

  // 路径（最后 2 个层级）
  if (state.dir) {
    const parts = state.dir.replace(/\\/g, '/').split('/').filter(Boolean);
    const short = parts.slice(-2).join('/');
    segments.push({ text: '~/' + short, style: DIM });
    segments.push({ text: sep, style: DIM });
  }

  // 分支
  segments.push({ text: state.branch, style: DIM });

  // 上下文窗口进度条
  if (state.contextUsage !== undefined) {
    segments.push({ text: sep, style: DIM });
    const bar = buildProgressBar(state.contextUsage);
    segments.push({ text: bar, style: BAR_FILL });
  }

  // 提示
  if (state.hint) {
    segments.push({ text: sep, style: DIM });
    segments.push({ text: state.hint, style: ACCENT });
  }

  // 拼成 cells
  let cells: Cell[] = [];
  for (const seg of segments) {
    cells = cells.concat(stringToCells(seg.text, seg.style));
  }

  return truncateToWidth(cells, state.cols);
}
