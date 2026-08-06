# Auto Permission Resolver 生产 dialogProvider 接线设计

> 状态：设计已批准，待 spec 审核 → writing-plans。
> 范围：为 auto permission resolver 接入真实生产 TUI dialog，复用现有 AskUserManager / permission UI，不新增第二套交互实现。
> 本文档只做设计，不含实现步骤。

---

## 1. 背景与问题

### 1.1 现状：两条 permission 路径

生产存在两条 permission 路径，职责互斥（由 mode 决定走哪条）：

| 维度 | 路径 A：`runtimeGate.channel`（legacy） | 路径 B：auto resolver `dialogProvider`（本设计接线对象） |
|---|---|---|
| 触发模式 | build/plan 的 ask，或未被 resolver 处理的 ask | auto 模式 main-origin ask（resolver 内） |
| 数据入口 | `gate.execute(decision)` → `channel.request` | `askResolver.resolve` → `resolveInteractiveAsk` |
| 决策模型 | `UserDecision`（`approved_once`+`remember` \| `rejected`） | `DialogResult`（5 种 kind） |
| UI 组件 | `getDecisionChannel()` → `askManager.ask()` 三选一问卷 | **当前缺失**（生产未传 dialogProvider） |
| classifier 竞速 | 无 | 有（automatic vs dialog delay） |
| ESC abort classifier | 无 | 需要（escape → `automatic.abort()`） |

### 1.2 问题

`resolveInteractiveAsk`（`src/permission/interactive-ask.ts`）已完整实现 classifier/dialog 竞速、ESC abort、remember（session/persist）逻辑，并有自动化测试。但生产 `createConfiguredExecutionRuntimeForTurn` 调用处（`src/index.ts`）**不传 `dialogProvider`**，因此 auto 模式 main-origin ask 实际只等待 classifier，不出现交互 dialog。

后果：设计 §8 / Task 7（A44-A47、A49）规划的竞速、ESC abort classifier、always-allow 持久化等能力，**逻辑已实现但在生产不可达**。

### 1.3 设计目标

让 auto resolver 使用真实生产 TUI dialog，复用现有 AskUserManager / permission UI 基础设施，避免新增第二套交互实现，并保持现有竞速、ESC abort、session/always remember 语义。

---

## 2. 关键事实核对（已用代码/文档确认）

### 2.1 `approved_always` 是本期必须生产能力（非未来增强）

- 设计 §8 原文：「`always allow` 产生持久化 `PermissionUpdate`，仍需重新经过完整同步管道，不能覆盖 hard deny/safety ask。」
- Task 7（A47）：「always allow persists a rule then rechecks through hard constraints」，`resolveInteractiveAsk` 已实现 `onPersistRule` + `recheckAfterPersist` 回调。
- `DialogResult` 定义了 `approved_always`，resolver 已实现其处理逻辑（`interactive-ask.ts:157-168`）。

→ 本设计必须让 `approved_always` 在生产可达。

### 2.2 ESC 与 Reject 当前不可区分 → 在 adapter 边界内解决（不改全局类型）

生产 TUI 中，ESC 键经 `use-input-handler.ts:54` → `ask.cancel()` → `ask-question-store.ts:216` 产出 `{kind:'cancelled'}`。Reject 是 `submitted` + "Reject" label。两者 outcome 不同（`cancelled` vs `submitted`），**当前 AskQuestionOutcome 已能区分**，无需新增全局 `escaped` 变体。

（早期考虑过给 `AskQuestionOutcome` 加 `escaped` 变体，经核对后移除——见 §4.1。）

### 2.3 `cancelled` 的全部生产来源（已查清）

`AskUserManager.cancelPending()` 是 **private**，唯一调用点是 `ask()` 内部（新 ask 抢占旧 pending）。`AskUserManager` 公共 API 只有 `ask()`，无 shutdown/cleanup/dispose。因此生产中 `{kind:'cancelled'}` 的来源只有两个：

1. `ask()` 内部抢占旧 pending（需新 ask 到达，触发 `cancelPending`）。
2. TUI 的 `cancel()` action（用户 ESC / 其它取消入口）。

对 auto permission dialog，来源 1 不可能发生（见 §3 并发证明），故 auto dialog 收到的 `cancelled` 唯一来自用户 ESC。

### 2.4 `AskUserManager` 是单例，3 个 `.ask()` 生产消费者

`src/index.ts:337` 单例，消费者：
1. permission channel（`index.ts:383`，gate 内）
2. `ask_user_question` 工具（`ask-user-tool.ts:63`）
3. plan approval 工具（`plan-tools.ts:154`）
4. （新增）auto permission dialog（本设计 adapter）

