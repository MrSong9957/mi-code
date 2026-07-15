import { cursorUp, hideCursor, showCursor } from './ansi-utils.js';
import { enterAltScreen, exitAltScreen } from '../hooks/useAltScreen.js';
import { getUsableWidth } from '../state/wrap-line.js';
import { InlineRenderState } from './render-state.js';
import { layoutFooter, type FooterLayout } from './layout.js';
import {
  diffFooterOverlay, diffStreamingOverlay, diffFooterCommit,
  type RenderOperation,
} from './diff.js';

export class InlineRenderer {
  /** 渲染状态（footer/streaming/消息账本）。Phase 1：统一所有者。 */
  readonly state: InlineRenderState;
  /** 测试用：读取当前 footer 物理行数（代理到 state）。 */
  getFooterHeight(): number { return this.state.footerHeight; }

  /**
   * 单次 write 缓冲：commit() 期间所有 write 进此 buffer，
   * 结束时一次 stdout.write 刷出。单次 write 是防闪烁的核心手段——
   * 即使终端不支持 DEC 2026，终端处理一个完整字符串时中间状态更少。
   * （Claude Code terminal.ts:205 "Buffer all writes into a single string"）
   * 非(commit)路径直接 write stdout（appendLine 的 logo 初始化、destroy 等）。
   */
  private writeBuf: string[] | null = null;

  /** 统一写入入口：commit 期间进 buffer，否则直接 write stdout。 */
  private write(s: string): void {
    if (this.writeBuf !== null) {
      this.writeBuf.push(s);
    } else {
      this.stdout.write(s);
    }
  }

  constructor(private stdout: NodeJS.WriteStream) {
    this.state = new InlineRenderState();
    // DECAWM OFF：关闭终端自动折行，应用层自己做 wordWrap。
    this.stdout.write('\x1b[?7l');
  }

  /** 销毁：恢复 DECAWM ON + 光标可见。bootstrap cleanup / crash 兜底调用。 */
  destroy(): void {
    this.stdout.write('\x1b[?25h\x1b[?7h');
  }

  appendLine(ansiText: string): void {
    this.write(ansiText + '\n');
  }

  /**
   * Writer：执行 RenderOperation 序列，写入 stdout。
   *
   * Phase 3：cursor 操作集中到此处。每个操作的 stdout 语义：
   * - cursorUp: \x1b[<count>A
   * - appendLine: content + \n
   * - overwriteLine: \r\x1b[2K + content + \n
   * - eraseAndAdvance: \r\x1b[2K + \n
   * - eraseNoAdvance: \r\x1b[2K
   * - advanceNewLine: \n
   * - deleteLines: \x1b[<count>M
   */
  executeOperations(ops: RenderOperation[]): void {
    for (const op of ops) {
      switch (op.type) {
        case 'cursorUp':
          this.write(cursorUp(op.count));
          break;
        case 'appendLine':
          this.write(op.content + '\n');
          break;
        case 'overwriteLine':
          this.write(`\r\x1b[2K${op.content}\n`);
          break;
        case 'eraseAndAdvance':
          this.write('\r\x1b[2K\n');
          break;
        case 'eraseNoAdvance':
          this.write('\r\x1b[2K');
          break;
        case 'advanceNewLine':
          this.write('\n');
          break;
        case 'deleteLines':
          this.write(`\x1b[${op.count}M`);
          break;
      }
    }
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
    // Phase 2：布局计算委托 layoutFooter（纯函数），本方法只写 stdout。
    const layout = layoutFooter({ input, cursor: cursorPos, status: statusText, cols, suggestions, dropdownIndex: selectedIndex, viewportTop });
    this.writeFooter(layout);
  }

