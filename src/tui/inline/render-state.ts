// src/tui/inline/render-state.ts
// Terminal Render State：inline 模式渲染状态的唯一所有者。
//
// Phase 1（本阶段）：收拢原本分散在三处的渲染状态：
//   - footerHeight / cursorToTop（原 InlineRenderer 的 private 实例字段）
//   - lastStreamingHeight（原 InlineRenderer 的 private 实例字段）
//   - renderedLines（原 InlineApp 的 React ref: renderedLinesRef）
//
// 这三类状态此前互相不感知，靠 InlineApp 主 effect 的调用顺序契约维持一致。
// 现在统一到 InlineRenderState，为 Phase 2（Layout Layer）提供单一状态源。
//
// 本阶段不改渲染算法、不改 cursor 计算、不改 stdout 行为——只是搬存储位置。

/**
 * inline 模式的渲染状态（footer + streaming + 消息渲染账本）。
 *
 * 字段说明：
 * - footerHeight：footer 占用的物理行数。0 表示无 footer 或已 commit。
 *   决定 renderFooter 走追加模式（=0）还是覆写模式（>0）。
 * - cursorToTop：光标所在行到 footer 顶部的物理行距离。
 *   用于 commitFooter / renderFooter 覆写时的 cursorUp 参数。
 * - lastStreamingHeight：上次流式草稿占用的物理行数。0 表示无草稿（首次或已固化）。
 *   决定 rewriteStreamingLines 走追加模式（=0）还是覆写模式（>0）。
 * - renderedLines：消息渲染账本（消息 uuid → 已渲染行数）。
 *   用于增量渲染：只 appendLine 「上次之后新增的行」。
 */
export class InlineRenderState {
  footerHeight = 0;
  cursorToTop = 0;
  lastStreamingHeight = 0;
  /** 消息渲染账本（uuid → 已渲染行数）。从 InlineApp 的 renderedLinesRef 迁来。 */
  readonly renderedLines = new Map<string, number>();

  /** 测试用：读取 footerHeight（保留旧 API 兼容） */
  getFooterHeight(): number { return this.footerHeight; }

  /** 已渲染消息数量（用于 InlineApp 的 early return 判断） */
  get renderedCount(): number { return this.renderedLines.size; }

  /** 读取某消息已渲染的行数（未渲染过返回 0） */
  getRenderedLineCount(uuid: string): number {
    return this.renderedLines.get(uuid) ?? 0;
  }

  /** 记录某消息已渲染到第几行 */
  setRenderedLineCount(uuid: string, count: number): void {
    this.renderedLines.set(uuid, count);
  }
}
