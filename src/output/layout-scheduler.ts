// src/output/layout-scheduler.ts
// 布局调度器（内容增长模型）
//
// 物理本质：排版师。
// 把内容（文字）和框架（边框、输入框、状态栏）安排到正确的位置。
// 内容超出页面时，自动把旧内容滚到上面（scrollback）。

import type { TermSize } from './types.js';

/** 布局区域 */
export interface LayoutArea {
  startY: number;
  height: number;
}

/** 完整布局 */
export interface Layout {
  messageArea: LayoutArea;
  border: { topY: number; bottomY: number };
  inputArea: LayoutArea;
  statusBar: { y: number };
  viewportY: number;
  contentHeight: number;
}

/** 布局参数 */
export interface LayoutParams {
  messageLines: number;
  inputLines: number;
}

/** 边框高度 */
const BORDER_HEIGHT = 2; // 上边框 + 下边框

/** 状态栏高度 */
const STATUS_BAR_HEIGHT = 1;

export class LayoutScheduler {
  private termSize: TermSize;

  constructor(termSize: TermSize) {
    this.termSize = termSize;
  }

  /**
   * 更新终端尺寸
   */
  updateTermSize(size: TermSize): void {
    this.termSize = size;
  }

  /**
   * 计算布局
   *
   * 物理本质：排版师规划页面布局。
   * 1. 消息区在上方（高度随内容变化）
   * 2. 边框分隔消息区和输入区
   * 3. 输入区在下方（高度固定）
   * 4. 状态栏在最底部
   * 5. 内容超出时，viewport 取最后 N 行
   */
  calculateLayout(params: LayoutParams): Layout {
    const { messageLines, inputLines } = params;
    const { rows } = this.termSize;

    // 计算页脚高度（边框 + 输入区 + 状态栏）
    const footerHeight = BORDER_HEIGHT + inputLines + STATUS_BAR_HEIGHT;

    // 内容总高度（消息 + 页脚）
    const contentHeight = messageLines + footerHeight;

    // 计算 viewportY（已进 scrollback 的行数）
    const viewportY = this.getViewportY(contentHeight);

    // 消息区布局
    const messageArea: LayoutArea = {
      startY: 0,
      height: messageLines,
    };

    // 边框布局
    const border = {
      topY: messageLines,
      bottomY: messageLines + 1 + inputLines,
    };

    // 输入区布局
    const inputArea: LayoutArea = {
      startY: messageLines + 1, // 上边框之后
      height: inputLines,
    };

    // 状态栏布局
    const statusBar = {
      y: messageLines + BORDER_HEIGHT + inputLines,
    };

    return {
      messageArea,
      border,
      inputArea,
      statusBar,
      viewportY,
      contentHeight,
    };
  }

  /**
   * 计算 viewportY（已进 scrollback 的行数）
   *
   * 物理本质：计算有多少行已经被滚到看不见的地方。
   * viewportY = max(0, contentHeight - termRows)
   *
   * 这是 Claude Code log-update.ts 的核心算法：
   * - 内容少于一屏时，viewportY = 0（从第一行开始显示）
   * - 内容多于一屏时，viewportY > 0（旧内容滚进 scrollback）
   */
  getViewportY(contentHeight: number): number {
    return Math.max(0, contentHeight - this.termSize.rows);
  }
}