  /**
   * 写入已算好布局的 footer（只写 stdout，不做内容计算）。
   *
   * Phase 3：覆写逻辑由 diff.ts 的 diffFooterOverlay 生成 RenderOperation[]，
   * 本方法执行操作序列 + 光标定位。
   */
  writeFooter(layout: FooterLayout): void {
    const { lines, height: newHeight, cursorToTop, cursorCol, usableWidth } = layout;

    // diff：根据 footerHeight 决定追加/覆写（覆写用 cursorToTop 定位）
    const ops = diffFooterOverlay(this.state.footerHeight, this.state.cursorToTop, lines);
    this.executeOperations(ops);

    // writtenLineCount：覆写模式下是 max(prevHeight, newHeight)
    const writtenLineCount = this.state.footerHeight === 0
      ? newHeight
      : Math.max(this.state.footerHeight, newHeight);

    this.state.footerHeight = newHeight;
    this.state.cursorToTop = cursorToTop;

    // 光标定位到输入框
    const upFromBottom = writtenLineCount - cursorToTop;
    this.write(hideCursor);
    if (upFromBottom > 0) {
      this.write(cursorUp(upFromBottom));
    }
    const chaCol = Math.min(cursorCol + 1, usableWidth);
    this.write(`\r\x1b[${chaCol}G`);
    this.write(showCursor);
  }

