import { cursorUp, hideCursor, showCursor } from './ansi-utils.js';
import { enterAltScreen, exitAltScreen } from '../hooks/useAltScreen.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import { MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { wrapLine, getUsableWidth } from '../state/wrap-line.js';
import { layoutInputCursor } from '../state/layout-cursor.js';
import sliceAnsi from 'slice-ansi';

const PROMPT = '❯ ';
/** 续行缩进：与 PROMPT 宽度对齐（❯ 占 1 列 + 空格 1 列 = 2 列）。
 *  多行输入时续行前缀 2 空格，视觉上与首行的输入起点对齐。 */
const CONTINUATION_INDENT = '  ';

export class InlineRenderer {
  /** footer 占用的物理行数。0 表示无 footer 或已 commit。 */
  private footerHeight = 0;
  /** 光标所在行到 footer 顶部的物理行距离（用于 commitFooter 精确上移）。 */
  private cursorToTop = 0;
  /** 测试用：读取当前 footer 物理行数。 */
  getFooterHeight(): number { return this.footerHeight; }

  constructor(private stdout: NodeJS.WriteStream) {
    // DECAWM OFF：关闭终端自动折行，应用层自己做 wordWrap。
    // 物理本质：终端不再因写满列而自动换行——应用决定布局，终端只负责显示。
    // 这消除了 simulateTerminalWrap 的"猜终端折行"不确定性：
    // physical rows = application wrapped rows（完全可控）。
    this.stdout.write('\x1b[?7l');
  }

  /** 销毁：恢复 DECAWM ON + 光标可见。bootstrap cleanup / crash 兜底调用。 */
  destroy(): void {
    this.stdout.write('\x1b[?25h\x1b[?7h');
  }

  appendLine(ansiText: string): void {
    this.stdout.write(ansiText + '\n');
  }

  rewriteCurrentLine(ansiText: string): void {
    this.stdout.write('\r\x1b[K' + ansiText);
  }

