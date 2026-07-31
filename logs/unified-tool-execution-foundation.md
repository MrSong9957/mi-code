# 统一工具执行基线验证

> 计划: `docs/superpowers/plans/2026-07-31-unified-tool-execution-foundation.md`
> 设计: `docs/superpowers/specs/2026-07-31-unified-tool-execution-design.md`
> 分支: `codex/unified-tool-execution-foundation`（基于 master `206f4f7`，无 worktree）
> 基线提交（pre-implementation）: `206f4f7`
> 日期: 2026-07-31

## 提交清单（10 个独立提交）

| 提交 | Task | 说明 |
|------|------|------|
| `a4fa50f` feat: define unified tool execution contracts | T1 | Registry.get() + 契约类型 |
| `e59723e` feat: validate and authorize unified tool calls | T2 | lookup/递归校验/权限/成功 |
| `4eecfd3` feat: enforce pre-execution input invariants | T3 | Pre 回调 + 最终输入同一性 |
| `788871f` feat: classify operational tool failures | T4 | 操作错误分类，程序错误冒泡 |
| `b0b4561` feat: preserve results across callback failures | T5 | Post/Failure 异常不抹除事实 |
| `7497b8b` refactor: route streaming tools through unified execution | T6 | P1 流式执行器迁移 |
| `4fd8450` refactor: unify serial tool execution | T7 | P5 串行回退迁移 |
| `d17c699` refactor: share execution runtime with child agents | T8 | P2-P4 子代理共享 Runtime |
| `733de2c` chore: guard unified tool execution paths | T9 | ESLint 守卫 + 源边界回归测试 |
| `204451b` fix: resolve repo root independent of process.cwd() | T9-fix | 边界测试 cwd 隔离修复 |

## 核心数据/控制流

```
ToolRegistry.get(name) ── 完整 { definition, executor } 对
        │
        ▼
executeToolCall(registry, call, runtime, context)
        │
        ├─ performance.now() 起点；structuredClone(call.input) 原始快照
        ├─ registry.get(call.name) → 未知工具 → failure(unknown_tool/lookup)
        ├─ validateToolInput(snapshot, schema) → 无效 → failure(invalid_input/validation)
        ├─ onPreExecute(冻结副本) → { updatedInput } 整体替换 → 再校验
        │       Pre 不变量违例 → PreCallbackInputViolation 冒泡（无结果）
        ├─ 两份独立深拷贝：executorInput(可变,给权限+executor) / inputUsed(冻结,入结果)
        ├─ permissionChecker.checkDecision(name, executorInput, ...) → decision
        ├─ runtimeGate.execute(decision, executorCallback)
        │       DeniedAction → failure(permission_denied/permission)
        │       executor 抛错 → classifier：ToolOperationalError/errno→operational,
        │                        AbortError→cancelled, TimeoutError→timeout,
        │                        其余原样冒泡（TypeError 等）
        ├─ 成功 → finalizeSuccess(onPostExecute)
        └─ 失败 → finalizeFailure(onFailure)
    durationMs 在进入通知回调前冻结（回调耗时不计入）
```

迁移后 P1-P5 调用面：
- 流式（P1）：`StreamingToolExecutor` 仅调 `executeToolCall()`，保留 `executionResult`。
- 串行（P5）：`streamingQuery` 串行回退删除 `checkPermissionOrBlock()`，改调 `executeToolCall()`。
- 子代理（P2-P4）：`runSubagent` / `runSelfOrganizingSubagent` / 三个工具工厂接收同一 `executionRuntime`，透传到 `streamingQuery()`。

## TDD RED 证据

每个 Task 均先写失败测试、确认失败原因正确、再实现：

- **T1 RED**：`registry.get is not a function`（方法不存在）。
- **T2 RED**：8 个行为测试 `executeToolCall 不存在`。
- **T2 过程修正**：permission_denied 分支初版无独立 RED，主动撤回、补真实 Gate 拒绝测试观察失败、再恢复。
- **T3 RED**：Pre 快照冻结/二次校验/同一性 19 例失败。
- **T4 RED**：4 个应结构化的 operational/abort/timeout 用例失败；4 个应冒泡的已通过。
- **T5 RED**：Post/Failure 的 6 条后处理测试失败；deferred 证明入口在通知前就返回。
- **T6 RED**：旧双路径构造函数与新 `new StreamingToolExecutor(registry, runtime, signal)` 不匹配。
- **T7 RED**：串行路径缺 `executionRuntime` 不变量、串流/串行拒绝不一致等 5 例。
- **T8 RED**：三个适配器捕获的 `executionRuntime` 为 `undefined`。
- **T9 RED**：ESLint `lintText` 返回空消息（`no-restricted-syntax` 未配置）。

## 实施中遇到的失败与原因

### 1. Task 6 接口不符（计划 vs 真实代码）
计划写 `waitForAll()`，真实 `StreamingToolExecutor` 用 `getRemainingResults()`。按真实控制流调整：后台执行暂存原始异常，AsyncGenerator 消费时原样抛出。

### 2. Task 6 测试时序假设失效
迁移后真实 Gate 引入异步授权边界，测试假定 "executor 在 addTool() 返回前同步进入" 不再成立。改为等待第一个 executor 实际进入再验证第二个未启动，不放宽 "两个 ask 串行且有序" 的业务约束。

