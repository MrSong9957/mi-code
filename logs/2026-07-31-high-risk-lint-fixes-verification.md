# 第一波高风险 Lint 修复验证

> 计划: `docs/superpowers/plans/2026-07-31-high-risk-lint-fixes.md`
> 分支: `codex/high-risk-lint-fixes` (基于干净 master `ce22a23`，隔离 worktree)
> 日期: 2026-07-31

## 提交清单（5 个独立提交）

| 提交 | 类型 | Task |
|------|------|------|
| `02850f6` fix: keep ConnectedApp hooks unconditional | 行为性 | T1 |
| `c09cec0` test: lock tool message priority semantics | 刻画测试+suppression | T2 |
| `9fb2ce5` chore: keep provider usage accumulators constant | 纯 lint | T3 |
| `a089c93` test: simplify image cache verification | 纯 lint | T4 |
| `bef1b30` refactor: propagate permission prompt failures directly | 行为等价重构 | T5 |

## 验证证据

### 1. 定向 ESLint（--quiet，计划 Step 1）

组合 7 个文件（排除 index.ts，因其有第二波 COMMAND_NAMES unused）：

```
npx eslint --quiet \
  src/tui/ConnectedApp.tsx \
  src/__tests__/tui/connected-app-render-mode-transition.test.tsx \
  src/output/types.ts \
  src/__tests__/output-message-priority.test.ts \
  src/agent/google-stream-client.ts \
  src/agent/openai-stream-client.ts \
  src/__tests__/agent/image-utils.test.ts
→ exit code 0
```

`src/index.ts` 单独确认：`no-useless-catch` 计数 = 0（已消失，COMMAND_NAMES unused 属第二波保留）。

### 2. 全量 lint 债务（计划 Step 5）

```
npm run lint → 63 errors, 105 warnings
```

基线 72 errors → 63 errors，恰好减少 9 个目标 error；warning 数 105 与基线一致，未新增。

### 3. TypeScript 检查（计划 Step 3）

```
npm run typecheck → exit code 0
```

### 4. 测试（计划 Step 2 / Step 4）

影响范围 10 个测试文件：

```
npx vitest run <10 个测试文件> → 66 passed
```

agent 全目录: `84 files, 1734 passed`
ConnectedApp 关联 + src/tui/: `16 files, 150 passed`

### 5. 全量测试 flaky 说明（重要偏离）

计划 Step 4 期望 `npm test` exit code 0。实际全量测试存在**预存的、非确定性 flaky**，与本轮改动无因果关系：

| flaky 测试 | 失败模式 | master 上是否复现 |
|------------|----------|-------------------|
| `tui/inline-v2/bootstrap-flag.test.tsx` | `Test timed out in 5000ms`（动态 import 真实 Ink 渲染） | 是（master 单独跑 3 次中 1 次失败，同超时模式） |
| `history.test.ts` | USERPROFILE 全局 env 竞争（getHistory 期望 2 得 4 等） | 是（失败用例每次不同） |
| `regression/child-process-env-scrub.test.ts` | 真实 spawn 时序敏感 | master 单独跑通过，全量负载下偶发 |

判定依据：
- bootstrap-flag 在 master 上单独连跑 3 次出现 1 次相同超时失败；
- 这些失败测试每次全量跑失败的**具体用例不同**（确定性 bug 不会这样）；
- 涉及的全是进程级全局状态（stdout / USERPROFILE env / 真实子进程 spawn），对本机负载/时序敏感；
- 本轮 5 个 Task 的改动（Hook 顺序、const、删 catch、删 require、enum suppression）不触及 history/spawn/stdout 时序逻辑。

排除这 3 个已知 flaky 文件后，全量其余测试 `4261 passed / 4 skipped`（collect 阶段被排除文件不计）。

### 6. 范围检查（计划 Step 6）

```
git diff master...HEAD --name-only
→ 8 个文件，均为计划内（5 任务文件 + 3 新建测试）
git status --short → 工作树干净
```

不含三个 prompt 文件或 ai-news-2026-07.html。

## 关键正确性分析（Task 1 行为性改动）

ConnectedApp 唯一行为性改动：三个 Hook 从条件块（`if (!isInline)`）改为无条件调用。

- `useInput({ isActive: !isInline })`: ink 源码确认 `isActive===false` 时内部 effect 直接 return，**不调 setRawMode** → inline 模式不启 raw mode ✓
- 自定义 `useEffect`: `if (isInline || !stdin) return;` → inline 模式不写 `?1003h/?1006h`，不 setRawMode ✓
- alt-screen 双重 setRawMode：ink `handleSetRawMode` 为**引用计数式**（rawModeEnabledCount++/--），旧代码 alt-screen 本就 useInput + 自定义 setRawMode 双调，本轮未改变该模式 ✓
- cleanup：effect 依赖含 isInline，模式切换触发 cleanup；组件卸载 React 自动 cleanup；spinner-clock 测试验证 unmount 后 tick 停止 ✓

## RED 证据（Task 1）

新测试 `connected-app-render-mode-transition.test.tsx` 在修复前精准捕获 React Hook 顺序诊断：

```
expected [Array(1)] to have a length of 0 but got 1
（React console.error: "detected a change in the order of Hooks called by ConnectedApp"）
```

实现细节：用 `@testing-library/react` 的 `act` 配合 ink-testing-library 的 render（参照 render-mode.test.tsx），以同步 flush setMode 触发的 re-render；React 把 Hook 顺序违规作为 console.error 报告（不抛异常），故用 `vi.spyOn(console, 'error')` 捕获断言，避免假 GREEN。