### 2.5 A45/§8 对「dialog 显示后 classifier 完成」未规定

- §8 原文：「自动决定在 2 秒内完成则不创建 dialog，超时才显示。ESC 产生 deny 并 abort 尚未完成的自动检查。」
- A45 测试只覆盖「2 秒内完成→不创建 dialog」与「2 秒后→dialog 启动」。
- **原文未规定**「dialog 已显示后 classifier 完成的处理」。

→ 本设计保持当前 `resolveInteractiveAsk` 实现行为（dialog 显示后 race 结束、等用户操作，classifier 完成不自动关 dialog）。这是**原文未规定区域的实现选择**，非声称与 §8/A45 一致，但不与原文冲突。理由：(a) 用户已看到 dialog，自动消失会打断审阅；(b) dialog 操作后 classifier 的 pending promise 被自然丢弃，无副作用。

---

## 3. 并发不变量（核心安全性证明）

### 3.1 不变量

> **auto permission dialog pending 期间，不存在任何其它消费者调用同一 AskUserManager.ask() 触发 cancelPending()。**

因此 auto dialog 收到的 `cancelled` 唯一来源是用户 ESC。

### 3.2 证明（基于 streaming-executor 真实调度规则）

`StreamingToolExecutor.processQueue`（`streaming-executor.ts:121-141`）并发规则：
- 只读工具可并发：`CONCURRENCY_SAFE_TOOLS = READ_ONLY_TOOLS = [read_file, glob, grep, load_skill, todo_write, schedule_list]`。
- 非只读工具串行：非并发工具遇 executing 中有其它工具 → `break`（line 129）。

auto permission dialog 发生在**非只读工具**（write_file / run_bash 等）的 `executeToolCall` 内 await。此时：
1. 该工具 `status='executing'`，`isConcurrencySafe=false`。
2. 后续任何工具（含 ask_user_question、plan approval）**都不是只读工具** → `canExecuteTool` 返回 false → `break` 等待，不执行，不调 askManager。
3. 同批次唯一可并发的只读工具（read_file 等）**都不调用 `askManager.ask()`**（纯读操作）。
4. channel dialog 与 auto dialog 互斥：auto 走 resolver 把 ask→allow/deny，gate 收到非 ask 不调 channel。

### 3.3 调度行为测试验证（已通过，作为设计证据）

经真实 `StreamingToolExecutor` queue 调度的测试证明：
- run_bash（enforced+auto）触发恰好 1 次 askManager.ask（permission dialog）。
- pending 期间 enqueue ask_user_question → **未启动**、**无第二次 askManager.ask**、**permission dialog 未收到 cancelled**。
- resolve dialog 后 run_bash 正常执行（闭环）。

### 3.4 架构耦合提示（必须固化）

此安全性依赖一个**非显式架构不变量**：
> 所有调用 `askManager.ask()` 的工具（permission/ask_user_question/plan）都是非只读工具，受 streaming-executor 串行约束；只读工具从不调 askManager。

若未来有人：(a) 把 ask_user_question 加入 READ_ONLY_TOOLS，或 (b) 引入新的调 askManager 的只读工具——`cancelled → escape` 映射将不再安全。必须用调度行为测试（§6 测试 #7）固化此不变量。

---

## 4. 方案选择

### 4.1 评估的方案

- **方案 1（3 选项，不暴露 always-allow）**：最小改动，但让 §8/A47 已实现的 `approved_always` 在生产永久不可达。✗ 否决。
- **方案 2（推荐，4 选项，复用 AskUserManager，adapter 层映射）**：auto dialog 提供独立 4 选项问卷，复用 `askManager.ask()`；adapter 层把 `AskQuestionOutcome → DialogResult`；ESC/Reject 在 adapter 边界区分（不改全局 outcome 类型）。✓ 采用。
- **方案 3（auto 专用独立问卷组件）**：为 auto 建第二套 TUI 组件。✗ 违背「复用现有 UI」，否决。

### 4.2 早期修正：不新增全局 `escaped` outcome

最初考虑给 `AskQuestionOutcome` 加 `{kind:'escaped'}` 变体以区分 ESC。经 §2.2/§3 核对后移除：auto dialog 串行，`cancelled` 唯一来源是 ESC，adapter 层直接映射 `cancelled → escape` 即可，**无需改全局类型**。这把改动从「全局 outcome 扩展」收窄到「adapter 层一个映射函数」。

