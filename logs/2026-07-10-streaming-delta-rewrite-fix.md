# 2026-07-10 流式 delta 堆叠（非原地覆写）修复

## 底层逻辑
- InlineRenderer.rewriteStreamingLines 用 lastStreamingHeight 记忆草稿高度，实现覆写状态机：0=追加，>0=cursorUp 回顶逐行擦写
- InlineApp 流式 effect 无条件 clearStreamingHeight()，把记忆永久归零 → rewriteStreamingLines 100% 走追加分支 → 每个 delta 完整文本向下堆叠

## TDD 测试点
- RED: streaming-delta-rewrite-regression.test.ts 挂载真实 InlineApp + 真实 zustand store，spy clearStreamingHeight，断言连续 delta 间调用次数=0。bug 代码下失败（被调 2-3 次）
- GREEN: clearStreamingHeight 条件化到 (justFinalized || needEraseDraft) 固化转换路径
- 假测试验证: 故意恢复无条件 clearStreamingHeight → 测试立即失败 → 确认非假测试

## 失败原因
- 消费者（InlineApp）的调用契约与渲染器状态机不匹配：连续 delta 不应清零渲染器状态

## 验证结果
- 新增测试: 5/5 pass（src/tui/inline/streaming-delta-rewrite-regression.test.ts）
- inline 回归: 135/135 pass
- 全量回归: 1109/1109 pass（107 文件）

# 2026-07-10 Thought for 与 assistant 之间缺空行 gap 修复

## 底层逻辑
- InlineApp 用 renderedCountRef（消息数计数）追踪渲染进度，已渲染过的消息不再回头
- pipeline 的 ensureGap 在 assistant 首 delta 时给已渲染的 thinking_summary 消息 appendLine 续接 gap 空行（同 role system 续接）
- 该 gap 行加入旧消息的 lines，但 InlineApp slice(renderedCount) 只取其后消息 → gap 行永远不被 appendLine → Thought for 与 assistant 粘连

## TDD 测试点
- RED: thinking-summary-gap-regression.test.ts 用真实 BlockPipeline 驱动数据流，spy appendLine，断言 Thought for 与 assistant 之间有空行 appendLine。bug 代码下失败
- GREEN: renderedCountRef(消息数) → renderedLinesRef(Map<uuid, 行数>)，每次 effect 遍历所有已固化消息补写每个消息的新增行
- 假测试验证: 故意把 prev=msg.lines.length（增量恒 0）→ 测试立即失败 → 确认非假测试

## 失败原因
- 进度追踪粒度错：按消息数追踪，无法捕获已渲染消息的行追加（gap 续接场景）

## 验证结果
- 新增测试: 2/2 pass（src/tui/inline/thinking-summary-gap-regression.test.ts）
- 全量回归: 1111/1111 pass（108 文件）
