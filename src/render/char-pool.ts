// src/render/char-pool.ts
// 字符池：跨帧累积 + Map 去重 + ASCII 快速路径。
// spec §3.2 + §3.6 铁律 4（blit 是唯一生产点的下游消费者）。
//
// 同一字符只存一次（返回相同 charId）。ASCII（charCode < 128）走数组快速路径，
// 其余（CJK/emoji/多字节）走 Map。

export class CharPool {
  /** charId → 字符串；index 0 = 空白占位 */
  private chars: string[] = [''];
  /** 非 ASCII 字符 → charId（ASCII 走 asciiTable） */
  private byChar: Map<string, number> = new Map();
  /** ASCII 快速路径表：charCode(0-127) → charId；-1 = 未存 */
  private asciiTable: Int32Array = new Int32Array(128).fill(-1);

  /** 把字符 intern 进池，返回 charId */
  intern(s: string): number {
    if (s === '') return 0;
    // ASCII 快速路径（仅单字符 + charCode < 128）
    if (s.length === 1) {
      const code = s.charCodeAt(0);
      if (code < 128) {
        const cached = this.asciiTable[code]!;
        if (cached >= 0) return cached;
        const id = this.chars.length;
        this.chars.push(s);
        this.asciiTable[code] = id;
        return id;
      }
    }
    // Map 路径（CJK/emoji/多字节）
    let id = this.byChar.get(s);
    if (id === undefined) {
      id = this.chars.length;
      this.chars.push(s);
      this.byChar.set(s, id);
    }
    return id;
  }

  /** 取字符；不存在返回空格（防御） */
  get(id: number): string {
    return this.chars[id] ?? ' ';
  }

  /** 当前池条目数（含 index 0 空白） */
  size(): number {
    return this.chars.length;
  }

  /**
   * 把本池的某个 id 迁移到新池（用于 resetPools）。
   * 用旧池的字符在新池里 intern，返回新 id。
   * 同字符多次迁移自动复用（新池去重）。
   */
  migrate(oldId: number, fresh: CharPool): number {
    if (oldId === 0) return 0;  // 空白占位直接映射
    return fresh.intern(this.get(oldId));
  }
}
