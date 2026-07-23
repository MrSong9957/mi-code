// scripts/tty-verify/screen.js
//
// 最小 ANSI 屏幕缓冲区模拟器:把真实终端(ConPTY)的 ANSI 输出流还原成
// "最终可见屏幕"的行列矩阵,供 headless 验收断言。
//
// 物理本质:模拟一个终端的屏幕缓冲区(cells[row][col] = char),
// 逐字节应用 CSI 序列(光标定位/清屏/清行/SGR)和字符写入,最后 dump 成文本。
//
// 支持范围(聚焦项目 Ink 实际输出的 CSI 子集,不过度设计):
//   - CSI H / f        光标定位(可带 row;col)
//   - CSI A/B/C/D      光标上/下/右/左移
//   - CSI J            清屏(0 光标到尾,1 头到光标,2 全屏,3 scrollback)
//   - CSI K            清行(0 光标到行尾,1 行首到光标,2 整行)
//   - CSI S/T          滚动
//   - CSI ?25 h/l      光标显隐(忽略,不影响内容)
//   - CSI ?1049 h/l    交替屏(简化:忽略,主屏内容保留)
//   - CSI ?2004 h/l    括号粘贴(忽略)
//   - SGR (CSI ... m)  颜色(记录但不影响文本布局)
//   - CJK 宽字符:占 2 列(简化:按字符 displayWidth)
//   - \r \n \b         回车/换行/退格
//
// 不支持(项目不用):字符集、DEC 私有模式(除上述)、6 行状态行等。