  /**
   * 擦除 footer（生命周期清理）。
   *
   * Phase 3：操作序列由 diff.ts 的 diffFooterCommit 生成。
   * cursorToTop 由 writeFooter 记录，是光标当前所在行到 footer 顶部的精确距离。
   */
  commitFooter(): void {
    const ops = diffFooterCommit(this.state.footerHeight, this.state.cursorToTop);
    this.executeOperations(ops);
    this.state.cursorToTop = 0;
    this.state.footerHeight = 0;
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

  /**
   * 覆写流式行。
   *
   * Phase 3：操作序列由 diff.ts 的 diffStreamingOverlay 生成。
   * 行数减少时用 DL 物理删除（streaming 场景的已知正确行为）。
   *
   * @param lines 本次要显示的行（已折行、已上色，不含 \n）
   */
  rewriteStreamingLines(lines: string[]): void {
    const ops = diffStreamingOverlay(this.state.lastStreamingHeight, lines);
    this.executeOperations(ops);
    this.state.lastStreamingHeight = lines.length;
  }

  /** 重置流式高度（finalize 后调用，下次 rewriteStreamingLines 回到追加模式）。 */
  clearStreamingHeight(): void {
    this.state.lastStreamingHeight = 0;
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
    if (this.state.lastStreamingHeight === 0) return;
    // 上移到草稿顶部
    this.write(cursorUp(this.state.lastStreamingHeight));
    // 物理删除全部草稿行（\x1b[<n>M：该行及下方上移，不留空行）
    this.write(`\x1b[${this.state.lastStreamingHeight}M`);
    this.state.lastStreamingHeight = 0;
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

  /**
   * Render commit boundary：组件层渲染的唯一入口。
   *
   * Phase 0（本阶段）：commit 内部按固定顺序复用现有方法（commitFooter/
   * eraseStreamingLines/appendLine/clearStreamingHeight/rewriteStreamingLines/
   * renderFooter），逻辑与改造前 InlineApp 主 effect 完全一致，只是把
   * "渲染顺序编排"从组件层搬进 Renderer，让组件层只负责构建 Frame 数据。
   *
   * 组件层不再直接调 appendLine/commitFooter/eraseStreamingLines/
   * clearStreamingHeight/rewriteStreamingLines/renderFooter。
   *
   * 未来 Phase（State/Layout/Diff Layer）会替换 commit 内部实现，
   * 但 commit(frame) 这个入口签名保持稳定。
   *
   * @param frame 这一帧要渲染的内容（已转成 ANSI string[]）+ 状态转换信号
   */
  commit(frame: CommitFrame): void {
    const { justFinalized, needEraseDraft } = frame.transitions;

    // 单次 write 防闪烁：所有操作拼进 writeBuf，结束时一次 stdout.write。
    // 这是防闪烁的核心手段——即使终端不支持 DEC 2026（conhost），
    // 单次 write 也能让终端在一个完整字符串内完成渲染，中间状态最少。
    // （Claude Code terminal.ts:205 "Buffer all writes into a single string"）
    this.writeBuf = [];
    this.write('\x1b[?2026h');  // BSU（支持的终端原子更新；不支持的忽略，无害）

    // ── 0. 前置输出（logo 首次渲染 / resize 清屏+logo）──
    // 在 BSU 后、步骤 1 之前输出，确保整帧原子更新。
    if (frame.prefix) {
      for (const s of frame.prefix) {
        this.write(s);
      }
    }

    // ── 1. 转换前置：清理 footer + 流式草稿 ──
    // 顺序关键：必须先 commitFooter（否则光标在 footer 内，erase 的 cursorUp 会算错）。
    if (justFinalized || frame.hasNewFinalized) {
      this.commitFooter();
    }
    if (needEraseDraft) {
      this.eraseStreamingLines();
    }

    // ── 2. 新增固化行：逐行追加（\n 推进，自然进 scrollback）──
    for (const ansiLine of frame.newLines) {
      this.appendLine(ansiLine);
    }

    // ── 3. 流式草稿：覆写或首次追加 ──
    if (frame.streamingLines !== null) {
      // 流式中：先 commit footer（清除 footer，让光标回到草稿正下方），
      // 否则 rewriteStreamingLines 的 cursorUp 会算错位置。
      // needEraseDraft 时已在上面 commit + erase 过，跳过。
      if (!justFinalized && !needEraseDraft) {
        this.commitFooter();
      }
      // 仅在固化→流式转换时清零草稿高度（详见 rewriteStreamingLines 注释）。
      if (justFinalized || needEraseDraft) {
        this.clearStreamingHeight();
      }
      this.rewriteStreamingLines(frame.streamingLines);
    }

    // ── 4. Footer 写入（cursorUp + 全行覆写 + 光标定位）──
    this.writeFooter(frame.footer);

    this.write('\x1b[?2026l');  // ESU

    // 一次 write 刷出整个帧
    this.stdout.write(this.writeBuf.join(''));
    this.writeBuf = null;
  }
}

/**
 * commit(frame) 的输入：组件层构建的一帧渲染数据（Phase 2 起含 LayoutResult）。
 *
 * 设计原则：Frame 携带"已转成 ANSI 的内容"+ 已算好的 footer 布局 + 状态转换信号，
 * 不含 cursor/ANSI/调用顺序决策——那些由 commit 内部处理。
 */
export interface CommitFrame {
  /** 前置输出（logo 首次渲染 / resize 清屏+logo 重写）。
   *  每项是已含 \n 的 ANSI 字符串，在 BSU 后、步骤 1 之前输出。
   *  使 commit() 成为唯一 stdout 出口——所有输出都在 writeBuf 内。 */
  prefix?: string[];
  /** 新增的固化行（已 renderFinalizedLine 转成 ANSI string[]，逐行 appendLine） */
  newLines: string[];
  /** 流式草稿行（已 wrapStreamingText/wrapThinkingText 转 ANSI string[]）。
   *  null = 当前不流式（不调 rewriteStreamingLines） */
  streamingLines: string[] | null;
  /** footer 布局结果（Phase 2：由 layout.ts 的 layoutFooter 计算，Renderer 只写入） */
  footer: FooterLayout;
  /** 是否有新增固化行（决定是否 commitFooter 前置清理） */
  hasNewFinalized: boolean;
  /** 状态转换信号（决定 commit 内部 commitFooter/erase/clearStreamingHeight 调用） */
  transitions: {
    /** 上一帧在流式，本帧不在流式 → 刚固化 */
    justFinalized: boolean;
    /** 需要擦除流式草稿（thinking→固化 或 流式中有新固化消息） */
    needEraseDraft: boolean;
  };
}
