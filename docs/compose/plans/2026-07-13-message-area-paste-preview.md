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

> ✅ **已修复（2026-07-13）** —— 见下方"实际修复"

**症状**：含 `\n` 的 user_input 在消息区"只显示最后一句"。

**根因调查已确认**（诊断证据）：
- `src/ui/message-formatter.ts:67`：多行 input 被塞进**单条** FormattedLine（content 含 `\n`）
- `src/tui/inline/InlineApp.tsx:157-165`：`renderFinalizedLine` 对 `role === 'user'` 不折行
- 单条 FormattedLine 含 `\n` 经 `appendLine` 写出后，footer 覆写时序可能覆盖前面的行

### 实际修复（2026-07-13）

采用方案：**让 `MessageFormatter.format('input', ...)` 按 `\n` 拆成多条 FormattedLine**（修 formatter，不动 renderer）。

改动点（唯一一处）：
- `src/ui/message-formatter.ts` `case 'input'` 分支：
  ```ts
  return (content ?? '').split('\n').map((line, i) => ({
    content: i === 0 ? `❯ ${line}` : line,  // 首行带 ❯，续行无前缀同色
    style: BLOCK_STYLES.greenBold,
    indent: 0,
  }));
  ```

消费链路天然支持多行（无需改动）：
- `block-pipeline.ts:131` → `print(lines, 'user')` → `for (const line of lines)` 迭代多条
- `PipelineToStoreAdapter.printMessage` → `messages-store.appendLine('user', line)`：多条 input line 续接进同一条 user 消息
- `InlineApp.tsx:346-351` 逐行 `renderFinalizedLine('user', line)` + `appendLine`

新增回归测试：`src/__tests__/ui/message-formatter.test.ts` 追加 6 个多行 input 用例
（行数、首行前缀、续行无前缀、同色、空行保留、单行行为不变）。

### 验证证据

- 新增 6 用例 RED（length 期望 3 实际 1）→ GREEN
- 单行 input 现有契约保持（17 既有用例零破坏）
- L2 回归：88 文件 / 735 用例全过
- `npx tsc --noEmit` 零报错

### 后续（独立任务）

修复后消息区能正确显示多行 input，但**粘贴占位符的预览优化**（本文档上方"目标格式"）仍是独立任务。
当前粘贴长文本提交后，消息区会显示展开的多行原文（不再错位），但无 `[Pasted #N +预览]` 单行格式。

## 相关文件

- `src/tui/input/paste-handler.ts`（占位符生成 + 正则）
- `src/tui/input/submit-transformer.ts`（commitNewTurn emit）
- `src/ui/message-formatter.ts:67`（input 分支不拆行）
- `src/tui/inline/InlineApp.tsx:150-166`（renderFinalizedLine user 不折行）
- `src/__tests__/tui/paste-handler.test.ts`（占位符格式断言）
- `src/__tests__/tui/submit-transformer.test.ts`（emit 契约断言）
