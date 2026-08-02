# UI-only final-feedback block + model-context sanitizer 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。Steps use checkbox (`- [ ]`).

**Goal:** final-feedback 状态块标记为 uiOnly,落盘保留,但 streamingQuery 喂模型前用 sanitizer 剔除,消除跨 turn LLM 模仿(阻断 A)。

**Architecture:** TextBlock 增可选 `uiOnly?: true`;appendFeedback 的状态块始终独立 block 且标 uiOnly;新增 `sanitizeMessagesForModel` 纯函数在 streamingQuery messages 构造点(L444)调用,剔除所有 uiOnly block。jsonl/UI/sessionMessages 保持原数据。

---

## Global Constraints

- TextBlock.`uiOnly?: true` 只在真正 UI-only block 上设 true,不写 false。
- 状态块必须独立 text block;string content 规范化为 `[{text:original},{text:feedback,uiOnly:true}]`。
- sanitizer 单一职责:删 uiOnly block、保留其他、空 message 删除、string 原样、不 mutation、输出不含 uiOnly 字段。
- 唯一过滤边界:streamingQuery L444。provider/client.stream 收到的必是 sanitizer 后的标准消息(不在 provider 再加第二套过滤)。
- 旧 JSONL 无 uiOnly 的历史状态块不做猜测迁移,禁止文本匹配删除。
- 行为零变化:sessionMessages/jsonl/UI 保持原数据;仅 model context 剔除 uiOnly。

---

## File Map

### New files
- `src/agent/model-message-sanitizer.ts` — `sanitizeMessagesForModel(messages: Message[]): Message[]`
- `src/__tests__/agent/model-message-sanitizer.test.ts`

### Modified files
- `src/agent/types.ts` — TextBlock 加 `uiOnly?: true`
- `src/agent/turn-final-feedback.ts` — appendFeedback 状态块标 uiOnly + string 规范化
- `src/agent/streaming-query.ts` — L444 messages 构造点调 sanitizer
- `src/__tests__/turn-final-feedback.test.ts` — appendFeedback uiOnly 断言
- `src/__tests__/streaming-query.test.ts` — 集成边界(initialMessages 含 uiOnly → submit 收到的干净)

---

## Task 1: TextBlock.uiOnly + sanitizer(纯函数 TDD)

**Files:** types.ts, model-message-sanitizer.ts, model-message-sanitizer.test.ts

- [ ] Step 1: RED — sanitizer 测试(mixed/uiOnly-only/tool_use+uiOnly/string/no-mutation/output-no-uiOnly)
- [ ] Step 2: types.ts TextBlock 加 `uiOnly?: true`
- [ ] Step 3: 实现 sanitizeMessagesForModel
- [ ] Step 4: GREEN + typecheck + commit

## Task 2: appendFeedback 状态块标 uiOnly

**Files:** turn-final-feedback.ts, turn-final-feedback.test.ts

- [ ] Step 1: RED — appendFeedback 测试(array→uiOnly block / string→两 block / 新建→uiOnly / 正文不标记)
- [ ] Step 2: 改 appendFeedback(string 分支规范化 + 所有 feedback block 标 uiOnly)
- [ ] Step 3: GREEN + 既有 turn-final-feedback 回归 + commit

## Task 3: streamingQuery 边界调 sanitizer + 集成测试

**Files:** streaming-query.ts, streaming-query.test.ts

- [ ] Step 1: RED — 集成测试(initialMessages 含 uiOnly → 捕获 submit/client.stream 入参无 uiOnly;sessionMessages 原对象仍含)
- [ ] Step 2: streamingQuery L444 调 sanitizer
- [ ] Step 3: GREEN + 回归 + typecheck + commit

## Task 4: 全量回归

- [ ] turn-final-feedback + sanitizer + streamingQuery 聚焦 + session/history 回归 + typecheck