---

## 5. 最终设计（方案 2）

### 5.1 数据流（接线后）

```
auto, main-origin, checker=ask → executeToolCall(line 466)
  → askResolver.resolve → resolveByClassifier（构造 PendingAutomaticDecision）
  → resolveInteractiveAsk({ automatic, dialogProvider, dialogDelayMs:2000,
                            onSessionAllow, onPersistRule, recheckAfterPersist })
       ├─ classifier 在 2s 内完成 → 返回 classifier 结果（dialog 不创建）
       └─ 超 2s → createAutoPermissionDialogProvider 调 askManager.ask（4 选项问卷）
            ├─ submitted{Allow once}    → DialogResult.approved_once
            ├─ submitted{Allow session} → DialogResult.approved_session
            ├─ submitted{Always allow}  → DialogResult.approved_always
            ├─ submitted{Reject}        → DialogResult.rejected
            ├─ cancelled（ESC）          → DialogResult.escape → automatic.abort() + deny
            └─ chat                     → DialogResult.rejected
  → handleDialogResult → SecurityDecision + 副作用（persist/session/remember）
  → effectiveDecision 回 executeToolCall → runtimeGate.execute（唯一执行入口）
```

### 5.2 outcome → DialogResult 映射（adapter 边界）

| auto dialog 收到的 outcome | 映射到 DialogResult | 语义 |
|---|---|---|
| `submitted` + "Allow once" | `approved_once` | 用户明确选，不记忆 |
| `submitted` + "Allow this session" | `approved_session` | 写 SessionAllowlist（exact match） |
| `submitted` + "Always allow" | `approved_always` | onPersistRule + recheckAfterPersist |
| `submitted` + "Reject" | `rejected` | 用户明确拒绝，不 abort classifier（race 已结束） |
| `cancelled` | `escape` | **唯一来源是 ESC**（§3）→ automatic.abort() + deny |
| `chat` | `rejected` | 用户转聊天，视为拒绝 |

映射函数 `mapDialogResult` 的文档注释**必须明确记录**：
> 「auto dialog 串行执行（streaming-executor 非只读工具串行 + 只读工具不调 askManager），因此 cancelled 的唯一来源是用户 ESC。此映射安全性依赖该架构不变量，见调度行为测试 #7。」

### 5.3 ESC / remember 语义

- **ESC**：`cancelled → escape` → `resolveInteractiveAsk` 调 `automatic.abort()`，取消还在跑的 classifier RPC（signal 贯穿 stage1/2/provider）。与 Reject（`submitted{Reject} → rejected`，不 abort）在 adapter 边界区分。
- **approved_session**：`onSessionAllow(toolName, input)` → 写 `SessionAllowlist`（exact match）。与 channel 路径的 `remember:true` 走同一 SessionAllowlist，统一存储，`add` 去重，无重复写入。
- **approved_always**：`onPersistRule({type:'addRules', destination:'userSettings', rule})` → `ConfigStore.persistPermissionUpdate`，随后 `recheckAfterPersist()` 重新过 checker，hard deny/safety 兜底（不绕过）。

### 5.4 与 `runtimeGate.channel` 的关系（无双重 dialog）

auto 模式 ask **先进 resolver**（executeToolCall line 466：askResolver 存在 + mode=auto）。resolver 把 ask 解析为 allow/deny 后，`effectiveDecision` 到 gate 时已非 ask → gate **不调 channel.request**（channel 只在 ask 时被调用）。故 auto dialog 与 channel dialog **永不串联**。

---

