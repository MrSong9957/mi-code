// 虚拟光标记账（VirtualScreen）
//
// 物理本质：自己手里备一张小地图，记下"我认为打印头现在在 (x,y)"。
// 每次发指令让它动了，就在小地图上同步更新坐标。下次让它去别处，
// 只在小地图上算"从当前位置相对走几步"，然后只发相对指令（CUU/CUD/CUF/CUB），
// 绝不发绝对坐标——对起点不敏感（文档§2.3 铁律、§3.1）。
//
// 这是整套光标协调机制的命门：不信任终端真实光标，自己记账，只发相对移动。

import { cursorMove, eraseLine as eraseLineSeq, cr } from './ansi.js';
import { styleTransitionByKey, styleKey, type Cell } from './cell.js';
import { stringWidth } from './cell.js';

export interface Point {
  x: number;
  y: number;
}

export class VirtualScreen {
  /** 自记的虚拟光标位置（列 x，行 y） */
  cursor: Point;
  /** 当前已生效的样式 key（用于只在变化时发 SGR） */
  private currentStyleKey = '';
  private buffer = '';

  constructor(start: Point = { x: 0, y: 0 }) {
    this.cursor = { ...start };
  }

  /**
   * 把虚拟光标搬到目标点，只发相对指令（文档§3.1 moveCursorTo 同思路）。
   * 若已在目标点则不发任何指令。
   */
  moveTo(targetX: number, targetY: number): void {
    const dx = targetX - this.cursor.x;
    const dy = targetY - this.cursor.y;
    if (dx === 0 && dy === 0) return;
    this.buffer += cursorMove(dx, dy);
    this.cursor.x = targetX;
    this.cursor.y = targetY;
  }

  /**
   * 在当前光标位置写一个格子（字符 + 样式），并把光标右移该字符宽度。
   * 只在样式真正变化时才发 SGR（styleTransition），同样式连续格子之间零样式字节。
   * 调用方应先 moveTo 到目标格。
   */
  writeCell(cell: Cell): void {
    const nextKey = styleKey(cell.style);
    if (nextKey !== this.currentStyleKey) {
      this.buffer += styleTransitionByKey(this.currentStyleKey, nextKey);
      this.currentStyleKey = nextKey;
    }
    this.buffer += cell.char;
    this.cursor.x += stringWidth(cell.char);
  }

  /** 擦当前整行：回行首 + eraseLine。光标 x 归 0。 */
  eraseLine(): void {
    this.buffer += cr() + eraseLineSeq();
    this.cursor.x = 0;
  }

  /**
   * 换行推进：CR + LF。光标下移一行（y+1，x 归 0）。
   * 关键：用 LF 而非 cursor-down（CUD）——LF 在终端视口底部会**触发滚动**（顶行进 scrollback），
   * 而 CUD 在底部静默失败、不滚动。这是主屏增长模型让内容滚进 scrollback 的核心机制
   * （对齐 Claude Code log-update.ts:543-560 renderFrameSlice 的做法）。
   */
  lineFeed(): void {
    this.buffer += cr() + '\n';
    this.cursor.x = 0;
    this.cursor.y += 1;
  }

  /** 追加任意原始字符串（如 CUP 等绝对指令），不改变记账坐标需调用方自行 reset。 */
  raw(s: string): void {
    this.buffer += s;
  }

  /** 取出累积的指令串并清空缓冲。 */
  flush(): string {
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /** 取出累积的指令串但不清空（用于检查/测试）。 */
  toString(): string {
    return this.buffer;
  }

  /** 重置：清空缓冲、光标坐标、当前样式跟踪（用于 fullReset 后重新对零点）。 */
  reset(point: Point = { x: 0, y: 0 }): void {
    this.buffer = '';
    this.cursor = { ...point };
    this.currentStyleKey = '';
  }
}
