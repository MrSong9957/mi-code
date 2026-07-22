# Subagent Visibility and Plan Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task-by-task.

**Goal:** 让子代理工具调用从开始时就可见，并保证计划审批只能提交当前 session、当前用户轮次内新写入的 pending 计划。

**Architecture:** TUI 以 `toolUseId` 创建并原地完成待定工具消息，保留并行调用的稳定位置；计划系统以 `PlanContext(sessionId, turnId)` 分离本轮 active plan 与历史恢复；planner prompt 允许信息请求正常结束，并限制 Ask/Exit 的调用条件。

**Tech Stack:** TypeScript、Node.js ESM、Zustand、Vitest、现有 `BlockPipeline` / `MessagesStore` / `PlanStore`

## Global Constraints

- 目标 worktree：`D:\Files\Projects\mi-code\.worktrees\auto-0025`，计划编写基线 HEAD `f422eff`。
- 保留用户已有的 `package-lock.json` 修改，不暂存、不覆盖。
- 严格执行 RED → GREEN → REFACTOR；先跑最低层当前测试，最后才跑全量测试。
- 不改子代理执行质量策略，不试图用 UI 改动掩盖真实供应商延迟。
- 不删除历史计划恢复功能；把它改为显式、同 session 的恢复路径。

## Wheel Reuse Check

- 复用 `ToolCallEvent.startTime` 与 `toolUseId`，不新增第二套工具生命周期标识。
- 复用 `BlockPipeline` 的格式化、折叠结果、hook 和兼容 FIFO 逻辑。
- 复用 `MessagesStore` 作为唯一 TUI 消息状态入口，新增窄更新接口。
- 复用现有 plan frontmatter、审批 UI 和状态标记，仅补充 session/turn 边界。

## Core Anchor Functions

- UI：`BlockPipeline.emit()`，输入工具生命周期块，输出可见且顺序稳定的消息状态。
- Plan：`createExitPlanModeTool().executor()`，输入当前轮计划上下文，决定是否允许打开审批 UI。

---

### Task 1: 工具调用开始时立即显示，并在结果到达时原地完成

**Files:**
- Modify: `src/tui/types.ts`
- Modify: `src/tui/state/messages-store.ts`
- Modify: `src/tui/state/pipeline-adapter.ts`
- Modify: `src/ui/block-pipeline.ts`
- Modify: `src/__tests__/tui/messages-store.test.ts`
- Modify: `src/__tests__/tui/pipeline-integration.test.ts`
- Modify: `src/__tests__/ui/block-pipeline.test.ts`
- Create: `logs/subagent-visibility-and-plan-isolation.md`

- [ ] **Step 1: 写“调用事件单独到达即显示”的失败测试**

在 pipeline 集成测试中只 emit `tool_call`，暂不 emit result：

```ts
pipeline.emit({
  kind: 'tool_call',
  name: 'spawn_agent',
  input: { role: 'explore', prompt: 'inspect skills' },
  toolUseId: 'spawn-1',
});

expect(store.getState().messages.at(-1)?.lines.join('\n'))
  .toContain('● spawn_agent');
expect(store.getState().messages.at(-1)?.finalized).toBe(false);
```

Run: `npx.cmd vitest run src/__tests__/tui/pipeline-integration.test.ts -t "调用事件单独到达"`

Expected: FAIL；当前 `tool_call` 只进入 `toolBuffer`，store 中没有消息。

- [ ] **Step 2: 写 MessagesStore 按 toolUseId 原地完成的失败测试**

为两个 pending 工具依次分配 `t1`、`t2`，倒序 resolve；断言数组顺序仍是 t1、t2，每条只出现一次，且均 finalized。再覆盖未知 ID 不误改其他消息。

Run: `npx.cmd vitest run src/__tests__/tui/messages-store.test.ts -t "pending tool"`

Expected: FAIL；当前 store 没有按工具 ID 建立/更新消息的接口。

- [ ] **Step 3: 增加最小消息元数据和 store 接口**

在 `TuiMessage` 增加仅供工具进度使用的可选字段：

```ts
kind?: 'turn-duration' | 'tool-progress';
toolUseId?: string;
```

在 `MessagesState` 增加：

```ts
appendPendingTool(toolUseId: string, lines: string[]): string;
resolvePendingTool(toolUseId: string, lines: string[]): boolean;
```

`appendPendingTool` 返回消息 uuid；`resolvePendingTool` 只更新匹配的 pending 消息并设为 finalized，找不到时返回 false 供兼容路径处理。不要增加通用“任意修改消息”API。

- [ ] **Step 4: 扩展 renderer adapter，并让 BlockPipeline 立即创建 pending 消息**

给 `PipelineRenderer` 增加窄接口（名称可匹配项目现有风格）：

```ts
startToolCall(toolUseId: string, lines: StyledLine[]): void;
finishToolCall(toolUseId: string, lines: StyledLine[]): boolean;
```

