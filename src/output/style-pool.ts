// src/output/style-pool.ts
// 样式对象池（复用 + 快速比较）
//
// 物理本质：调色盘里的颜色卡。
// 相同样式只存一份，用 === 比较（O(1)），不用逐字段比较（O(n)）。
// 这是 Claude Code RenderOptimizer 的核心优化。

import type { OutputStyle } from './types.js';

/** 样式 key：相同样式必同串 */
function styleKey(style: OutputStyle | undefined): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.fg) parts.push('f' + style.fg);
  if (style.bg) parts.push('b' + style.bg);
  if (style.bold) parts.push('B');
  if (style.dim) parts.push('D');
  if (style.italic) parts.push('I');
  if (style.underline) parts.push('U');
  return parts.join('|');
}

export class StylePool {
  /** 样式缓存：key → 冻结的 Style 对象 */
  private pool = new Map<string, OutputStyle>();

  /** 空样式（单例） */
  private emptyStyle: OutputStyle;

  constructor() {
    this.emptyStyle = Object.freeze({});
    this.pool.set('', this.emptyStyle);
  }

  /**
   * 获取样式对象（复用已有，快速比较）
   *
   * 物理本质：从调色盘里找颜色卡。
   * 找到了直接用（=== 比较），找不到就新建一张存起来。
   */
  get(style: OutputStyle | undefined): OutputStyle {
    const key = styleKey(style);

    // 快速路径：空样式
    if (!key) return this.emptyStyle;

    // 查找缓存
    let cached = this.pool.get(key);
    if (!cached) {
      // 新建并冻结（不可变，安全复用）
      cached = Object.freeze({ ...style });
      this.pool.set(key, cached);
    }

    return cached;
  }

  /**
   * 生成 ANSI 转义序列（SGR）
   *
   * 物理本质：把颜色卡翻译成终端能懂的指令。
   */
  toAnsi(style: OutputStyle): string {
    if (!style || (!style.fg && !style.bg && !style.bold && !style.dim && !style.italic && !style.underline)) {
      return '';
    }

    const codes: string[] = [];

    // 样式属性
    if (style.bold) codes.push('1');
    if (style.dim) codes.push('2');
    if (style.italic) codes.push('3');
    if (style.underline) codes.push('4');

    // 前景色
    if (style.fg) {
      const fgCode = FG_MAP[style.fg];
      if (fgCode) codes.push(fgCode);
    }

    // 背景色
    if (style.bg) {
      const bgCode = BG_MAP[style.bg];
      if (bgCode) codes.push(bgCode);
    }

    if (codes.length === 0) return '';

    return `\x1b[${codes.join(';')}m`;
  }
}

/** 前景色映射 */
const FG_MAP: Record<string, string> = {
  black: '30', red: '31', green: '32', yellow: '33',
  blue: '34', magenta: '35', cyan: '36', white: '37',
  gray: '90', grey: '90',
  redBright: '91', greenBright: '92', yellowBright: '93', blueBright: '94',
  magentaBright: '95', cyanBright: '96', whiteBright: '97',
};

/** 背景色映射 */
const BG_MAP: Record<string, string> = {
  black: '40', red: '41', green: '42', yellow: '43',
  blue: '44', magenta: '45', cyan: '46', white: '47',
  gray: '100', grey: '100',
};
