# Subagent Result Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让子代理只把有真实工具证据且正常结束的输出当作完成结果，并禁止子代理直接等待用户交互。

**Architecture:** 在现有 `streamingQuery` 路径上用 `StreamEventBus` 收集终止原因与工具结果，集中由 `subagent.ts` 判定 `completed` / `incomplete` / `unverified`。角色工具过滤和 child registry 同时移除用户交互工具，主 agent 继续独占询问与计划审批。

**Tech Stack:** TypeScript 6、Node.js ESM、Vitest 3、现有 `StreamingLLMClient` / `streamingQuery` / `StreamEventBus`

## Global Constraints

- 目标分支：现有 worktree `D:\\Files\\Projects\\mi-code\\.worktrees\\auto-0025`，基线 HEAD `bd2488d`。
- 复用 `9fae925` 已有的“最后一轮文本 + explore 25 轮”，不回退或重复实现。
- 保留工作树中用户已有的 `package-lock.json` 修改，不暂存、不覆盖。
- 不修改主 agent 的 AskUserQuestion、ExitPlanMode 或 `streamingQuery` 公共行为。
- 只对 `explore` 强制工具证据；不为自然语言路径做通用解析器。
- 严格执行 RED → GREEN → REFACTOR；开发中先跑当前测试，最终才跑全量测试。

---

## File Map

- Create: `src/__tests__/subagent-result-integrity.test.ts` — 脚本化流式客户端，覆盖证据、终止原因和正常完成路径。
- Modify: `src/agent/subagent.ts` — 收集执行元数据、判定状态、格式化安全返回值。
- Modify: `src/agent/roles.ts` — explore 证据约束、plan 子代理专用提示词、交互工具黑名单。
- Modify: `src/index.ts` — 不再把交互工具注册给 child registry。
- Modify: `src/__tests__/role-agents.test.ts` — 锁定所有角色/fork 的工具隔离行为。
- Modify: `src/__tests__/task-tool.test.ts`、`src/__tests__/regression/subagent-permission-passthrough.test.ts` — `SubagentResult` 新字段为必填，更新测试 runner 的返回夹具。
- Modify: `logs/subagent-result-integrity.md` — 仅记录根因、RED/GREEN 证据和最终验证结果。

---

### Task 1: Bug 2 — 拒绝无工具证据的 explore 事实输出

**Files:**
- Create: `src/__tests__/subagent-result-integrity.test.ts`
- Modify: `src/agent/subagent.ts:82-182`
- Modify: `src/agent/roles.ts:68-83`
- Create: `logs/subagent-result-integrity.md`

**Interfaces:**
- Produces: `SubagentStatus = 'completed' | 'incomplete' | 'unverified' | 'background'`。
- Produces: `SubagentEvidence { toolCallCount: number; successfulToolResultCount: number }`。
- Produces: `SubagentResult.status`、`SubagentResult.terminationReason`、`SubagentResult.evidence`；后续任务复用这些字段。

- [ ] **Step 1: 写脚本化 client 和“零工具调用”失败测试**

在新测试文件复用 `src/__tests__/streaming-query.test.ts` 的 `ScriptedStreamClient` 模式，构造只返回文本、不调用工具的 explore 子代理：

```ts
it('explore 未取得工具证据时丢弃未经验证的正文', async () => {
  const client = new ScriptedStreamClient([
    [{ type: 'text', text: 'src contains core, editor, components' }],
  ]);
  const result = await runSubagent('list real src modules', makeReadRegistry(), {
    role: 'explore',
    client,
    maxSteps: 5,
  });

  expect(result.status).toBe('unverified');
  expect(result.evidence).toEqual({ toolCallCount: 0, successfulToolResultCount: 0 });
  expect(result.text).toContain('no successful evidence tool result');
  expect(result.text).not.toContain('core, editor, components');
});
```

`makeReadRegistry()` 必须真实注册名为 `read_file` 的测试 executor；不要 mock `runSubagent` 本身。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts -t "未取得工具证据"`

Expected: FAIL，因为当前 `SubagentResult` 没有 `status/evidence`，且会原样返回虚构正文。

- [ ] **Step 3: 在 `subagent.ts` 增加最小结果类型和证据收集**

增加以下类型；字段设为必填，使所有生产返回路径都必须明确状态：

```ts
export type SubagentStatus = 'completed' | 'incomplete' | 'unverified' | 'background';

export interface SubagentEvidence {
  toolCallCount: number;
  successfulToolResultCount: number;
}