### 3. Task 9 边界测试全量套件失败（本计划引入，已修）
**现象**：`unified-tool-execution-paths.test.ts` 单文件 11/11 通过，但全量 `npm test` 时 12 例失败（`ENOENT` 读不到 `src/index.ts`、ESLint `Could not find config file`）。
**根因**（systematic-debugging）：测试用 `process.cwd()` 作读取基准；`worktree-integration.test.ts` 全量并发时会 `process.chdir()` 到临时目录，污染 cwd。
**修复**：改用 `import.meta.url` 从测试文件位置解析仓库根（`fileURLToPath` → 回推三级），与 cwd 解耦。提交 `204451b`。
**验证**：单文件 + worktree-integration 同跑 21/21 通过；全量 4351/4351 通过。

## 已知破坏性子代理行为变化（Task 8）

迁移前：子代理的 `ask` 决策静默放行（自动 auto-allow）。
迁移后：子代理 `ask` 决策使用主 `RuntimeSecurityGate`，**等待用户显式批准**。

证据测试（`subagent-permission-passthrough.test.ts`）：
- `keeps a child ask blocked until the shared gate approves once`：批准前 executor 调用数 = 0，`approved_once` 后 = 1。
- `reports permission_denied to the child when the shared gate rejects`：拒绝时 executor 不执行，子代理收到 `permission_denied`。

`subagent.ts:412` 与 `self-organizing.ts:164` 已加源注释标记此为有意行为变化。委派授权继承（delegated authorization inheritance）仍超出本计划范围。

## 推迟的路径（E3/E4）

- **E3 — `src/agent/loop.ts`**：仍含 2 处 `registry.execute()`（line 265、293），是显式推迟的 legacy 路径。ESLint 守卫已为其配置白名单（`files: ['src/agent/loop.ts', ...]` 关闭 `no-restricted-syntax`）。
- **E4 — Vercel AI SDK 回退**：`runWithVercelAI()` 仍只消费 `permissionChecker`（`subagent.ts:644`、`709`，均带 `// E4 deferred` 注释），未走统一入口。无流式 client 时保留该路径。
- `src/agent/dispatch-map.ts`：独立 legacy 调度路径，不被 P1-P5 引用，`.executor()` 直调保留，不在本计划范围。
- `src/agent/llm-vercel.ts`：不同直执行模式，ESLint 守卫**未**加白名单，作为单独 E4 项保留。

## 验证命令与结果

### Task 10.1 聚焦集成测试矩阵

```
npx vitest run src/__tests__/agent/tool-execution.test.ts
→ 36 passed                                              # 核心单元边界

npx vitest run src/__tests__/streaming-executor.test.ts \
  src/__tests__/regression/permission-executor-integration.test.ts \
  src/__tests__/regression/streaming-permission-passthrough.test.ts
→ 30 passed                                              # P1/P5

npx vitest run src/__tests__/regression/subagent-permission-passthrough.test.ts \
  src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts \
  src/__tests__/spawn-self-organizing-tool.test.ts src/__tests__/worktree-integration.test.ts
→ 56 passed                                              # P2-P4

npx vitest run src/__tests__/regression/unified-tool-execution-paths.test.ts
→ 11 passed                                              # 静态边界 + ESLint
```

### Task 10.2 全套仓库检查

```
npm run typecheck  → exit 0（无错误）
npm run build      → exit 0（planner/system.generated.ts 重新生成）
npm test           → 299 files, 4351 passed | 4 skipped | 0 failed
npm run lint       → 64 errors, 106 warnings（全部为基线既有，见下）
```

**lint 基线证明**（计划 10.2 方法）：
基线提交 `206f4f7`（Task 1 之前）源码已含本次改动文件中仅有的两个问题：
- `src/index.ts:47` `COMMAND_NAMES` unused — 基线时即仅在 import + 注释（line 449）引用；本次未改动该 import。引入提交 `da0e9e3`。
- `src/agent/streaming-query.ts` `eslint-disable no-constant-condition`（`while(true)`）— 基线 line 501 已有；本次因删除 `checkPermissionOrBlock()` 行号前移至 443，内容未变。

其余 62 个 error 全部位于 TUI / colors / theme / utils 等本次未触及模块。按计划 10.2，基线既有失败不在本计划修复范围。

### Task 10.3 手动源码审计

```
registry.execute( / this.registry.execute(  → 仅 src/agent/loop.ts（E3 推迟）
permissionChecker: / runtimeGate:           → 仅 tool-execution.ts 接口声明 + subagent.ts Vercel 回退（E4）
无 Hook loader / ledger / 委派授权 / AJV / schema 依赖新增
ToolExecutionFailureDetail 未导出（保持内部）
CallbackError 保持导出
```

## 范围确认

- 无 Hook 发现/配置、验证账本、委派子授权、AJV 或投机抽象被加入。
- `ToolRegistry.execute()` 保持 public 且未改，服务显式推迟的 legacy 路径。
- P1-P5 迁移后无 `registry.execute()` 直调（ESLint + 源边界测试双重守卫）。