`tool_call` 到达时格式化调用行并立即 `startToolCall`。仍在内部保存必要的 call 元数据，以便 result、hook、折叠全文和无 ID FIFO 兼容；匹配 result 时构造完整调用+结果行并 `finishToolCall`，不追加第二条重复消息。

- [ ] **Step 5: 锁定并行顺序、hook、折叠和孤儿调用行为**

补充测试：

1. 两个 call 立即按调用顺序可见，result 倒序到达后位置不变。
2. hook 附着到正确的 result，不串到另一条 pending call。
3. 截断结果仍注册原有 expandable block。
4. `clear()` 或 loop 结束时，无结果调用被 finalized 为可诊断的孤儿状态。
5. 无 `toolUseId` 的旧事件继续走 FIFO，不破坏已有测试。

Run: `npx.cmd vitest run src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/tui/messages-store.test.ts`

Expected: all PASS。

- [ ] **Step 6: 记录可见性根因和验证证据**

在日志中记录：调用事件已到达、旧实现等待 result 才落屏、RED/GREEN 测试输出。若需要诊断真实启动耗时，记录 `ToolCallEvent.startTime` 到首个子代理事件/结果的差值；不要把该指标混入消息排序逻辑。

Commit:

```bash
git add src/tui/types.ts src/tui/state/messages-store.ts src/tui/state/pipeline-adapter.ts src/ui/block-pipeline.ts src/__tests__/tui/messages-store.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/ui/block-pipeline.test.ts logs/subagent-visibility-and-plan-isolation.md
git commit -m "fix(tui): show pending tool calls immediately"
```

---

### Task 2: 计划审批只接受当前用户轮次写入的计划

**Files:**
- Modify: `src/plan/plan-store.ts`
- Modify: `src/agent/tools/plan-tools.ts`
- Modify: `src/index.ts`
- Modify: `src/__tests__/plan-approval.test.ts`
- Modify: `logs/subagent-visibility-and-plan-isolation.md`

- [ ] **Step 1: 写跨 session、跨 turn 的旧计划泄漏回归测试**

增加以下最低层行为测试：

```ts
const old = { sessionId: 's1', turnId: 'turn-1' };
const now = { sessionId: 's1', turnId: 'turn-2' };
store.beginTurn(old);
store.write(old, '# old performance plan');
store.beginTurn(now);

expect(store.getActive(now)).toBeNull();
```

另建 `sessionId: 's2'`，确认即使其计划文件 mtime 最新，也不能被 s1 当前轮取得。

Run: `npx.cmd vitest run src/__tests__/plan-approval.test.ts -t "current turn"`

Expected: FAIL；当前 `getCurrent()` 会全局恢复最新文件。

- [ ] **Step 2: 写 exit_plan_mode 的硬边界失败测试**

构造目录中已有旧计划、当前轮未调用 write 的工具实例，执行 `exit_plan_mode`：

```ts
expect(await tool.executor({})).toContain('No plan was written in the current turn');
expect(openApproval).not.toHaveBeenCalled();
```

再写正向测试：同一 context 本轮 write 后，审批 UI 收到的恰是该计划。

Run: `npx.cmd vitest run src/__tests__/plan-approval.test.ts -t "exit_plan_mode"`

Expected: 新的隔离用例 FAIL。

- [ ] **Step 3: 在 PlanStore 分离 active 与 recovery API**

增加：

```ts
export interface PlanContext {
  sessionId: string;
  turnId: string;
}

beginTurn(context: PlanContext): void;
write(context: PlanContext, content: string): string;
getActive(context: PlanContext): PlanEntry | null;
recoverLatestForSession(sessionId: string): PlanEntry | null;
```

`PlanEntry` 和 frontmatter 加入 `sessionId`、`turnId`、`status`。`getActive` 不允许目录扫描回退；只返回与 context 完全匹配的 pending 计划。审批/拒绝后清除 active 引用。

把原有“重启后恢复最新计划”测试改成显式调用 `recoverLatestForSession('sess-1')`，并新增“不同 session 不恢复”。不要用全局最新文件维持旧断言。

- [ ] **Step 4: 把 PlanContext 贯穿三个计划工具**

把 `createWritePlanTool`、`createReadPlanTool`、`createExitPlanModeTool` 改为通过依赖闭包读取当前 `PlanContext`。`exit_plan_mode` 只调用 `getActive(context)`；失败时返回工具错误，不打开 UI，也不把任何历史内容放进返回值。

若 `read_plan_file` 仍需查看历史计划，必须显式使用 session-scoped recovery；读取历史不能隐式激活审批能力。

- [ ] **Step 5: 在每个新用户提交开始时建立 turn context**

在 `src/index.ts` 的用户提交入口、构建/执行本轮 agent 工具之前生成唯一 `turnId`，调用：

```ts
currentPlanContext = { sessionId, turnId: crypto.randomUUID() };
planStore.beginTurn(currentPlanContext);
```