export interface SubagentResult {
  text: string;
  isBackground: boolean;
  status: SubagentStatus;
  terminationReason: string;
  evidence: SubagentEvidence;
}
```

把 `runSubagentWithClient` 的内部返回值改为 `SubagentExecution`，并在消费 generator 时同时统计：

```ts
const EVIDENCE_TOOLS = new Set([
  'read_file', 'run_bash', 'memory_read', 'memory_list', 'read_plan_file',
]);

function isSuccessfulEvidence(name: string, output: string): boolean {
  return EVIDENCE_TOOLS.has(name)
    && !/^\s*(?:\[Tool Error\]|\[Blocked|Error:)/i.test(output);
}
```

对 `message.type === 'tool_result'` 增加计数；保留现有 assistant 最后一轮文本提取，不改 `streamingQuery`。

- [ ] **Step 4: 增加 explore 证据门槛**

在 `runSubagent` 的统一完成路径调用纯函数 `finalizeSubagentExecution`：

```ts
if (role === 'explore' && execution.successfulToolResultCount === 0) {
  return {
    text: '[Subagent unverified] Explore agent produced no successful evidence tool result. Retry with read_file or read-only run_bash.',
    isBackground: false,
    status: 'unverified',
    terminationReason: execution.terminationReason,
    evidence: {
      toolCallCount: execution.toolCallCount,
      successfulToolResultCount: 0,
    },
  };
}
```

同时在 explore prompt 加入“回答项目信息前至少成功调用一次读取工具；若不能验证就明确失败”的软约束。运行时门槛才是硬约束。

- [ ] **Step 5: 写并通过正常证据路径测试**

脚本第一轮调用 `read_file`，executor 返回真实模块列表，第二轮返回总结。断言：

```ts
expect(result.status).toBe('completed');
expect(result.evidence.successfulToolResultCount).toBe(1);
expect(result.text).toBe('Verified modules: agent, tui, ui');
```

Run: `npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts`

Expected: PASS。

- [ ] **Step 6: 更新受类型变化影响的测试夹具并提交**

把 mock runner 的返回值统一补成：

```ts
{
  text: 'subagent summary',
  isBackground: false,
  status: 'completed',
  terminationReason: 'end_turn',
  evidence: { toolCallCount: 1, successfulToolResultCount: 1 },
}
```

Run: `npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts`

Expected: all PASS。

Commit:

```bash
git add src/agent/subagent.ts src/agent/roles.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts logs/subagent-result-integrity.md
git commit -m "fix(subagent): reject unverified explore results"
```

---

### Task 2: Bug 1 — 把 max-turn 退出标记为不完整

**Files:**
- Modify: `src/__tests__/subagent-result-integrity.test.ts`
- Modify: `src/agent/subagent.ts:14-182`
- Modify: `logs/subagent-result-integrity.md`

**Interfaces:**
- Consumes: Task 1 的 `SubagentResult` / `SubagentExecution` / `finalizeSubagentExecution`。
- Produces: `terminationReason` 从真实 `loop_end` 事件取值，`max_turns` 映射为 `status: 'incomplete'`。

- [ ] **Step 1: 写 max-turn 中间文本回归测试**

脚本唯一一轮同时输出 `Now let me check the test files...` 并调用 `read_file`，`maxSteps: 1`。工具会执行，但下一轮开始前触发 max-turn：

```ts
it('达到 maxTurns 时不把最后一句过程文本当成完整结果', async () => {
  const client = new ScriptedStreamClient([[
    { type: 'text', text: 'Now let me check the test files...' },
    { type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'src' } },
  ]]);
  const result = await runSubagent('inspect tests', makeReadRegistry(), {
    role: 'explore', client, maxSteps: 1,
  });

  expect(result.status).toBe('incomplete');
  expect(result.terminationReason).toBe('max_turns');
  expect(result.text).toBe(
    '[Subagent incomplete: reached max turns (1)] Now let me check the test files...',
  );
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts -t "达到 maxTurns"`

Expected: FAIL，因为当前 `runSubagentWithClient` 没有监听 `loop_end`，无法区分 `end_turn` 与 `max_turns`。

- [ ] **Step 3: 用现有 `StreamEventBus` 捕获真实退出原因**

在 `runSubagentWithClient` 内创建独立 event bus，注册监听后传给 `streamingQuery`：

```ts
const eventBus = new StreamEventBus();
let terminationReason = 'unknown';
const onLoopEnd = ({ reason }: LoopEndEvent) => { terminationReason = reason; };
eventBus.onLoopEnd(onLoopEnd);
try {
  for await (const message of streamingQuery(client, subRegistry, prompt, {
    // existing options
    eventBus,
  })) {
    // existing collection
  }
} finally {
  eventBus.offLoopEnd(onLoopEnd);
}
```

不要修改 `streamingQuery` 的返回类型；其现有 `emitLoopEnd({ reason: 'max_turns' })` 和 `end_turn` 已是单一事实源。

- [ ] **Step 4: 在统一 finalize 函数映射不完整状态**

`max_turns` 优先于 explore 证据门槛：即使工具成功，也必须先标记不完整并保留最后文本供主 agent 诊断。

```ts
if (execution.terminationReason === 'max_turns') {
  return {
    text: `[Subagent incomplete: reached max turns (${maxTurns})] ${execution.text || '(no final text)'}`,
    isBackground: false,
    status: 'incomplete',
    terminationReason: 'max_turns',
    evidence: execution.evidence,
  };
}
```

对 `user_abort` / `error` 使用同一 `incomplete` 状态和不同前缀；只有 `end_turn` 可进入 `completed` 或 `unverified`。

- [ ] **Step 5: 覆盖后台与 Vercel fallback 的一致性**

后台完成回调必须收到同样的安全格式化文本；“已启动”立即返回：

```ts
{
  text: '[Subagent launched in background]',
  isBackground: true,
  status: 'background',
  terminationReason: 'background',
  evidence: { toolCallCount: 0, successfulToolResultCount: 0 },
}
```

Vercel fallback 用 `finishReason` 做保守映射：`stop/end-turn` 视为正常，其余原因视为 `incomplete`；不要把无法观察到的证据伪装成成功。生产 `spawn_agent` 已传 `clientProvider`，三个场景均走可观测的 streaming 路径。

- [ ] **Step 6: 运行影响测试并提交**

Run: `npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts src/__tests__/streaming-query.test.ts src/__tests__/role-agents.test.ts`

Expected: all PASS。

Commit:

```bash
git add src/agent/subagent.ts src/__tests__/subagent-result-integrity.test.ts logs/subagent-result-integrity.md
git commit -m "fix(subagent): expose incomplete max-turn exits"
```

---

### Task 3: Bug 3 — 子代理不能调用用户交互工具

**Files:**
- Modify: `src/agent/roles.ts:41-137`
- Modify: `src/index.ts:327-350`
- Modify: `src/__tests__/role-agents.test.ts`
- Modify: `logs/subagent-result-integrity.md`

**Interfaces:**
- Consumes: `filterToolsByRole(all, role)`。
- Produces: 任意明确 role 以及 fork/general 的 `*` 工具集都不含 `ask_user_question`、`exit_plan_mode`、`enter_plan_mode`。
- Produces: plan 子代理只写计划并返回摘要；主 agent 保持原交互职责。

- [ ] **Step 1: 写工具隔离失败测试**

扩展 `makeTools()` 注册 `ask_user_question`、`exit_plan_mode`、`spawn_agent`，新增：

```ts
it.each(['explore', 'plan', 'general'] as const)(
  'role=%s 不暴露用户交互或递归工具',
  (role) => {
    const result = filterToolsByRole(makeTools(), role);
    expect(result.has('ask_user_question')).toBe(false);
    expect(result.has('exit_plan_mode')).toBe(false);
    expect(result.has('spawn_agent')).toBe(false);
  },
);

it('fork 使用 role=undefined 时也应用全局子代理黑名单', () => {
  const result = filterToolsByRole(makeTools(), undefined);
  expect(result.has('ask_user_question')).toBe(false);
  expect(result.has('exit_plan_mode')).toBe(false);
  expect(result.has('spawn_agent')).toBe(false);
});
```

这里修正当前 `filterToolsByRole(role=undefined)` 直接返回全量副本的漏洞；fork 正是走该路径。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx.cmd vitest run src/__tests__/role-agents.test.ts -t "不暴露|fork 使用"`

Expected: FAIL，plan 仍含 Ask/Exit，undefined/fork 也绕过全局黑名单。

- [ ] **Step 3: 收紧全局过滤，保持主 registry 不变**

把全局黑名单定义为：

```ts
export const SUBAGENT_DISALLOWED_TOOLS = new Set([
  'spawn_agent',
  'task',
  'spawn_self_organizing',
  'ask_user_question',
  'exit_plan_mode',
  'enter_plan_mode',
]);
```

重排 `filterToolsByRole`：无论 `role` 是否存在，都先得到 `baseSubset`，最后统一删除黑名单；禁止在 `role === undefined` 时提前 return。

- [ ] **Step 4: 给 plan 子代理独立提示词和白名单**

不要修改主 agent 使用的 `src/prompts/planner.md`。在 `ROLE_REGISTRY.plan` 使用子代理专用 prompt：

```ts
systemPrompt: [
  'You are a read-only planning subagent.',
  'Inspect the codebase with read tools, then write the complete plan with write_plan_file.',
  'You cannot interact with the user and must not call ask_user_question or exit_plan_mode.',
  'If information is missing, list the exact unresolved questions in your final response.',
  'After writing the plan, return its path plus a concise summary to the main agent.',
].join(' '),
tools: [
  'read_file', 'run_bash', 'load_skill', 'memory_read', 'memory_list',
  'read_plan_file', 'write_plan_file',
],
```

更新测试：删除“plan prompt 与主 plannerPrompt 引用相等”的断言，改为断言包含 `cannot interact`、`write_plan_file`，且不包含要求调用 Ask/Exit 的语句。

- [ ] **Step 5: 从 child registry 移除交互 executor**

在 `src/index.ts` 保留 `toolRegistry.register(exitPlanTool...)` 和主 Ask 工具注册；删除：

```ts
childToolRegistry.register(exitPlanTool.definition, exitPlanTool.executor);
const askToolChild = createAskUserTool(askManager);
childToolRegistry.register(askToolChild.definition, askToolChild.executor);
```

保留 `write_plan_file` 和 `read_plan_file` 的 child 注册。这样即使将来角色白名单误改，子代理也拿不到会挂起的 executor。

- [ ] **Step 6: 跑相关回归并提交**

Run: `npx.cmd vitest run src/__tests__/role-agents.test.ts src/__tests__/ask-user.test.ts src/__tests__/plan-mode-filter.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/subagent-result-integrity.test.ts`

Expected: all PASS；主 agent Ask/Exit 测试保持通过。

Commit:

```bash
git add src/agent/roles.ts src/index.ts src/__tests__/role-agents.test.ts logs/subagent-result-integrity.md
git commit -m "fix(subagent): isolate user interaction tools"
```

---

### Task 4: 验证五场景与全仓质量门槛

**Files:**
- Modify: `logs/subagent-result-integrity.md`

**Interfaces:**
- Consumes: 前三项任务的最终行为。
- Produces: 可复现的验证记录，不依赖人工主观判断。

- [ ] **Step 1: 运行影响模块测试**

Run:

```bash
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/streaming-query.test.ts src/__tests__/task-tool.test.ts src/__tests__/ask-user.test.ts src/__tests__/plan-mode-filter.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts
```

Expected: all test files PASS，0 failed。

- [ ] **Step 2: 静态检查**

Run: `npm.cmd run typecheck`

Expected: exit 0，无 TypeScript error。

Run: `npm.cmd run lint`

Expected: exit 0，无 lint error、unused 或 floating promise。

- [ ] **Step 3: 全量测试**

Run: `npm.cmd test`

Expected: exit 0，所有 Vitest suites PASS。

- [ ] **Step 4: 用真实 CLI 重放五场景**

逐一执行原始五个提示词，并在 `logs/subagent-result-integrity.md` 记录：子代理 status、terminationReason、evidence 计数、主 agent 是否重做、是否出现用户交互挂起。

验收：

1. 正常单子代理仍返回 `completed`，主 agent 正确整合。
2. 达到上限时返回 `[Subagent incomplete: ...]`，不冒充最终答案。
3. 未成功调用读取工具时返回 `[Subagent unverified]`，不出现虚构目录正文；成功读取时目录与真实 `src/` 一致。
4. 子代理请求再 fork 或需要澄清时，以最终文本说明能力边界，不出现问卷、不挂起。
5. 三个并行子代理均能独立返回状态与结果，主 agent 正确整合。

- [ ] **Step 5: 检查用户改动未被纳入并提交验证日志**

Run: `git status --short`

Expected: `package-lock.json` 仍是用户原有未提交修改；本任务没有暂存它。

Commit:

```bash
git add logs/subagent-result-integrity.md
git commit -m "test(subagent): verify result integrity scenarios"
```

---

## Plan Self-Review

- 覆盖顺序符合要求：Bug 2 → Bug 1 → Bug 3。
- 每个 Bug 都先有可观察失败的行为测试，再做最小实现。
- 复用了现有 `StreamEventBus`、`streamingQuery`、角色过滤和 25 轮配置。
- 没有承诺无法保证的“彻底消灭所有模型幻觉”；硬保证聚焦于零工具证据输出。
- 主 agent 的用户交互不变；只收紧 child registry 与子代理过滤。
- 场景 1、5 被列为显式回归验收项。
