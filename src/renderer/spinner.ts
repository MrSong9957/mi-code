// Spinner：旋转指示器（Braille 点阵帧 + stall 检测）
//
// 物理本质：一块会翻页的电子指示牌。
// 给它"我在干活"的信号（start），它就开始翻页（⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ 循环）。
// 每次调 tick() 翻到下一格；3 秒没人喂 token（onToken），牌子变红（stall 警告）。
// 调 stop() 牌子熄灭。
//
// Spinner 只管状态和渲染文本，不自己驱动 tick——由 Renderer 用 setInterval 调 tick。
// 颜色用 theme token（accent 正常 / error stall），由 cell.ts → colors.ts 解析。

import type { Style } from './cell.js';

/** Braille 点阵帧（10 帧，对齐 Claude Code 风格） */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** stall 阈值：3 秒无 onToken 判定停滞 */
const STALL_MS = 3000;

export interface SpinnerState {
  active: boolean;
  frameIndex: number;
  label: string;
  stalled: boolean;
}

export interface SpinnerRender {
  text: string;
  style: Style;
}

export class Spinner {
  private active = false;
  private frameIndex = 0;
  private label = '';
  private stalled = false;
  private lastTokenAt = 0;

  /** 启动 spinner，显示 label。重置帧索引和 stall 状态。 */
  start(label: string): void {
    this.active = true;
    this.label = label;
    this.frameIndex = 0;
    this.stalled = false;
    this.lastTokenAt = Date.now();
  }

  /** 停止 spinner（熄灭）。 */
  stop(): void {
    this.active = false;
    this.label = '';
    this.stalled = false;
    this.frameIndex = 0;
  }

  /** 运行中切换文案（不停 spinner）。 */
  setLabel(label: string): void {
    if (this.active) this.label = label;
  }

  /** 收到 token：重置 stall 计时器，恢复正常色。 */
  onToken(): void {
    if (!this.active) return;
    this.lastTokenAt = Date.now();
    this.stalled = false;
  }

  /** 推进一帧。inactive 时无操作。
   *  每次 tick 检查 stall：距上次 token 超过 STALL_MS 则标记 stalled。 */
  tick(): void {
    if (!this.active) return;
    this.frameIndex = (this.frameIndex + 1) % SPINNER_FRAMES.length;
    if (Date.now() - this.lastTokenAt > STALL_MS) {
      this.stalled = true;
    }
  }

  /** 是否正在运行。 */
  isActive(): boolean {
    return this.active;
  }

  /** 当前 label。 */
  getLabel(): string {
    return this.label;
  }

  /** 当前完整状态（测试/调试用）。 */
  getState(): SpinnerState {
    return {
      active: this.active,
      frameIndex: this.frameIndex,
      label: this.label,
      stalled: this.stalled,
    };
  }

  /** 渲染当前帧文本 + 样式。inactive 返回空。
   *  - 正常：accent 色 + "⠋ label"
   *  - stall：error 色（红色警告） */
  render(): SpinnerRender {
    if (!this.active) return { text: '', style: {} };
    const frame = SPINNER_FRAMES[this.frameIndex]!;
    const style: Style = this.stalled ? { fg: 'error' } : { fg: 'accent' };
    return { text: `${frame} ${this.label}`, style };
  }
}
