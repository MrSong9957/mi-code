// 字符池：字符串 → 整数 ID，帧间复用，整数比较替代字符串比较
export class CharPool {
  private strings: string[] = [' ', ''];
  private map = new Map<string, number>([[' ', 0], ['', 1]]);
  private ascii = new Int32Array(128).fill(-1);

  constructor() {
    this.ascii[32] = 0; // space
  }

  intern(char: string): number {
    if (char.length === 1) {
      const code = char.charCodeAt(0);
      if (code < 128) {
        const cached = this.ascii[code]!;
        if (cached !== -1) return cached;
        const idx = this.strings.length;
        this.strings.push(char);
        this.ascii[code] = idx;
        return idx;
      }
    }
    const existing = this.map.get(char);
    if (existing !== undefined) return existing;
    const idx = this.strings.length;
    this.strings.push(char);
    this.map.set(char, idx);
    return idx;
  }

  get(index: number): string {
    return this.strings[index] ?? ' ';
  }
}

// 样式池：ANSI 颜色代码 → 整数 ID
export class StylePool {
  private codes: string[] = [''];
  private map = new Map<string, number>([['', 0]]);

  intern(code: string): number {
    const existing = this.map.get(code);
    if (existing !== undefined) return existing;
    const idx = this.codes.length;
    this.codes.push(code);
    this.map.set(code, idx);
    return idx;
  }

  get(index: number): string {
    return this.codes[index] ?? '';
  }
}