  /**
   * 渲染 footer + 下拉菜单（一个原子块）。
   *
   * 物理本质：footer 和下拉菜单是同一张「便签」上的两部分。
   * 把它们合并成一块写入，下拉菜单的高度天然纳入 footerHeight 账本，
   * 下一帧覆写时 cursorUp 自动覆盖整个区域——零残留。
   *
   * 行序（向下布局，输入框正下方）：
   *   ───── border ─────
   *   ❯ <input>          ← 光标定位到这里
   *      ▸ /cmd0         ← suggestions[selectedIndex] 反白（选中）
   *        /cmd1         ← 未选中
   *   ───── border ─────
   *   <statusText>
   *
   * 调用契约：
   * - footerHeight=0 时：直接追加（首次或 commit 后）
   * - footerHeight>0 时：覆写旧区域（光标必须在 footer 区域内）
   *
   * InlineApp 保证：有新消息时先 commitFooter()（清零 footerHeight），
   * 再写消息，再调用本方法。无新消息时直接调用本方法覆写。
   *
   * @param suggestions 下拉候选（空数组=无下拉菜单）。最多取前 8 条。
   * @param selectedIndex 选中的候选下标（决定哪一行反白）
   */
  renderFooter(
    input: string,
    cursorPos: number,
    statusText: string,
    cols: number = 80,
    suggestions: string[] = [],
    selectedIndex: number = 0,
    viewportTop: number = 0,
  ): void {
    const inputLines = input.split('\n');
    const usableWidth = getUsableWidth(cols);
    const border = '─'.repeat(usableWidth);

    // 算光标所在逻辑行号（cursorScreenPos 是纯函数，y 是相对输入区第 0 行的绝对行）。
    const { y: cursorAbsLine } = cursorScreenPos(input, cursorPos, PROMPT);

    // 视口切片：footer 固定高度，输入超 viewportTop+maxVisible 时只渲染窗口内行。
    const visibleInputLines = inputLines.slice(
      viewportTop,
      viewportTop + MAX_VISIBLE_INPUT_LINES,
    );

    // 可见窗口切片：居中滚动
    const maxVisible = Math.min(suggestions.length, 8);
    const startIndex = Math.max(0, Math.min(
      selectedIndex - Math.floor(maxVisible / 2),
      suggestions.length - maxVisible,
    ));
    const visibleSuggestions = suggestions.slice(startIndex, startIndex + maxVisible);
    const selectedName = suggestions[selectedIndex];
    const suggestionLines: string[] = visibleSuggestions.map((name) => {
      const isSelected = name === selectedName;
      return isSelected ? `\x1b[7m ▸ /${name} \x1b[0m` : `   /${name}`;
    });

    // 组装完整行序：border / 输入行(s) / 下拉行(s) / border / 状态
    // DECAWM OFF + 应用层 wordWrap：每行 ≤ usableWidth，不依赖终端折行。
    // physical rows = lines.length（完全可控，不再用 simulateTerminalWrap 猜测）。
    const lines: string[] = [border];
    // 记录每个可见输入行 wordWrap 后的行数（用于光标定位）
    const wrappedInputCounts: number[] = [];
    for (let i = 0; i < visibleInputLines.length; i++) {
      const absLine = viewportTop + i;
      const prefix = absLine === 0 ? PROMPT : CONTINUATION_INDENT;
      // wordWrap：超宽内容换行显示（不截断不丢弃），保留完整输入体验。
      // 混合策略：英文优先按空格断行，CJK/无空格按字符级断行。
      const wrapped = wrapLine(prefix + visibleInputLines[i]!, usableWidth);
      wrappedInputCounts.push(wrapped.length);
      lines.push(...wrapped);
    }
    // suggestion：截断（菜单项每项1行，折行破坏对齐）
    for (const sl of suggestionLines) {
      lines.push(sliceAnsi(sl, 0, usableWidth));
    }
    lines.push(border);
    // statusText：wordWrap（状态栏可能含颜色码+长文本）
    const wrappedStatus = wrapLine(statusText, usableWidth);
    lines.push(...wrappedStatus);

    // DECAWM OFF 后每行恰好 1 物理行，newHeight = lines.length
    const newHeight = lines.length;
    let writtenLineCount = newHeight;

    if (this.footerHeight === 0) {
      // 追加模式：逐行写 + \n
      for (const line of lines) {
        this.stdout.write(line + '\n');
      }
    } else {
      // 覆写模式：逐行擦写（不依赖 DL，ConPTY 把 DL→EL 导致堆叠）
      this.stdout.write(cursorUp(this.cursorToTop));
      const maxLines = Math.max(this.footerHeight, newHeight);
      for (let i = 0; i < maxLines; i++) {
        const content = i < lines.length ? lines[i]! : '';
        this.stdout.write(`\r\x1b[2K${content}\n`);
      }
      writtenLineCount = maxLines;
    }

    this.footerHeight = newHeight;

    // 光标定位到输入框——用 layoutInputCursor 算 wordWrap 后的物理行 + 列。
    // 块内物理行（0-based）：行0=顶部border，行1..=输入区，底部border，status。
    let cursorPhysLine0 = 1; // 跳过顶部 border
    let cursorColInPhysLine = 0;
    for (let i = 0; i < visibleInputLines.length; i++) {
      const absLine = viewportTop + i;
      const prefix = absLine === 0 ? PROMPT : CONTINUATION_INDENT;
      if (absLine === cursorAbsLine) {
        // 光标在本逻辑行：用 layoutInputCursor 算 wordWrap 后的 (row, col)
        // cursorPos 是码点索引，用码点安全切片算 cursorCpOffset
        const lines2 = input.split('\n');
        let off = 0;
        for (let j = 0; j < absLine; j++) off += [...lines2[j]!].length + 1;
        const cursorCpOffset = Math.max(0, cursorPos - off);
        const layout = layoutInputCursor(lines2[absLine]!, cursorCpOffset, prefix, usableWidth);
        cursorPhysLine0 += layout.row;
        cursorColInPhysLine = layout.col;
        break;
      }
      cursorPhysLine0 += wrappedInputCounts[i]!;
    }
    const upFromBottom = writtenLineCount - cursorPhysLine0;

    // 记录光标到块顶的距离（供 commitFooter 上移）。
    this.cursorToTop = cursorPhysLine0;

    this.stdout.write(hideCursor);
    if (upFromBottom > 0) {
      this.stdout.write(cursorUp(upFromBottom));
    }
    // CHA：光标在物理行内的列（0-based），1-based = cursorColInPhysLine + 1。
    const chaCol = Math.min(cursorColInPhysLine + 1, usableWidth);
    this.stdout.write(`\r\x1b[${chaCol}G`);
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
    this.stdout.write('━'.repeat(getUsableWidth(cols)) + '\n');
    // 内容行
    for (const line of lines) {
      this.stdout.write(line + '\n');
    }
    // 返回提示
    this.stdout.write('\n按 q / Ctrl+O / Esc 返回\n');
  }
}
