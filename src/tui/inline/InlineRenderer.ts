import { cursorUp, hideCursor, showCursor } from './ansi-utils.js';
import { enterAltScreen, exitAltScreen } from '../hooks/useAltScreen.js';
import { cursorScreenPos } from '../state/cursor-position.js';

const PROMPT = '❯ ';

export class InlineRenderer {
  /** footer 占用的行数。0 表示无 footer 或已 commit。 */
  private footerHeight = 0;
  /** 光标所在行到 footer 顶部的距离（用于 commitFooter 精确上移）。 */
  private cursorToTop = 0;

  constructor(private stdout: NodeJS.WriteStream) {}

  appendLine(ansiText: string): void {
    this.stdout.write(ansiText + '\n');
  }

  rewriteCurrentLine(ansiText: string): void {
    this.stdout.write('\r\x1b[K' + ansiText);
  }

  /**
   * 渲染 footer。
   *
   * 调用契约：
   * - footerHeight=0 时：直接追加（首次或 commit 后）
   * - footerHeight>0 时：覆写旧 footer（光标必须在 footer 区域内）
   *
   * InlineApp 保证：有新消息时先 commitFooter()（清零 footerHeight），
   * 再写消息，再调用本方法。无新消息时直接调用本方法覆写。
   */
  renderFooter(input: string, cursorPos: number, statusText: string, cols: number = 80): void {
    const inputLines = input.split('\n');
    const border = '─'.repeat(cols);
    const newHeight = 2 + inputLines.length + 1;

    const lines: string[] = [border];
    for (let i = 0; i < inputLines.length; i++) {
      lines.push((i === 0 ? PROMPT : '') + inputLines[i]);
    }
    lines.push(border);
    lines.push(statusText);

    if (this.footerHeight === 0) {
      // 追加模式
      for (const line of lines) {
        this.stdout.write(line + '\n');
      }
    } else {
      // 覆写模式：光标在 footer 的输入框行
      // 上移到 footer 顶部（border 行）
      const inputLineIndex = inputLines.length - 1;
      const offsetToTop = 1 + inputLineIndex; // border + input 行偏移
      this.stdout.write(cursorUp(offsetToTop));

      // 逐行覆写。最后一行也补 \n，使光标停在 footer 下方一行，
      // 与追加模式结尾的光标基准对齐（见 upFromBottom 计算），
      // 否则每次覆写后光标会向上漂移 1 行，导致旧 footer 残留、状态栏重复。
      for (let i = 0; i < this.footerHeight; i++) {
        const content = i < lines.length ? lines[i] : '';
        this.stdout.write(`\r\x1b[2K${content}`);
        this.stdout.write('\n');
      }
    }

    this.footerHeight = newHeight;

    // 光标定位到输入框。
    // cursorPos 是码点索引，终端 \x1b[NG 要的是显示列——CJK 全角字符/emoji
    // 占 2 列但算 1 码点，直接用码点当列会导致中文光标落在字符中间。
    // 复用 cursorScreenPos（stringWidth 实现，与 Footer.tsx 同源）做正确换算。
    const { x: cursorX, y: cursorLineIndex } = cursorScreenPos(input, cursorPos, PROMPT);
    const upFromBottom = this.footerHeight - 1 - cursorLineIndex;

    // 记录光标到 footer 顶部的距离，供 commitFooter 精确上移。
    // footer 结构：border(0) + input(1..n) + border + status。
    // cursorLineIndex 是 input 内的行号（0-based），到 footer 顶部 = 1 + cursorLineIndex。
    this.cursorToTop = 1 + cursorLineIndex;

    this.stdout.write(hideCursor);
    if (upFromBottom > 0) {
      this.stdout.write(cursorUp(upFromBottom));
    }
    this.stdout.write(`\r\x1b[${cursorX + 1}G`);
    this.stdout.write(showCursor);
  }

  commitFooter(): void {
    // 擦除 footer：上移到 footer 顶部，逐行擦除，光标回到 footer 顶部。
    // 这样后续 appendLine 的消息覆盖 footer 原位置，历史区域无重复框架。
    //
    // 物理模型（黑板擦除）：footer 是临时草稿区，commit = 擦干净草稿，
    // 让粉笔（appendLine）在干净区域写正式内容。
    //
    // cursorToTop 由 renderFooter 记录，是光标当前所在行到 footer 顶部的精确距离。
    if (this.footerHeight > 0) {
      // 上移到 footer 顶部
      this.stdout.write(cursorUp(this.cursorToTop));
      // 逐行擦除整个 footer
      for (let i = 0; i < this.footerHeight; i++) {
        this.stdout.write('\r\x1b[2K');
        if (i < this.footerHeight - 1) {
          this.stdout.write('\n');
        }
      }
      // 光标现在在 footer 最后一行（已擦除）。回到 footer 顶部，
      // 让 appendLine 从 footer 原顶部开始覆盖。
      this.stdout.write(cursorUp(this.footerHeight - 1));
      this.cursorToTop = 0;
    }
    this.footerHeight = 0;
  }