工具工厂持有 `() => currentPlanContext`，确保同一轮共享、下一轮失效。不要用消息文本、时间戳猜测轮次归属。

- [ ] **Step 6: 跑计划模块回归并记录证据**

Run: `npx.cmd vitest run src/__tests__/plan-approval.test.ts src/__tests__/plan-mode-streaming.test.ts`

Expected: all PASS，包括：当前轮未写不可审批、跨 turn/session 不泄漏、本轮写入可审批、显式恢复仍可用。

Commit:

```bash
git add src/plan/plan-store.ts src/agent/tools/plan-tools.ts src/index.ts src/__tests__/plan-approval.test.ts logs/subagent-visibility-and-plan-isolation.md
git commit -m "fix(plan): scope approvals to the active turn"
```

---

### Task 3: 修正计划模式的 Ask/Exit 控制流

**Files:**
- Modify: `src/prompts/planner.md`
- Modify: `src/prompts/planner.generated.ts`
- Modify: `src/agent/tools/ask-user-tool.ts`
- Modify: `src/__tests__/plan-mode-streaming.test.ts`
- Modify: `logs/subagent-visibility-and-plan-isolation.md`

- [ ] **Step 1: 写提示词行为契约失败测试**

在计划模式测试中断言生成的 planner prompt：

- 包含“信息/只读请求可直接回答并 end_turn”。
- 包含“Ask 仅用于阻塞当前任务的必要澄清，禁止任务完成后的泛化追问”。
- 包含“Exit 仅在本轮 write_plan_file 成功后使用”。
- 不再包含 `Every turn MUST end with either ask_user_question or exit_plan_mode`。

Run: `npx.cmd vitest run src/__tests__/plan-mode-streaming.test.ts -t "planner control flow"`

Expected: FAIL；当前提示词仍强制每轮 Ask/Exit。

- [ ] **Step 2: 最小修改 planner prompt 与 Ask 工具描述**

把无条件收尾规则改成条件控制流：

```md
- For informational or read-only requests, answer directly and end the turn.
- Use ask_user_question only when an unresolved choice blocks the current planning task.
- Never ask a generic “anything else?” question after completing the request.
- Call exit_plan_mode only after write_plan_file succeeded in this user turn.
- If the user says there is no other task, end the turn.
```

在 Ask 工具描述中同步加入“非完成后礼貌追问”的限制，但不改 `AskUserManager` 生命周期。

- [ ] **Step 3: 重新生成 prompt 并验证生成文件一致**

Run: `node scripts/gen-prompts.mjs`

Expected: 只更新 planner 对应生成内容，不出现无关 prompt 变化。

Run: `npx.cmd vitest run src/__tests__/plan-mode-streaming.test.ts src/__tests__/plan-approval.test.ts`

Expected: all PASS。

Commit:

```bash
git add src/prompts/planner.md src/prompts/planner.generated.ts src/agent/tools/ask-user-tool.ts src/__tests__/plan-mode-streaming.test.ts logs/subagent-visibility-and-plan-isolation.md
git commit -m "fix(plan): allow non-planning turns to end normally"
```

---

### Task 4: 综合验证与场景复测

**Files:**
- Modify: `logs/subagent-visibility-and-plan-isolation.md`

- [ ] **Step 1: 运行影响模块测试**

Run:

```bash
npx.cmd vitest run src/__tests__/ui/block-pipeline.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/tui/messages-store.test.ts src/__tests__/plan-approval.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/subagent-result-integrity.test.ts
```

Expected: all PASS。

- [ ] **Step 2: 运行静态检查**

Run: `npm.cmd run typecheck`
Expected: exit 0。

Run: `npm.cmd run lint`
Expected: exit 0；若项目没有 lint script，记录真实输出，不伪造成功。

- [ ] **Step 3: 运行完整测试**

Run: `npm.cmd test`
Expected: exit 0，记录测试文件数和测试数。

- [ ] **Step 4: 手工复测用户场景**

在计划权限模式输入“用子代理告诉我你能看到哪些技能”，验证：

1. `spawn_agent(...)` 在子代理返回前立即出现，并显示为待定状态。
2. 子代理完成后同一消息原地出现结果，不重复、不乱序。
3. 主 agent 直接总结，不发“是否还有其他任务”的泛化 Ask。
4. 若测试性触发 Ask 并选择“没有其他任务”，当前轮直接结束。
5. 计划目录即使已有“MiCode 性能优化改造计划”，当前轮未 write 时也不会打开审批 UI。

- [ ] **Step 5: 请求代码审查并完成验证记录**

使用 `superpowers:requesting-code-review` 检查正确性、并行排序、计划隔离和兼容性；修复阻塞问题后重新运行受影响测试。最后使用 `superpowers:verification-before-completion` 核对实际命令输出，并把 RED/GREEN、静态检查、全量测试、手工复测结果写入日志。

Commit:

```bash
git add logs/subagent-visibility-and-plan-isolation.md
git commit -m "test(plan): verify tool visibility and plan isolation"
```