module.exports.Screen = class Screen {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
    this.curRow = 0;
    this.curCol = 0;
  }

  /** 写入一块 ANSI 数据(可含多个序列+文本)。 */
  write(data) {
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        // CSI 序列:\x1b[ params final
        if (data[i + 1] === '[') {
          let j = i + 2;
          while (j < data.length && !/[A-Za-z]/.test(data[j])) j++;
          const final = data[j] ?? '';
          const params = data.slice(i + 2, j);
          this._csi(params, final);
          i = j + 1;
          continue;
        }
        // 其他 ESC 序列(如 \x1b 单独、OSC \x1b]),跳到 BEL 或 ST
        if (data[i + 1] === ']') {
          let j = i + 2;
          while (j < data.length && data[j] !== '\x07' && !(data[j] === '\x1b' && data[j + 1] === '\\')) j++;
          i = data[j] === '\x07' ? j + 1 : j + 2;
          continue;
        }
        i += 2;
        continue;
      }
      // 控制字符
      if (ch === '\r') { this.curCol = 0; i++; continue; }
      if (ch === '\n') { this._newline(); i++; continue; }
      if (ch === '\b') { if (this.curCol > 0) this.curCol--; i++; continue; }
      if (ch === '\t') { this.curCol = Math.min(this.cols - 1, (Math.floor(this.curCol / 8) + 1) * 8); i++; continue; }
      if (ch < ' ') { i++; continue; }
      // 普通字符写入
      this._putChar(ch);
      i++;
    }
  }

  _putChar(ch) {
    if (this.curCol >= this.cols) { this.curCol = 0; this._newline(); }
    if (this.curRow >= this.rows) { this._scrollUp(this.curRow - this.rows + 1); }
    const row = this.cells[Math.min(this.curRow, this.rows - 1)];
    row[this.curCol] = ch;
    // CJK 宽字符占 2 列(简化:用 BMP 范围粗判)
    const w = ch.codePointAt(0) >= 0x1100 && (
      ch.codePointAt(0) <= 0x115f ||  // Hangul Jamo
      (ch.codePointAt(0) >= 0x2e80 && ch.codePointAt(0) <= 0x9fff) ||  // CJK
      (ch.codePointAt(0) >= 0xac00 && ch.codePointAt(0) <= 0xd7a3) ||  // Hangul Syllables
      (ch.codePointAt(0) >= 0xf900 && ch.codePointAt(0) <= 0xfaff) ||  // CJK Compat
      (ch.codePointAt(0) >= 0xff00 && ch.codePointAt(0) <= 0xff60) ||  // Fullwidth Forms
      (ch.codePointAt(0) >= 0xffe0 && ch.codePointAt(0) <= 0xffe6)
    ) ? 2 : 1;
    if (w === 2 && this.curCol + 1 < this.cols) row[this.curCol + 1] = '\u0000';  // 占位
    this.curCol += w;
  }

  _newline() {
    this.curRow++;
    if (this.curRow >= this.rows) this._scrollUp(this.curRow - this.rows + 1);
    this.curRow = Math.min(this.curRow, this.rows - 1);
  }

  _scrollUp(n) {
    for (let k = 0; k < n; k++) {
      this.cells.shift();
      this.cells.push(Array.from({ length: this.cols }, () => ''));
    }
    this.curRow -= n;
    if (this.curRow < 0) this.curRow = 0;
  }

  _csi(params, final) {
    const privateMode = params.startsWith('?');
    const nums = params.replace(/[?]/g, '').split(';').map(x => x === '' ? 0 : parseInt(x, 10));
    const n0 = nums[0] ?? 0;
    const n1 = nums[1] ?? 0;

    if (privateMode) {
      // ?25h/l 光标显隐, ?1049h/l 交替屏, ?2004 括号粘贴 —— 均忽略(不影响内容)
      return;
    }

    switch (final) {
      case 'H': case 'f':
        this.curRow = Math.max(0, Math.min(this.rows - 1, (n0 || 1) - 1));
        this.curCol = Math.max(0, Math.min(this.cols - 1, (n1 || 1) - 1));
        break;
      case 'A': this.curRow = Math.max(0, this.curRow - (n0 || 1)); break;
      case 'B': this.curRow = Math.min(this.rows - 1, this.curRow + (n0 || 1)); break;
      case 'C': this.curCol = Math.min(this.cols - 1, this.curCol + (n0 || 1)); break;
      case 'D': this.curCol = Math.max(0, this.curCol - (n0 || 1)); break;
      case 'G': this.curCol = Math.max(0, Math.min(this.cols - 1, (n0 || 1) - 1)); break;
      case 'd': this.curRow = Math.max(0, Math.min(this.rows - 1, (n0 || 1) - 1)); break;
      case 'J': this._eraseDisplay(n0); break;
      case 'K': this._eraseLine(n0); break;
      case 'S': this._scrollUp(n0 || 1); break;
      case 'T': break;  // 下滚,简化忽略
      case 'm': break;  // SGR 颜色,不影响文本
      default: break;   // 未知序列忽略
    }
  }

  _eraseDisplay(mode) {
    if (mode === 0) {
      // 光标到尾
      this._eraseLinePart(this.curCol, this.cols, this.curRow);
      for (let r = this.curRow + 1; r < this.rows; r++) this._eraseLinePart(0, this.cols, r);
    } else if (mode === 1) {
      // 头到光标
      for (let r = 0; r < this.curRow; r++) this._eraseLinePart(0, this.cols, r);
      this._eraseLinePart(0, this.curCol + 1, this.curRow);
    } else if (mode === 2 || mode === 3) {
      // 全屏
      for (let r = 0; r < this.rows; r++) this._eraseLinePart(0, this.cols, r);
    }
  }

  _eraseLine(mode) {
    if (mode === 0) this._eraseLinePart(this.curCol, this.cols, this.curRow);
    else if (mode === 1) this._eraseLinePart(0, this.curCol + 1, this.curRow);
    else if (mode === 2) this._eraseLinePart(0, this.cols, this.curRow);
  }

  _eraseLinePart(from, to, row) {
    if (row < 0 || row >= this.rows) return;
    for (let c = from; c < to && c < this.cols; c++) this.cells[row][c] = '';
  }

  /** dump 成文本(每行 trimEnd,trailing 空行去掉),含占位符还原。 */
  toString() {
    return this.cells
      .map(row => row.map(c => c === '\u0000' ? '' : c).join(''))
      .map(l => l.replace(/\s+$/g, ''))
      .join('\n')
      .replace(/\n+$/g, '');  // 去尾空行
  }
}