## 6. 最小文件改动范围

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/permission/interactive-ask.ts` | **不改** | 逻辑已完整 |
| `src/permission/ask-resolver.ts` | **不改** | 已支持 dialogProvider |
| `src/agent/ask-user-types.ts` | **不改** | 不新增 escaped 变体 |
| `src/tui/state/ask-question-store.ts` | **不改** | 不新增 escape action |
| `src/tui/input/use-input-handler.ts` | **不改** | ESC 仍走 cancel() |
| `src/permission/permission-answer-mapping.ts` | **新增** `mapDialogResult(input, outcome)`：`AskQuestionOutcome → DialogResult`（纯函数，含 cancelled→escape） | 新增 |
| `src/index.ts` | (a) 新增 `createAutoPermissionDialogProvider(askManager, ...)`：`InteractiveAskInput` → 4 选项问卷 → `askManager.ask` → `mapDialogResult` → `DialogResult`，内含 `onSessionAllow` / `onPersistRule`（→ConfigStore.persistPermissionUpdate）/ `recheckAfterPersist`（→checker 重检）；(b) `createConfiguredExecutionRuntimeForTurn` 调用处传 `dialogProvider` + `dialogDelayMs: 2000` | 新增 adapter + 1 处 wiring |
| `src/__tests__/permission/`（新增测试文件） | 行为验收矩阵（§7） | 新增 |

共 3 个生产/测试文件改动。**TUI 层零改动**。

---

## 7. 行为验收矩阵（经 executeToolCall / StreamingToolExecutor 端到端，不读源码字符串）

注入：spy `dialogProvider`（模拟 askManager.ask，返回脚本化 DialogResult）+ spy `runtimeGate.channel`（验证是否被调）+ 真实 PermissionChecker + 真实 SessionAllowlist + mock classifier。

| # | 测试 | 断言（行为） |
|---|---|---|
| 1 | unresolved ask 超 delay → 调 dialog | classifier 永不 resolve；dialogDelayMs=0；dialogProvider 被调用 ≥1 次；resolver 返回 dialog 结果 |
| 2 | dialog 选择 → 对应 DialogResult 生效 | dialog 返回 approved_session；`sessionAllowlist.has(tool,input)` 为 true；gate 收到 allow |
| 3 | **gate 不重复调 channel**（双重 dialog 防护） | dialog 返回 allow；`channel.request` 调用次数 = **0** |
| 4 | approved_always 连真实 persistence + recheck | dialog 返回 approved_always；注入 spy persist + 硬 deny checker；persist 被调；recheck 返回 deny；gate 收到 deny |
| 5 | **ESC/cancel 的 classifier abort** | classifier pending；dialog 返回 escape（由 cancelled 映射）；classifier `signal.aborted === true`；Stage2=0；executor=0；最终 deny |
| 6 | classifier 在 delay 内完成 → 不调 dialog | classifier 立即 resolve allow；dialogDelayMs 大；dialogProvider 调用次数 = **0**；gate 收到 allow |
| 7 | **调度不变量**（经真实 StreamingToolExecutor queue） | run_bash 触发 1 次 askManager.ask；pending 期间 enqueue ask_user_question → **未启动**、**无第二次 askManager.ask**、**dialog 未收到 cancelled**；resolve 后 run_bash 闭环 |

`mapDialogResult` 另有独立单元测试（5 种 outcome × 4 种 answer label → 正确 DialogResult）。

源码契约测试（读 index.ts 断言传了 dialogProvider）**不作为主要验收**，因行为测试已从最接近生产的入口证明 wiring。

---

## 8. 竞态检查

| 竞态场景 | 处理 |
|---|---|
| 双重 dialog（resolver + channel 同时弹） | resolver 把 ask→allow/deny 后，gate 收到非 ask，不调 channel。由 executeToolCall 分支顺序天然保证；测试 #3 验证 channel.request=0 |
| dialog 显示后 classifier 完成 | §2.5：原文未规定；保持当前实现（等用户）；spec 标注为「未规定区域的实现选择」 |
| approved_always vs classifier 同时 deny | `recheckAfterPersist` 重新过 checker，hard deny 兜底；测试 #4 验证 |
| 重复 remember 写入 | channel 与 auto dialog 都写同一 SessionAllowlist（exact match，`add` 去重） |
| dialog 残留 | 同「dialog 显示后 classifier 完成」；dialog 只在用户操作后关闭 |
| 非 ESC 的 pending 取消被误判为 escape | §3 并发不变量保证不可能；测试 #7 固化 |

---

## 9. 范围外（本设计不做）

- 不实现「dialog 显示后 classifier 完成自动关闭 dialog」（原文未规定，作为未来独立增强）。
- 不改 `AskQuestionOutcome` 全局类型（adapter 边界内解决 ESC/Reject 区分）。
- 不新建第二套 TUI 问卷组件（复用 AskUserManager / ask-question-store）。
- 不改 `interactive-ask.ts` / `ask-resolver.ts`（逻辑已完整，只缺生产 caller 传 options）。
- 不动 legacy channel 路径（build/plan 继续走 channel）。

---

## 10. 自审检查清单

- [x] 无 TBD/占位/未完成段落。
- [x] §5 数据流与 §7 测试矩阵一致；§3 并发证明与 §4.2 修正一致。
- [x] 范围聚焦：单个实现计划可覆盖（3 文件改动 + 1 测试文件）。
- [x] 无歧义：cancelled→escape 的安全性、dialog 显示后行为、与 channel 的互斥均已明确。