  // ─────────────── 流式 assistant 文本覆写 ───────────────
  //
  // 物理本质：「草稿行」机制。
  // stdout 是只追加的流，无法像 alt-screen 那样整屏重绘。
  // 流式文本的增量更新靠：上移光标到草稿区顶部 → 逐行擦写新内容。
  // 这复用了 renderFooter 已验证的覆写模式（cursorUp + \r\x1b[2K）。
  //
  // 状态机：
  //   lastStreamingHeight=0 → 首次：直接追加
  //   lastStreamingHeight>0 → 覆写：上移旧行数，逐行擦写
  //   clearStreamingHeight  → 重置，下次回到追加模式（finalize 后调用）

  /** 上次流式占用的物理行数。0 表示无草稿（首次或已固化）。 */
  private lastStreamingHeight = 0;

  /**
   * 覆写流式行。
   *
   * @param lines 本次要显示的行（已折行、已上色，不含 \n）
   *
   * 首次（lastStreamingHeight=0）：逐行追加 + \n。
   * 后续：cursorUp(旧高度) → 逐行 \r\x1b[2K + 内容 + \n。
   *   - 新行数 < 旧行数：多出的旧行用空内容覆写（擦除残余）
   *   - 新行数 > 旧行数：循环按旧行数擦写，多出的新行因光标已下移而自然追加
   */
  rewriteStreamingLines(lines: string[]): void {
    const newHeight = lines.length;
    if (this.lastStreamingHeight === 0) {
      // 首次：直接追加
      for (const l of lines) {
        this.stdout.write(l + '\n');
      }
    } else {
      // 覆写：上移旧行数到草稿顶部，逐行擦写新内容。
      this.stdout.write(cursorUp(this.lastStreamingHeight));
      // 写入新内容行（逐行擦写）
      for (let i = 0; i < newHeight; i++) {
        this.stdout.write(`\r\x1b[2K${lines[i]}`);
        this.stdout.write('\n');
      }
      // 行数减少时：物理删除多余的旧行（\x1b[<n>M），
      // 而非只擦空——擦空的行仍占屏幕空间，变成虚假"间隔"。
      if (newHeight < this.lastStreamingHeight) {
        const excess = this.lastStreamingHeight - newHeight;
        // 光标现在在最后一行写入内容下方一行。
        // 上移到新内容末行，删除 excess 行（该行及下方上移）。
        this.stdout.write(cursorUp(1));
        this.stdout.write(`\x1b[${excess}M`);
        // 删除后光标停在被删行的位置（已上移填充），
        // 写一个 \n 让光标回到新内容下方（与追加模式的光标基准对齐）。
        this.stdout.write('\n');
      }
    }
    this.lastStreamingHeight = newHeight;
  }

  /** 重置流式高度（finalize 后调用，下次 rewriteStreamingLines 回到追加模式）。 */
  clearStreamingHeight(): void {
    this.lastStreamingHeight = 0;
  }

  /**
   * 擦除草稿行（固化时调用，防止重复绘制）。
   *
   * 物理本质：黑板擦 + 裁纸刀。流式草稿画在屏幕上，固化时要把草稿
   * 物理删除（\x1b[M 删除行，下方内容上移），而非只擦空（擦空的行仍占空间）。
   * 删除后光标停在草稿原顶部位置，appendLine 从该位置写入固化内容。
   *
   * 前置条件：光标在草稿正下方（footer 已 commit 或不存在）。
   * 无草稿（height=0）时 no-op。
   */
  eraseStreamingLines(): void {
    if (this.lastStreamingHeight === 0) return;
    // 上移到草稿顶部
    this.stdout.write(cursorUp(this.lastStreamingHeight));
    // 物理删除全部草稿行（\x1b[<n>M：该行及下方上移，不留空行）
    this.stdout.write(`\x1b[${this.lastStreamingHeight}M`);
    this.lastStreamingHeight = 0;
  }

  /**
   * 退出备用屏（overlay 关闭时调用）。
   * 终端自动恢复主屏内容（\x1b[?1049l），无需手动重绘——主屏 scrollback 完好无损。
   */
  exitOverlay(): void {
    exitAltScreen(this.stdout);
  }

  /**
   * 渲染备用屏覆盖层（ctrl+o 打开的 thinking/tool_result 全文）。
   *
   * 物理本质：真正的备用屏（alternate buffer）。
   * 进入时 \x1b[?1049h 终端自动保存主屏；退出时 \x1b[?1049l 终端自动恢复主屏。
   * 零重绘——主屏内容进入 overlay 前是什么样，退出后还是什么样。
   *
   * @param title 标题（如 "Thinking"）
   * @param lines 内容行（已格式化的文本，不含 \n）
   * @param cols 终端列宽
   */
  renderOverlay(title: string, lines: string[], cols: number = 80): void {
    // 进入备用屏（终端自动保存主屏）
    enterAltScreen(this.stdout);
    // 标题
    this.stdout.write(title + '\n');
    // 分隔线
    this.stdout.write('━'.repeat(cols) + '\n');
    // 内容行
    for (const line of lines) {
      this.stdout.write(line + '\n');
    }
    // 返回提示
    this.stdout.write('\n按 q / Ctrl+O / Esc 返回\n');
  }
}
