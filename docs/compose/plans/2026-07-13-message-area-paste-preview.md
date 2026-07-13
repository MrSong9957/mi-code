# 粘贴内容提交后：消息区显示优化

> **状态**：独立任务，未在本次任务实施
> **前置依赖**：建议先修复 `渲染层多行内容显示 bug`（见下方）

## 背景

粘贴长文本提交后，消息区应该显示什么？经多轮讨论确认方向：**占位符 + 少量预览**（单行含首行预览格式）。

本次任务（双轨契约补强 + Bug A 短文本直显）未实施此优化，原因：
1. 消息区显示涉及渲染层，改动牵一发动全身
2. 渲染层有 pre-existing bug（多行内容显示异常），需先修复
3. 避免在消息区显示上第 4 次改方向

## 目标格式

```
❯ [Pasted #1 +5 lines: "第一步：记录基线..."]
```

- 单行（不触发多行渲染 bug）
- 含首行预览（用户能看到粘了什么）
- 预览截断到约 40 字符，超出加 `...`

## 三次方向变更记录（避免再次跑偏）

| 方案 | 问题 |
|---|---|
| emit 发 agentText（展开全文）| 触发渲染层多行显示 bug，"只显示最后一句" |
| emit 发 historyText（纯占位符）| "完全看不到发的是什么" |
| 含预览占位符（本次确定方向）| 牵涉占位符格式 + 正则 + 全部测试，单独立项 |

## 实施路径建议

### 方案 A：改占位符格式（全面但彻底）
- `storePastedContent` 生成 `[Pasted text #N +M lines: "首行预览..."]`
- `expandPastedTextRefs` 正则更新：`/\[Pasted text #(\d+) \+(\d+) lines(?::\s*"[^"]*")?\]/g`
- `commitNewTurn` emit 发 `historyText`（含预览的占位符版本）
- 影响约 10+ 处测试断言，需全部适配
- 已验证正则可行性（见对话记录）

### 方案 B：只在 emit 层附加预览（中等改动）
- 保持占位符格式不变
- `storePastedContent` 额外返回预览数据（或新增 `getPastePreview(id)` 函数）
- `commitNewTurn` emit 时拼接"占位符 + 预览"
- 输入框仍显示纯占位符，消息区显示含预览版本

## 前置依赖：渲染层多行显示 bug

**症状**：含 `\n` 的 user_input 在消息区"只显示最后一句"。

**根因调查已确认**（诊断证据）：
- `src/ui/message-formatter.ts:67`：多行 input 被塞进**单条** FormattedLine（content 含 `\n`）
- `src/tui/inline/InlineApp.tsx:157-165`：`renderFinalizedLine` 对 `role === 'user'` 不折行
- 单条 FormattedLine 含 `\n` 经 `appendLine` 写出后，footer 覆写时序可能覆盖前面的行

**修复方向**（独立任务）：
- 让 `MessageFormatter.format('input', ...)` 按 `\n` 拆成多条 FormattedLine
- 或让 `renderFinalizedLine` 对 user role 也走折行逻辑

## 相关文件

- `src/tui/input/paste-handler.ts`（占位符生成 + 正则）
- `src/tui/input/submit-transformer.ts`（commitNewTurn emit）
- `src/ui/message-formatter.ts:67`（input 分支不拆行）
- `src/tui/inline/InlineApp.tsx:150-166`（renderFinalizedLine user 不折行）
- `src/__tests__/tui/paste-handler.test.ts`（占位符格式断言）
- `src/__tests__/tui/submit-transformer.test.ts`（emit 契约断言）
