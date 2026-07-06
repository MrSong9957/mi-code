// src/render/style-pool.ts
// 样式池：跨帧累积 + Map 去重 + transition 缓存。
// spec §3.3：transition 预计算「样式 A → 样式 B」的 ANSI 串（带缓存）。
//
// transition 策略：简单稳健——从任意样式到目标样式，先 \x1b[0m 全 reset，
// 再叠加目标的所有属性。比增量 diff（关 A 的属性、开 B 的属性）简单且无遗漏，
// 字节略多但可读性高。后续 optimizer 可优化为增量。

import { DEFAULT_STYLE, type Style } from './types.js';

/** 把 Style 序列化为去重键 */
function styleKey(s: Style): string {
  return `${s.fg}|${s.bg}|${s.bold ?1:0}|${s.italic?1:0}|${s.underline?1:0}|${s.inverse?1:0}|${s.dim?1:0}|${s.strikethrough?1:0}`;
}

/** 把单个 Style 转 ANSI 序列（不含 reset） */
function styleToAnsi(s: Style): string {
  const parts: string[] = [];
  if (s.bold) parts.push('1');
  if (s.dim) parts.push('2');
  if (s.italic) parts.push('3');
  if (s.underline) parts.push('4');
  if (s.inverse) parts.push('7');
  if (s.strikethrough) parts.push('9');
  if (s.fg !== 0) {
    parts.push(`38;2;${(s.fg >> 16) & 0xFF};${(s.fg >> 8) & 0xFF};${s.fg & 0xFF}`);
  }
  if (s.bg !== 0) {
    parts.push(`48;2;${(s.bg >> 16) & 0xFF};${(s.bg >> 8) & 0xFF};${s.bg & 0xFF}`);
  }
  if (parts.length === 0) return '';
  return `\x1b[${parts.join(';')}m`;
}

export class StylePool {
  private styles: Style[] = [DEFAULT_STYLE];
  /** transition 缓存：key = fromId * capacity + toId */
  private transitions: Map<number, string> = new Map();
  private byKey: Map<string, number>;

  constructor() {
    this.byKey = new Map([[styleKey(DEFAULT_STYLE), 0]]);
  }

  intern(s: Style): number {
    const key = styleKey(s);
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push(s);
      this.byKey.set(key, id);
    }
    return id;
  }

  get(id: number): Style {
    return this.styles[id] ?? DEFAULT_STYLE;
  }

  size(): number {
    return this.styles.length;
  }

  /** 计算从 fromStyle 到 toStyle 的 ANSI 串（带缓存） */
  transition(fromId: number, toId: number): string {
    if (fromId === toId) return '';
    const key = fromId * this.styles.length + toId;
    let seq = this.transitions.get(key);
    if (seq === undefined) {
      const from = this.get(fromId);
      const to = this.get(toId);
      seq = computeAnsiTransition(from, to);
      this.transitions.set(key, seq);
    }
    return seq;
  }

  /** 把旧池 id 迁到新池（用于 resetPools） */
  migrate(oldId: number, fresh: StylePool): number {
    if (oldId === 0) return 0;
    return fresh.intern(this.get(oldId));
  }
}

/** from → to 的 ANSI 串：先 reset 再叠加目标属性 */
function computeAnsiTransition(from: Style, to: Style): string {
  const targetSeq = styleToAnsi(to);
  if (targetSeq === '') {
    // 目标是默认样式：仅需 reset
    return '\x1b[0m';
  }
  // 先 reset 再叠加（简单稳健，不增量 diff）
  return `\x1b[0m${targetSeq}`;
}
