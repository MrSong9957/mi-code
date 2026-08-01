# Build 模式权限分层:Origin 静默执行 + Session Allowlist 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Build 模式下子代理静默执行已通过安全判定的普通写操作(不打扰用户),主 Agent 保留询问并新增 "Allow this exact action for this session" 便捷选项,同时绝不放松危险命令/越界路径/不可解析命令的硬安全拦截。

**Architecture:** PermissionChecker 继续作为唯一安全规则源。仅在当前缺失的 `unresolvable variable` 决策点新增一个稳定 reason_code,其余已有 reason_code/risk_kind/deciding_layer 保持原值不变。在 `executeToolCall` 的 `checkDecision` 之后、gate 执行之前,按 per-invocation `origin`(main/subagent)路由:子代理的 safety_uncertain ask 静默 deny、build_write_confirmation ask 静默 allow、未知 ask fail-closed deny;主 Agent 经 SessionAllowlist(exact-match,仅覆盖 build_write_confirmation)后仍走 gate 询问。RuntimeSecurityGate 拥有唯一的"authorize → execute"语义;为透传 `remember` 元数据,gate 新增一个可选 authorized-side 回调,九大安全不变量保持不变。

**Tech Stack:** TypeScript ES2022/NodeNext, Node.js, Vitest, 现有 `PermissionChecker`/`SecurityDecision`/`RuntimeSecurityGate`/`executeToolCall`/`StreamingToolExecutor`/`streamingQuery`。

---

## Global Constraints

- 本计划只实现"子代理 Build 模式静默执行 + 主 Agent session allowlist";AST command-policy enforced 切换、delegation gate 启用、跨会话持久化均为 out of scope。
- 遵循 RED → GREEN → REFACTOR。每个行为变更先写聚焦失败测试,失败原因必须匹配缺失的契约。
- **子代理静默执行 ≠ 无条件放行**。危险命令/越界路径/不可解析/变量未知由 PermissionChecker 在所有路由之前统一判定 deny/ask,子代理策略只在"已通过安全判定的 ask"上分流。
- `PermissionChecker` 是唯一安全规则源。下游安全路由使用稳定机器码 `reason_code`,**绝不读取 human reason 文本**。
- **reason_code/risk_kind 兼容性**:已有稳定码全部保留原值;本计划**只新增**一个 `permission.command_unresolvable_var` reason_code(补当前缺口),并让 `mapLegacyReason` 直读 `legacy.reason_code` 而非反推 reason 文本。现有 `dangerous_command`/`path_violation`/`workspace_mutation` 等审计 risk_kind **保持不变**(见下方对照表)。
- **origin 是 per-invocation context,不进共享单例**。`executionRuntime` 是主/子代理共享单例,origin 走 invocation context。
- **session allowlist 必须在 PermissionChecker 完整执行之后检查**。它只能覆盖 `build_write_confirmation` ask,绝不能覆盖 deny 或 safety_uncertain。exact-match,不做 trim/shell normalize/前缀/语义等价匹配。
- **RuntimeSecurityGate 修改约束**:允许增加元数据透传能力(可选 authorized-side 回调 `onAuthorized`),但**不得改变九大安全不变量**(ask 阻塞/fail-closed/不可重放/channel=null deny/decision_id 匹配等)。gate 继续拥有"authorize → execute"的唯一执行语义;**禁止在 tool-execution.ts 复制第二套 gate 执行逻辑**。`onAuthorized` 是 **non-interfering observer**:authorize 成功后触发,可读 `AuthorizedAction.remember`,但其异常**不得**阻止 executor、不得把 authorized 变 denied——用 try/catch 吞掉 observer 异常,executor 仍恰好执行一次。denied 路径不触发 observer。
- SessionAllowlist 生命周期严格绑定当前 MiCode session:当前 session 内有效;新建/clear/reset session 时清空;进程重启不恢复;不持久化;不增加 `/permissions clear` 命令。
- 所有 Windows 命令用 `npx.cmd`/`npm.cmd`。
- 保持改动仅限下述文件;不重构相邻代码。
- `action.snapshot_id` 是显示/审计字段,**不作为 session allowlist 的授权判断依据**。allowlist key 使用完整结构化输入精确表示。

---

## reason_code / risk_kind 兼容性对照表

**当前 `mapLegacyReason`(checker.ts:300-361)用子串匹配 reason 文本产出的稳定码。本计划保持这些值全部不变,只新增一个。**

| 闸门 / reason 文本 | 现有 reason_code(保持) | 现有 risk_kind(保持) | 现有 deciding_layer(保持) | 本计划动作 |
|---|---|---|---|---|
| 危险命令 `Dangerous command...` | `permission.dangerous_command` | `dangerous_command` | `command` | 不变 |
| 路径越界 `...outside...` | `permission.path_outside_workspace` | `path_violation` | `path` | 不变 |
| 不可解析 `Bash command unparseable...` | `permission.command_unparseable` | `unparseable_command` | `command` | 不变 |
| 变量未知 `Bash command has unresolvable variable...` | ⚠️ **当前落入 `permission.default`**(缺口) | `default` | `permission` | **★ 新增 `permission.command_unresolvable_var` / `unresolvable_variable` / `command`** |
| plan 写 `Plan mode...` | `permission.plan_write_blocked` | `mode_violation` | `permission` | 不变 |
| deny 规则 `...deny rule...` | `permission.rule_deny` | `rule_deny` | `permission` | 不变 |
| allow 规则 `...allow rule...` | `permission.rule_allow` | `rule_allow` | `permission` | 不变 |
| 写确认 `...user confirmation/write operation` | `permission.user_confirmation_required` | `workspace_mutation` | `permission` | 不变(下游路由用此码识别 build_write_confirmation) |
| 只读默认 / auto / plan-readonly | `permission.default` | `default` | `permission` | **保持 default**(security-decision-integration.test.ts:43 已锁定只读→default 容差;**禁止给这些分支引入新码**) |
| AST gate deny(shadow) | `permission.command_policy_denied`(若有) | — | — | 不变(shadow 未启用) |

**下游路由 reason_code 别名**(在 subagent-silent-policy 内定义,不侵入 checker):
- `SAFETY_UNCERTAIN` 集合 = `{ permission.command_unparseable, permission.command_unresolvable_var }`(含新增码)
- `BUILD_WRITE_CONFIRMATION` = `permission.user_confirmation_required`

`mapLegacyReason` 重构为**直读 `legacy.reason_code`** 后,产出值与上表完全一致(因为 checker 每个 return 直接带对应 reason_code)。risk_kind/deciding_layer 从 checker 同源产出,**禁止用 `reason_code.split('.')` 重算**。

**兼容性硬约束(经 security-decision-integration.test.ts 验证)**:
- `permission.dangerous_command` / `path_outside_workspace` / `plan_write_blocked` / `user_confirmation_required` / `rule_allow` / `default` 必须保持原值。
- 只读/auto/plan-readonly **保持 `permission.default`**,不引入新码(L43 容差断言 + 避免无谓改动)。
- 仅新增 `permission.command_unresolvable_var`(当前缺口)。

---

## File Map

### New files

- `src/permission/subagent-silent-policy.ts` — 纯函数 `applySubagentSilentPolicy(decision)`:按 reason_code 别名把子代理 ask 分流为静默 allow/deny;导出 `rewriteToAllow`(allowlist 命中改写)。
- `src/permission/session-allowlist.ts` — `SessionAllowlist` 类:内存 Map,exact-match key = `${toolName}\0${JSON.stringify(input)}`。
- `src/permission/permission-answer-mapping.ts` — 纯函数 `mapPermissionAnswerToUserDecision`:精确映射 UI answer → UserDecision(Allow once / Allow exact / Reject / unknown→rejected)。
- `src/__tests__/permission/subagent-silent-policy.test.ts`
- `src/__tests__/permission/session-allowlist.test.ts`
- `src/__tests__/permission/checker-reason-code.test.ts` — 验证 checker reason_code 产出(含新增 unresolvable_var)。
- `src/__tests__/permission/runtime-gate-remember.test.ts` — 验证 gate authorized-side 回调(remember 透传 + observer throw 不干扰)。
- `src/__tests__/permission/permission-answer-mapping.test.ts` — 验证 UI answer → UserDecision 精确映射(Reject 不可能变 approved_once)。
- `src/__tests__/permission/origin-routing.test.ts` — executeToolCall 端到端:子代理静默、主 Agent allowlist、危险命令始终拦截、**allowlist hit 仍经 gate.execute**。

### Modified files

- `src/permission/types.ts` — `PermissionDecision` 新增 `reason_code: string`。
- `src/permission/checker.ts` — 每个 `return` 带上对应已有 reason_code(值见对照表);**仅新增** unresolvable_var 的 reason + reason_code;`mapLegacyReason` 改为直读 `legacy.reason_code`。
- `src/permission/decisions.ts` — `UserDecision` 新增可选 `remember?: boolean`。
- `src/permission/runtime-gate.ts` — `AuthorizedAction` 新增可选 `remember?: boolean`;`execute()` 新增可选 `onAuthorized?: (action: AuthorizedAction) => void` 回调(九大不变量不变)。
- `src/agent/types.ts` — `ToolExecutionContext` 新增 `origin?: 'main' | 'subagent'`。
- `src/agent/tool-execution.ts` — `ToolExecutionRuntime` 新增可选 `sessionAllowlist?`;`executeToolCall` 在 checkDecision 后插入 origin 路由 + allowlist 查询;gate.execute 调用增加 onAuthorized 回调写 allowlist。
- `src/agent/streaming-executor.ts` — `StreamingToolExecutor` 构造接收 `origin`,透传到 executeToolCall context。
- `src/agent/streaming-query.ts` — `StreamingQueryOptions` 新增 `origin?`;构造 executor 时透传。
- `src/agent/subagent.ts` — `runSubagentWithClient` 标记 `origin: 'subagent'`。
- `src/index.ts` — 装配 SessionAllowlist;getDecisionChannel 增第 3 选项;三处 session 切换点调 allowlist.clear()。

---

## Task Dependency(修订)

```
Task 1 (checker reason_code + unresolvable_var 缺口 + mapLegacyReason 直读)
   │
   ├─→ Task 2 (subagent-silent-policy 纯函数)        ← 依赖 Task 1 reason_code 别名
   ├─→ Task 3 (session-allowlist)                      ← 独立
   └─→ Task 4 (runtime-gate non-interfering observer) ← 独立(gate 元数据能力)
            │
            └─→ Task 5 (origin 透传 + executeToolCall 路由,端到端 TDD)
                     │   ← 依赖 1 + 2 + 3 + 4
                     │
                     └─→ Task 6 (index.ts 装配 + UI 第 3 选项 + session clear)
                              │
                              └─→ Task 7 (回归 + 验收)
```

Task 1 先行。Task 2/3/4 可并行(2 依赖 1 的别名定义,3/4 独立)。Task 5 端到端合并 origin 透传与路由(不再单独 plumbing Task)。Task 6 装配。Task 7 验收。

**关键修订**:原 Task 4(origin plumbing)与 Task 5(路由)合并为一个端到端 TDD Task,用真实子代理执行行为证明 origin 生效,不依赖 callback 观察。

---

## Task 1: PermissionChecker reason_code 同源产出 + 修复 unresolvable_var 缺口

**Files:**
- Modify: `src/permission/types.ts:38-41`
- Modify: `src/permission/checker.ts:113-225, 245-361`
- Create: `src/__tests__/permission/checker-reason-code.test.ts`

**目标**:让 `check()` 在每个 return 直接产出 `reason_code`(与 reason 同源),消除 `mapLegacyReason` 的子串匹配脆弱性。**保持所有现有 reason_code/risk_kind 值不变**,只新增 unresolvable_var 的码。`mapLegacyReason` 改为直读 `legacy.reason_code`。

- [ ] **Step 1: 写失败测试 — reason_code 矩阵**

Create `src/__tests__/permission/checker-reason-code.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PermissionChecker } from '../../permission/checker.js';

describe('PermissionChecker reason_code 产出', () => {
  // 危险命令(已有码,保持)
  it('危险命令 → permission.dangerous_command', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('run_bash', { command: 'rm -rf /home' });
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.dangerous_command');
  });

  // 路径越界(已有码,保持)
  it('bash 路径越界 → permission.path_outside_workspace', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('run_bash', { command: 'cat /etc/passwd' });
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.path_outside_workspace');
  });

  // 不可解析(已有码,保持)— shell-quote 极度宽容,用 spy 触发 parseFailed
  it('parseFailed → permission.command_unparseable', async () => {
    const bashPaths = await import('../../permission/bash-paths.js');
    vi.spyOn(bashPaths, 'extractBashPaths').mockReturnValue({
      paths: [], parseFailed: true, unresolvableVars: false,
    });
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('run_bash', { command: 'whatever' });
    expect(d.behavior).toBe('ask');
    expect(d.reason_code).toBe('permission.command_unparseable');
    vi.restoreAllMocks();
  });

  // ★ 变量未知(新增码 — 当前缺口)
  it('变量未知 bash → permission.command_unresolvable_var(新增)', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('run_bash', { command: 'echo $UNDEFINED_VAR_XYZ' });
    expect(d.behavior).toBe('ask');
    expect(d.reason_code).toBe('permission.command_unresolvable_var');
  });

  // 用户 deny 规则(已有码,保持)
  it('deny 规则 → permission.rule_deny', () => {
    const c = new PermissionChecker({
      mode: 'build', workdir: process.cwd(),
      rules: [{ tool: 'write_file', behavior: 'deny' }],
    });
    const d = c.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.rule_deny');
  });

  // plan 写(已有码,保持)
  it('plan write_file → permission.plan_write_blocked', () => {
    const c = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    const d = c.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(d.behavior).toBe('deny');
    expect(d.reason_code).toBe('permission.plan_write_blocked');
  });

  // auto 放行(保持 default — 不引入新码)
  it('auto write_file → permission.default(保持)', () => {
    const c = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
    const d = c.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(d.behavior).toBe('allow');
    expect(d.reason_code).toBe('permission.default');
  });

  // allow 规则(已有码,保持)
  it('allow 规则 → permission.rule_allow', () => {
    const c = new PermissionChecker({
      mode: 'build', workdir: process.cwd(),
      rules: [{ tool: 'write_file', behavior: 'allow', path: 'allowed.txt' }],
    });
    const d = c.check('write_file', { path: 'allowed.txt', content: 'x' });
    expect(d.behavior).toBe('allow');
    expect(d.reason_code).toBe('permission.rule_allow');
  });

  // 只读默认(保持 default — security-decision-integration.test.ts:43 锁定)
  it('build read_file → permission.default(保持)', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('read_file', { path: 'inside.txt' });
    expect(d.behavior).toBe('allow');
    expect(d.reason_code).toBe('permission.default');
  });

  // ★ build 写确认(下游路由的关键码,保持 user_confirmation_required)
  it('build write_file → permission.user_confirmation_required', () => {
    const c = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    const d = c.check('write_file', { path: 'inside.txt', content: 'x' });
    expect(d.behavior).toBe('ask');
    expect(d.reason_code).toBe('permission.user_confirmation_required');
  });
});
```

**RED 原因**:`PermissionDecision` 当前无 `reason_code` 字段,所有 `d.reason_code` 为 `undefined`。变量未知测试当前落入 `permission.default`(mapLegacyReason 无 unresolvable 匹配),断言 `permission.command_unresolvable_var` 失败。

- [ ] **Step 2: 运行确认 RED**

```powershell
npx.cmd vitest run src/__tests__/permission/checker-reason-code.test.ts
```

Expected: FAIL — `reason_code` undefined;unresolvable_var 测试期望新码但得到 default。

- [ ] **Step 3: PermissionDecision 加 reason_code 字段**

In `src/permission/types.ts`:

```ts
export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: string;
  /**
   * 稳定机器码(与 reason 同源产出,不参与人类阅读)。
   * 值与 mapLegacyReason 产出的 reason_code 完全一致(见对照表)。
   * 下游路由(subagent 静默策略 / session allowlist)据此判断,绝不反推 reason 文本。
   */
  reason_code: string;
}
```

- [ ] **Step 4: checker.ts 每个 return 带 reason_code(保持现有值 + 仅新增 unresolvable_var)**

In `src/permission/checker.ts` `check()` (L113-225),给每个 `return { behavior, reason }` 加上对照表中对应的 `reason_code`。**关键原则:只给已有稳定码的分支带值;只读/auto/plan-readonly 保持 `permission.default`(已被 security-decision-integration.test.ts:43 锁定)**。

**关键新增**:变量未知分支(L150-152):

```ts
if (unresolvableVars) {
  return {
    behavior: 'ask',
    reason: 'Bash command has unresolvable variable, needs review',
    reason_code: 'permission.command_unresolvable_var',
  };
}
```

其余每个 return 按对照表带值(**仅已有码,不新增**):
- 危险命令(L140-142): `reason_code: 'permission.dangerous_command'`
- 不可解析(L147-149): `reason_code: 'permission.command_unparseable'`
- bash 路径越界(L153-157): `reason_code: 'permission.path_outside_workspace'`
- 文件路径越界(L159-165): `reason_code: 'permission.path_outside_workspace'`
- deny 规则(L168-172): `reason_code: 'permission.rule_deny'`
- plan 目录白名单(L178-183): `reason_code: 'permission.default'`(保持)
- plan 写 bash(L186-191): `reason_code: 'permission.plan_write_blocked'`
- plan 只读 bash(L191): `reason_code: 'permission.default'`(保持)
- plan write tool(L193-195): `reason_code: 'permission.plan_write_blocked'`
- plan 其余(L196): `reason_code: 'permission.default'`(保持)
- auto(L199-202): `reason_code: 'permission.default'`(保持)
- allow 规则(L205-209): `reason_code: 'permission.rule_allow'`
- ask 规则(L213-217): `reason_code: 'permission.default'`(保持)
- 只读默认(L219-221): `reason_code: 'permission.default'`(保持,security-decision-integration.test.ts:43 锁定)
- 写确认(L224): `reason_code: 'permission.user_confirmation_required'`

> **最小变更**:仅危险/路径/不可解析/unresolvable_var/plan_write/deny_rule/allow_rule/write_confirm 这 8 个有独立语义的分支带独立码;其余允许分支统一 `permission.default`。这避免无谓改动既有测试。

- [ ] **Step 5: mapLegacyReason 改为直读 legacy.reason_code**

替换整个 `mapLegacyReason`(L300-361)为:

```ts
/**
 * 直读 PermissionDecision.reason_code(由 check() 同源产出)。
 *
 * 不再用子串匹配 reason 文本——check() 现在每个 return 直接带 reason_code,
 * 本函数只透传 + 按对照表补 risk_kind/deciding_layer。
 * risk_kind/deciding_layer 保持现有审计语义(见对照表),禁止用 reason_code.split 重算。
 */
function mapLegacyReason(legacy: PermissionDecision): {
  reasonCode: string;
  riskKind: string;
  decidingLayer: string;
} {
  const rc = legacy.reason_code;
  // 仅给"有独立审计语义"的码补 risk_kind/deciding_layer;其余统一 default。
  // 对照 security-decision-integration.test.ts 已锁定的值。
  const META: Record<string, { riskKind: string; decidingLayer: string }> = {
    'permission.dangerous_command': { riskKind: 'dangerous_command', decidingLayer: 'command' },
    'permission.path_outside_workspace': { riskKind: 'path_violation', decidingLayer: 'path' },
    'permission.command_unparseable': { riskKind: 'unparseable_command', decidingLayer: 'command' },
    'permission.command_unresolvable_var': { riskKind: 'unresolvable_variable', decidingLayer: 'command' },
    'permission.plan_write_blocked': { riskKind: 'mode_violation', decidingLayer: 'permission' },
    'permission.rule_deny': { riskKind: 'rule_deny', decidingLayer: 'permission' },
    'permission.rule_allow': { riskKind: 'rule_allow', decidingLayer: 'permission' },
    'permission.user_confirmation_required': { riskKind: 'workspace_mutation', decidingLayer: 'permission' },
  };
  const meta = META[rc] ?? { riskKind: 'default', decidingLayer: 'permission' };
  return { reasonCode: rc, riskKind: meta.riskKind, decidingLayer: meta.decidingLayer };
}
```

更新调用点(L260)从 `mapLegacyReason(legacy.reason)` 改为 `mapLegacyReason(legacy)`。

- [ ] **Step 6: 运行聚焦测试确认 GREEN**

```powershell
npx.cmd vitest run src/__tests__/permission/checker-reason-code.test.ts
```

Expected: 全部通过。

**硬约束**:auto / 只读 / plan-readonly 必须继续产出 `permission.default`。若既有兼容测试失败,**修生产代码**(让这些分支保持 default),**禁止为了让测试通过而修改这些既有 reason_code 期望**。唯一允许新增的 reason_code 是 `permission.command_unresolvable_var`。

- [ ] **Step 7: 既有权限回归**

```powershell
npx.cmd vitest run src/__tests__/permission/security-decision-integration.test.ts src/__tests__/regression/build-mode-permission.test.ts src/__tests__/regression/streaming-permission-passthrough.test.ts src/__tests__/write-bash-patterns.test.ts
```

Expected: 全绿。**关键验证**:`security-decision-integration.test.ts` 锁定的 reason_code/risk_kind/deciding_layer 值全部保持(dangerous_command/path_outside_workspace/plan_write_blocked/user_confirmation_required/default 不变;risk_kind/deciding_layer 不变)。只读/auto/plan-readonly 仍为 `permission.default`。唯一新增:变量未知 → `permission.command_unresolvable_var`(此前无测试锁定它)。

- [ ] **Step 8: typecheck + lint**

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: exit 0。无 `reason_code` undefined 报错。

- [ ] **Step 9: Commit**

```powershell
git add src/permission/types.ts src/permission/checker.ts src/__tests__/permission/checker-reason-code.test.ts
git commit -m "feat(permission): source reason_code at each decision; fix unresolvable_var gap"
```

---

## Task 2: 子代理静默策略纯函数

**Files:**
- Create: `src/permission/subagent-silent-policy.ts`
- Create: `src/__tests__/permission/subagent-silent-policy.test.ts`

**目标**:纯函数按 reason_code 别名分流子代理 ask。

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/permission/subagent-silent-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applySubagentSilentPolicy } from '../../permission/subagent-silent-policy.js';
import { createSecurityDecision, SECURITY_PROTOCOL_VERSION } from '../../permission/decisions.js';
import type { SecurityDecision } from '../../permission/decisions.js';

function makeDecision(
  behavior: 'allow' | 'ask' | 'deny',
  reasonCode: string,
): SecurityDecision {
  return createSecurityDecision({
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: 'test-1',
    action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 'snap-1' },
    behavior,
    deciding_layer: 'permission',
    risk_kind: 'test',
    policy_id: 'test',
    policy_version: '1',
    reason_code: reasonCode,
    human_reason: 'test',
    provenance_refs: behavior === 'allow' ? ['test'] : [],
  });
}

describe('applySubagentSilentPolicy', () => {
  it('build_write_confirmation(user_confirmation_required)→ 静默 allow', () => {
    const out = applySubagentSilentPolicy(makeDecision('ask', 'permission.user_confirmation_required'));
    expect(out.behavior).toBe('allow');
  });

  it('command_unparseable → 静默 deny', () => {
    const out = applySubagentSilentPolicy(makeDecision('ask', 'permission.command_unparseable'));
    expect(out.behavior).toBe('deny');
  });

  it('command_unresolvable_var(新增)→ 静默 deny', () => {
    const out = applySubagentSilentPolicy(makeDecision('ask', 'permission.command_unresolvable_var'));
    expect(out.behavior).toBe('deny');
  });

  it('危险命令 deny → 透传(引用相等)', () => {
    const d = makeDecision('deny', 'permission.dangerous_command');
    expect(applySubagentSilentPolicy(d)).toBe(d);
  });

  it('allow → 透传(引用相等)', () => {
    const d = makeDecision('allow', 'permission.default');
    expect(applySubagentSilentPolicy(d)).toBe(d);
  });

  it('未知 ask → fail-closed deny', () => {
    const out = applySubagentSilentPolicy(makeDecision('ask', 'permission.future_unknown'));
    expect(out.behavior).toBe('deny');
  });
});
```

**RED 原因**:模块不存在。

- [ ] **Step 2: 运行确认 RED**

```powershell
npx.cmd vitest run src/__tests__/permission/subagent-silent-policy.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现纯函数**

Create `src/permission/subagent-silent-policy.ts`:

```ts
// 子代理静默执行策略:把"已通过 PermissionChecker 安全判定的 ask"按 reason_code 分流。
// deny/allow 透传;ask 按 reason_code 别名分流。未知 ask fail-closed deny。

import { createSecurityDecision, SECURITY_PROTOCOL_VERSION, type SecurityDecision } from './decisions.js';

/** safety_uncertain 别名:checker 产出的"无法确认安全"类 reason_code。 */
const SAFETY_UNCERTAIN = new Set([
  'permission.command_unparseable',
  'permission.command_unresolvable_var',
]);
/** build 写确认别名:已通过危险/越界检查,仅策略要求确认。 */
const BUILD_WRITE_CONFIRMATION = 'permission.user_confirmation_required';

export function applySubagentSilentPolicy(decision: SecurityDecision): SecurityDecision {
  if (decision.behavior === 'deny' || decision.behavior === 'allow') {
    return decision; // 透传,引用相等
  }
  const rc = decision.reason_code;
  if (rc === BUILD_WRITE_CONFIRMATION) {
    return rewrite(decision, 'allow', 'permission.subagent.silent_allow.build_write');
  }
  if (SAFETY_UNCERTAIN.has(rc)) {
    return rewrite(decision, 'deny', 'permission.subagent.silent_deny.safety_uncertain');
  }
  return rewrite(decision, 'deny', 'permission.subagent.silent_deny.unknown_ask');
}

function rewrite(base: SecurityDecision, behavior: 'allow' | 'deny', reasonCode: string): SecurityDecision {
  return createSecurityDecision({
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: base.decision_id,
    action: { ...base.action },
    behavior,
    deciding_layer: base.deciding_layer,
    risk_kind: base.risk_kind,
    policy_id: base.policy_id,
    policy_version: base.policy_version,
    reason_code: reasonCode,
    human_reason: base.human_reason,
    provenance_refs: base.provenance_refs.length > 0 ? [...base.provenance_refs] : ['permission:subagent-silent-policy'],
  });
}
```

- [ ] **Step 4: 运行确认 GREEN**

```powershell
npx.cmd vitest run src/__tests__/permission/subagent-silent-policy.test.ts
```

Expected: 全绿。

- [ ] **Step 5: typecheck + Commit**

```powershell
npm.cmd run typecheck
git add src/permission/subagent-silent-policy.ts src/__tests__/permission/subagent-silent-policy.test.ts
git commit -m "feat(permission): subagent silent execution policy"
```

---

## Task 3: SessionAllowlist(exact-match 内存缓存)

**Files:**
- Create: `src/permission/session-allowlist.ts`
- Create: `src/__tests__/permission/session-allowlist.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/permission/session-allowlist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SessionAllowlist } from '../../permission/session-allowlist.js';

describe('SessionAllowlist', () => {
  it('exact match 命中', () => {
    const al = new SessionAllowlist();
    al.add('run_bash', { command: 'npm test' });
    expect(al.has('run_bash', { command: 'npm test' })).toBe(true);
  });

  it('不同 input 不命中(空格差异)', () => {
    const al = new SessionAllowlist();
    al.add('run_bash', { command: 'npm  test' });
    expect(al.has('run_bash', { command: 'npm test' })).toBe(false);
  });

  it('不同 toolName 不命中', () => {
    const al = new SessionAllowlist();
    al.add('write_file', { path: 'a.txt', content: 'x' });
    expect(al.has('edit_file', { path: 'a.txt', content: 'x' })).toBe(false);
  });

  it('clear 后清空', () => {
    const al = new SessionAllowlist();
    al.add('run_bash', { command: 'npm test' });
    al.clear();
    expect(al.has('run_bash', { command: 'npm test' })).toBe(false);
  });

  it('新实例为空(跨会话不持久)', () => {
    const al1 = new SessionAllowlist();
    al1.add('run_bash', { command: 'npm test' });
    expect(new SessionAllowlist().has('run_bash', { command: 'npm test' })).toBe(false);
  });

  it('NUL 分隔:toolName 与 input 拼接无歧义', () => {
    const al = new SessionAllowlist();
    al.add('a', { x: '\u0000b' });
    expect(al.has('a', { x: '\u0000b' })).toBe(true);
    expect(al.has('a\u0000b', {})).toBe(false);
  });
});
```

**RED 原因**:模块不存在。

- [ ] **Step 2: 运行确认 RED**

```powershell
npx.cmd vitest run src/__tests__/permission/session-allowlist.test.ts
```

Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

Create `src/permission/session-allowlist.ts`:

```ts
// 主 Agent session 级 exact-match 授权缓存。
// key = toolName + NUL + JSON.stringify(input),完整结构化输入精确表示。
// 安全边界:只做查表,不做安全判定。调用方必须在 PermissionChecker 完整执行后查本表,
// 且只能覆盖 build_write_confirmation ask。deny/safety_uncertain 永远到不了这里。

export function sessionAllowlistKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}\u0000${JSON.stringify(input)}`;
}

export class SessionAllowlist {
  private readonly entries = new Map<string, { toolName: string; addedAt: number }>();

  has(toolName: string, input: Record<string, unknown>): boolean {
    return this.entries.has(sessionAllowlistKey(toolName, input));
  }

  add(toolName: string, input: Record<string, unknown>): void {
    this.entries.set(sessionAllowlistKey(toolName, input), { toolName, addedAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }
}
```

- [ ] **Step 4: 运行确认 GREEN + typecheck + Commit**

```powershell
npx.cmd vitest run src/__tests__/permission/session-allowlist.test.ts
npm.cmd run typecheck
git add src/permission/session-allowlist.ts src/__tests__/permission/session-allowlist.test.ts
git commit -m "feat(permission): session-level exact-match allowlist"
```

---

## Task 4: RuntimeSecurityGate remember 元数据透传(唯一执行语义)

**Files:**
- Modify: `src/permission/decisions.ts:72-77`
- Modify: `src/permission/runtime-gate.ts:46-50, 200-214, 238-247`
- Create: `src/__tests__/permission/runtime-gate-remember.test.ts`

**目标**:gate 继续拥有"authorize → execute"的唯一语义。为透传 `remember`,给 `execute()` 增加可选 `onAuthorized` 回调(authorized 后、调 executor 前触发);`AuthorizedAction` 增加可选 `remember`。**九大不变量全部保持。**

**为什么不复制 gate 逻辑**:在 tool-execution.ts 手写 `authorize() + 手动 executor` 会产生第二套执行语义(denied 处理、pending 写入、fail-closed 都要重复)。给 gate 增加一个观察回调,执行权仍在 gate 内,调用方只收到"已授权"通知 + 元数据。

- [ ] **Step 1: 写失败测试 — onAuthorized 回调 + remember 透传**

Create `src/__tests__/permission/runtime-gate-remember.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { createSecurityDecision, SECURITY_PROTOCOL_VERSION, type SecurityDecision, type UserDecision } from '../../permission/decisions.js';

class MemStore {
  public saved: any[] = [];
  async save(p: any) { this.saved.push({ ...p }); }
  async load() { return [...this.saved]; }
  async update() {}
}

class ControllableChannel {
  public requests: SecurityDecision[] = [];
  private resolver: ((u: UserDecision) => void) | null = null;
  async request(d: SecurityDecision) {
    this.requests.push(d);
    return new Promise<UserDecision>(resolve => { this.resolver = resolve; });
  }
  resolve(u: UserDecision) { const r = this.resolver!; this.resolver = null; r(u); }
}

function askDecision(id: string): SecurityDecision {
  return createSecurityDecision({
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: id,
    action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: `snap-${id}` },
    behavior: 'ask',
    deciding_layer: 'permission',
    risk_kind: 'workspace_mutation',
    policy_id: 'test', policy_version: '1',
    reason_code: 'permission.user_confirmation_required',
    human_reason: 'test',
    provenance_refs: ['test'],
  });
}

describe('RuntimeSecurityGate remember 透传', () => {
  it('execute 的 onAuthorized 回调在 authorized 后、executor 前触发,携带 remember', async () => {
    const channel = new ControllableChannel();
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: channel as any });
    const authorized: any[] = [];
    let executorCalled = false;

    const promise = gate.execute(
      askDecision('d1'),
      async () => { executorCalled = true; return 'done'; },
      { onAuthorized: (a) => { authorized.push(a); } },
    );

    // 等 channel 收到请求后,resolve approved_once + remember
    await new Promise(r => setTimeout(r, 20));
    expect(channel.requests).toHaveLength(1);
    expect(executorCalled).toBe(false); // 还未 authorized

    channel.resolve({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: 'd1',
      response: 'approved_once',
      decided_at: new Date().toISOString(),
      remember: true,
    });

    const result = await promise;
    expect(result).toBe('done');
    expect(executorCalled).toBe(true);
    expect(authorized).toHaveLength(1);
    expect(authorized[0].remember).toBe(true); // ★ 回调收到 remember 元数据
  });

  it('onAuthorized 在 denied 时不触发', async () => {
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: null });
    const authorized: any[] = [];
    const result = await gate.execute(
      askDecision('d2'),
      async () => 'should-not-run',
      { onAuthorized: () => { authorized.push(true); } },
    );
    // channel=null → fail-closed denied
    expect((result as any).kind).toBe('denied');
    expect(authorized).toHaveLength(0);
  });

  it('无 onAuthorized 回调时行为不变(向后兼容)', async () => {
    const channel = new ControllableChannel();
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: channel as any });
    const promise = gate.execute(askDecision('d3'), async () => 'done');
    await new Promise(r => setTimeout(r, 10));
    channel.resolve({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: 'd3',
      response: 'approved_once',
      decided_at: new Date().toISOString(),
    });
    expect(await promise).toBe('done');
  });

  // ★ 修订点 3:onAuthorized 是 non-interfering observer——throw 不阻止 executor
  it('onAuthorized throws → executor 仍恰好执行一次,返回 executor 结果', async () => {
    const channel = new ControllableChannel();
    const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel: channel as any });
    let executorCalls = 0;
    const promise = gate.execute(
      askDecision('d4'),
      async () => { executorCalls++; return 'done'; },
      { onAuthorized: () => { throw new Error('observer exploded'); } },
    );
    await new Promise(r => setTimeout(r, 10));
    channel.resolve({
      protocol_version: SECURITY_PROTOCOL_VERSION,
      decision_id: 'd4',
      response: 'approved_once',
      decided_at: new Date().toISOString(),
    });
    // ★ observer throw 不传播:execute 返回 executor 结果,不 reject
    const result = await promise;
    expect(result).toBe('done');
    expect(executorCalls).toBe(1); // ★ executor 恰好执行一次(未被 observer 阻止)
  });
});
```

**RED 原因**:`execute()` 当前签名是 `execute<T>(decision, executor)`,不接受第 3 参数 options;`AuthorizedAction` 无 `remember` 字段。4 个测试用例(含 observer throw)全部因 TypeScript "Expected 2 arguments but got 3" 在编译期失败。即使绕过类型检查,observer throw 用例会因 onAuthorized 异常传播导致 `await promise` reject(期望返回 'done'),证明 non-interfering 语义缺失。

- [ ] **Step 2: 运行确认 RED**

```powershell
npx.cmd vitest run src/__tests__/permission/runtime-gate-remember.test.ts
```

Expected: FAIL — 类型错误(options 参数不存在)。

- [ ] **Step 3: UserDecision 加 remember**

In `src/permission/decisions.ts`:

```ts
export interface UserDecision {
  protocol_version: string;
  decision_id: string;
  response: 'approved_once' | 'rejected';
  decided_at: string;
  /** 用户请求记住此 action(session 级)。由 gate 透传到 AuthorizedAction。 */
  remember?: boolean;
}
```

- [ ] **Step 4: AuthorizedAction 加 remember + execute 加 onAuthorized**

In `src/permission/runtime-gate.ts`:

`AuthorizedAction`(L46-50):

```ts
export type AuthorizedAction = {
  kind: 'authorized';
  decision_id: string;
  action_snapshot_id: string;
  /** 透传自 UserDecision.remember。调用方据此写 session allowlist。 */
  remember?: boolean;
};
```

`authorize()` 的 approved_once 分支(L200-214)透传 remember:

```ts
if (userDecision.response === 'approved_once') {
  const userDecisionRef = `ud:${randomUUID()}`;
  await this.pendingStore.update(decision.decision_id, {
    status: 'approved_once',
    resolved_at: new Date().toISOString(),
    user_decision_ref: userDecisionRef,
  });
  return {
    kind: 'authorized',
    decision_id: decision.decision_id,
    action_snapshot_id: decision.action.snapshot_id,
    remember: userDecision.remember,
  };
}
```

`execute()`(L238-247)增加可选 options + onAuthorized 回调。**onAuthorized 是 non-interfering observer**:authorize 成功后触发,但其异常**不得**阻止 executor、不得把 authorized 变 denied。用 try/catch 吞掉 observer 异常(修订点 3):

```ts
async execute<T>(
  decision: SecurityDecision,
  executor: () => Promise<T>,
  options?: { onAuthorized?: (action: AuthorizedAction) => void },
): Promise<T | DeniedAction> {
  const outcome = await this.authorize(decision);
  if (outcome.kind === 'denied') {
    return outcome; // 不变:denied 绝不调 executor,也不触发 onAuthorized
  }
  // authorized:通知观察者(携带 remember 元数据)。observer 是 non-interfering:
  // 其异常不得阻止 executor、不得改变 authorized→denied。吞掉异常保证 executor 仍执行一次。
  if (options?.onAuthorized) {
    try {
      options.onAuthorized(outcome);
    } catch {
      // observer 故障不影响执行语义:executor 仍恰好执行一次,返回其结果。
      // 不记录、不重抛——observer 是纯观察点,无权影响授权/执行流。
    }
  }
  return await executor();
}
```

> **九大不变量影响分析**:不变量 1-9 全部不受影响。
> - onAuthorized 只在 authorized 路径(authorize 已返回 authorized)触发,在 executor 之前;denied 路径不触发。
> - **observer throw 被 try/catch 吞掉**:authorized 不变 denied,executor 仍恰好执行一次(修订点 3)。
> - pending 写入、fail-closed、decision_id 匹配、不可重放等全部在 authorize() 内,未改动。

- [ ] **Step 5: 运行确认 GREEN**

```powershell
npx.cmd vitest run src/__tests__/permission/runtime-gate-remember.test.ts
```

Expected: 全绿。4 个用例:remember 透传 / denied 不触发 / 向后兼容 / **observer throw 不阻止 executor**(修订点 3)。

- [ ] **Step 6: 既有 gate 回归**

```powershell
npx.cmd vitest run src/__tests__/regression/streaming-permission-passthrough.test.ts
```

Expected: 全绿。execute 第 3 参数可选,既有两参数调用零改动。

- [ ] **Step 7: typecheck + Commit**

```powershell
npm.cmd run typecheck
git add src/permission/decisions.ts src/permission/runtime-gate.ts src/__tests__/permission/runtime-gate-remember.test.ts
git commit -m "feat(permission): gate non-interfering authorized observer for remember metadata"
```

---

## Task 5: origin 透传 + executeToolCall 路由(端到端 TDD)

**Files:**
- Modify: `src/agent/types.ts:75-88`
- Modify: `src/agent/streaming-executor.ts:56-72, 126-146`
- Modify: `src/agent/streaming-query.ts:151-175, 488-491`
- Modify: `src/agent/subagent.ts:416`
- Modify: `src/agent/tool-execution.ts:82-86, 304-450`
- Create: `src/__tests__/permission/origin-routing.test.ts`

**目标**:端到端验证 origin 生效。origin 透传链路(types → executor → streamingQuery → subagent)与路由逻辑(executeToolCall)在一个 Task 内完成,用真实子代理执行行为证明,不依赖 callback 观察。

**关键设计**:`executeToolCall` 通过 gate 的 `onAuthorized` 回调(Task 4)写 allowlist,**不复制 gate 执行逻辑**。子代理 ask 经 `applySubagentSilentPolicy`(Task 2)改写后,仍走 `gate.execute()`。

- [ ] **Step 1: 写失败测试 — 端到端 origin 路由矩阵**

Create `src/__tests__/permission/origin-routing.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import {
  createSecurityDecision, SECURITY_PROTOCOL_VERSION,
  type SecurityDecision, type UserDecision,
} from '../../permission/decisions.js';
import type { ToolUseBlock } from '../../agent/types.js';

class MemStore {
  async save() {} async load() { return []; } async update() {}
}

/** 可控 channel:resolve 不自动,测试显式驱动,避免永久 pending。 */
class ControllableChannel {
  public requests: SecurityDecision[] = [];
  private resolver: ((u: UserDecision) => void) | null = null;
  async request(d: SecurityDecision) {
    this.requests.push(d);
    return new Promise<UserDecision>(resolve => { this.resolver = resolve; });
  }
  resolveApproved(id: string, remember = false) {
    const r = this.resolver!; this.resolver = null;
    r({ protocol_version: SECURITY_PROTOCOL_VERSION, decision_id: id, response: 'approved_once', decided_at: new Date().toISOString(), remember });
  }
}

function makeRegistry(): { registry: ToolRegistry; calls: string[] } {
  const calls: string[] = [];
  const registry = new ToolRegistry();
  registry.register(
    { name: 'write_file', description: 'p', parameters: { type: 'object', properties: {}, required: [] } },
    async (i) => { calls.push(`write:${i.path}`); return 'written'; },
  );
  registry.register(
    { name: 'run_bash', description: 'p', parameters: { type: 'object', properties: {}, required: [] } },
    async (i) => { calls.push(`bash:${i.command}`); return 'done'; },
  );
  return { registry, calls };
}

function makeRuntime(mode: 'build' | 'auto', channel: any, allowlist?: SessionAllowlist) {
function makeRuntime(mode: 'build' | 'auto', channel: any, allowlist?: SessionAllowlist) {
  const checker = new PermissionChecker({ mode, workdir: process.cwd() });
  const gate = new RuntimeSecurityGate({ pendingStore: new MemStore() as any, channel });
  // spy gate.execute:锁定"所有执行路径统一经 gate"(修订点 1)
  const executeSpy = vi.spyOn(gate, 'execute');
  return { permissionChecker: checker, runtimeGate: gate, sessionAllowlist: allowlist, executeSpy };
}

const wf = (id: string, input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id, name: 'write_file', input } as ToolUseBlock);
const rb = (id: string, cmd: string): ToolUseBlock =>
  ({ type: 'tool_use', id, name: 'run_bash', input: { command: cmd } } as ToolUseBlock);

describe('executeToolCall origin 路由(端到端)', () => {
  it('子代理普通 write → 静默 allow,不弹 channel,执行了', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const rt = makeRuntime('build', ch);
    const r = await executeToolCall(registry, wf('t1', { path: 'a.txt', content: 'x' }), rt, { origin: 'subagent' });
    expect(r.status).toBe('success');
    expect(ch.requests).toHaveLength(0); // ★ 不弹 UI
    expect(calls).toEqual(['write:a.txt']); // ★ 执行了
  });

  it('子代理危险命令 → deny,不执行不弹 channel', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const rt = makeRuntime('build', ch);
    const r = await executeToolCall(registry, rb('t2', 'rm -rf /home'), rt, { origin: 'subagent' });
    expect(r.status).toBe('failure');
    expect(ch.requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('子代理变量未知 bash → 静默 deny,不弹 channel', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const rt = makeRuntime('build', ch);
    const r = await executeToolCall(registry, rb('t3', 'echo $UNDEFINED_X'), rt, { origin: 'subagent' });
    expect(r.status).toBe('failure');
    expect(ch.requests).toHaveLength(0); // ★ safety_uncertain 静默 deny
    expect(calls).toHaveLength(0);
  });

  it('主 Agent 变量未知 bash → 仍询问(channel 收到请求)', async () => {
    const { registry } = makeRegistry();
    const ch = new ControllableChannel();
    const rt = makeRuntime('build', ch);
    const p = executeToolCall(registry, rb('t4', 'echo $UNDEFINED_X'), rt, { origin: 'main' });
    await new Promise(r => setTimeout(r, 30));
    expect(ch.requests).toHaveLength(1); // ★ 主 Agent 仍询问
    // 测试驱动:resolve 让 promise 完成,避免悬挂
    ch.resolveApproved('exec:t4');
    await p;
  });

  it('主 Agent remembered 命令 → 不询问,且仍经 gate.execute(不绕过)', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const al = new SessionAllowlist();
    al.add('write_file', { path: 'a.txt', content: 'x' });
    const rt = makeRuntime('build', ch, al);
    const r = await executeToolCall(registry, wf('t5', { path: 'a.txt', content: 'x' }), rt, { origin: 'main' });
    expect(r.status).toBe('success');
    expect(ch.requests).toHaveLength(0); // ★ allowlist 命中 → decision 改写为 allow → gate 不弹 channel
    expect(calls).toEqual(['write:a.txt']);
    // ★★★ 锁定:allowlist hit 仍统一经 gate.execute(修订点 1:不绕过 gate)
    expect(rt.executeSpy).toHaveBeenCalledTimes(1);
  });

  it('主 Agent 不同命令 → 仍询问', async () => {
    const { registry } = makeRegistry();
    const ch = new ControllableChannel();
    const al = new SessionAllowlist();
    al.add('write_file', { path: 'a.txt', content: 'x' });
    const rt = makeRuntime('build', ch, al);
    const p = executeToolCall(registry, wf('t6', { path: 'b.txt', content: 'x' }), rt, { origin: 'main' });
    await new Promise(r => setTimeout(r, 30));
    expect(ch.requests).toHaveLength(1); // ★ 不命中,仍询问
    ch.resolveApproved('exec:t6');
    await p;
  });

  it('remembered 即使命中危险规则也 deny(allowlist 不覆盖 deny)', async () => {
    const { registry, calls } = makeRegistry();
    const ch = new ControllableChannel();
    const al = new SessionAllowlist();
    al.add('run_bash', { command: 'rm -rf /home' }); // 假装记过
    const rt = makeRuntime('build', ch, al);
    const r = await executeToolCall(registry, rb('t7', 'rm -rf /home'), rt, { origin: 'main' });
    expect(r.status).toBe('failure'); // ★ deny 优先
    expect(ch.requests).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('主 Agent 选 remember → gate onAuthorized 写入 allowlist', async () => {
    const { registry } = makeRegistry();
    const ch = new ControllableChannel();
    const al = new SessionAllowlist();
    const rt = makeRuntime('build', ch, al);
    const input = { path: 'c.txt', content: 'y' };
    const p = executeToolCall(registry, wf('t8', input), rt, { origin: 'main' });
    await new Promise(r => setTimeout(r, 30));
    expect(ch.requests).toHaveLength(1);
    // 用户选 "Allow this exact action for this session" → remember=true
    ch.resolveApproved('exec:t8', true);
    await p;
    // ★ allowlist 现在记住此 action
    expect(al.has('write_file', input)).toBe(true);
  });
});
```

**RED 原因**:
- `ToolExecutionContext` 无 `origin` 字段(类型错误)。
- `executeToolCall` 未实现 origin 路由:子代理 write 测试会弹 channel(requests=1,期望 0);allowlist 命中测试会弹 channel;remember 测试不写 allowlist。
- `ToolExecutionRuntime` 无 `sessionAllowlist` 字段。

- [ ] **Step 2: 运行确认 RED**

```powershell
npx.cmd vitest run src/__tests__/permission/origin-routing.test.ts
```

Expected: FAIL — origin 类型错误 + 路由未实现。

- [ ] **Step 3: ToolExecutionContext 加 origin**

In `src/agent/types.ts`:

```ts
export interface ToolExecutionContext {
  toolUseId: string;
  signal?: AbortSignal;
  sanitizedExecutionPlan?: unknown;
  origin?: 'main' | 'subagent';
}
```

- [ ] **Step 4: StreamingToolExecutor 接收并透传 origin**

In `src/agent/streaming-executor.ts`:

构造函数加第 4 参数,类字段加 `origin`:

```ts
constructor(registry, runtime, signal?, origin?: 'main' | 'subagent') {
  // ... 原赋值
  this.origin = origin ?? 'main';
}
private readonly origin: 'main' | 'subagent';
```

`executeTool` 调 `executeToolCall` 透传:

```ts
const executionResult = await executeToolCall(
  this.registry, tool.block, this.runtime,
  { signal: this.signal, origin: this.origin },
);
```

- [ ] **Step 5: StreamingQueryOptions 加 origin + 透传给 executor**

In `src/agent/streaming-query.ts`, `StreamingQueryOptions` 加:

```ts
origin?: 'main' | 'subagent';
```

构造 executor(L488-491)透传:

```ts
const streamingExecutor = enableStreamingExecution && executionRuntime
  ? new StreamingToolExecutor(registry, executionRuntime, signal, options.origin)
  : null;
```

- [ ] **Step 6: 子代理标记 origin='subagent'**

In `src/agent/subagent.ts` `runSubagentWithClient` 的 streamingQuery options(L416-432)加:

```ts
origin: 'subagent',
```

- [ ] **Step 7: ToolExecutionRuntime 加 sessionAllowlist + executeToolCall 路由**

In `src/agent/tool-execution.ts`:

`ToolExecutionRuntime`(L82-86)加:

```ts
import type { SessionAllowlist } from '../permission/session-allowlist.js';
import { applySubagentSilentPolicy } from '../permission/subagent-silent-policy.js';

export interface ToolExecutionRuntime {
  permissionChecker: PermissionChecker;
  runtimeGate: RuntimeSecurityGate;
  callbacks?: ToolExecutionCallbacks;
  sessionAllowlist?: SessionAllowlist;
}
```

`executeToolCall` 在 checkDecision(L381-390)后、gate.execute(L391)前插入路由。**所有路径统一调用 `runtimeGate.execute`——tool executor 永远只有这一个执行入口。** allowlist 命中不再绕过 gate,而是把 SecurityDecision **改写成 allow** 后仍走 gate.execute:

```ts
  const decision = runtime.permissionChecker.checkDecision(
    call.name, executorInput,
    { decision_id: `exec:${call.id}`, action_snapshot_id: actionSnapshotId, policy_id: 'permission-default', policy_version: '1' },
  );

  const origin = context.origin ?? 'main';
  let effectiveDecision = decision;

  if (origin === 'subagent') {
    // 子代理:按 reason_code 静默分流(ask→allow/deny 改写),仍走 gate
    effectiveDecision = applySubagentSilentPolicy(decision);
  } else if (
    decision.behavior === 'ask' &&
    decision.reason_code === 'permission.user_confirmation_required' &&
    runtime.sessionAllowlist?.has(call.name, executorInput) === true
  ) {
    // 主 Agent allowlist exact-match 命中 → 把 ask 改写成 allow(不绕过 gate)
    // 三层正交过滤:behavior=ask ∧ reason_code=user_confirmation_required ∧ origin=main
    // deny/safety_uncertain 在 checkDecision 已先行拦截,到不了这里
    effectiveDecision = rewriteToAllow(decision);
  }

  // ★ 唯一执行入口:所有路径(子代理静默 / allowlist 命中 / 正常 ask)统一经 gate.execute
  // onAuthorized 回调写 allowlist(仅 main + remember);observer 异常不影响执行(Task 4 保证)
  const gated = await runtime.runtimeGate.execute(
    effectiveDecision,
    async (): Promise<ExecutorOutcome> => {
      try { return { kind: 'returned', output: await registered.executor(executorInput, { ...context, toolUseId: call.id }) }; }
      catch (error) { return { kind: 'threw', error }; }
    },
    origin === 'main' ? { onAuthorized: (a) => { if (a.remember) runtime.sessionAllowlist?.add(call.name, executorInput); } } : undefined,
  );

  // 以下 denied/threw/returned 处理保持原样(L408-449)
```

`rewriteToAllow` 是一个纯函数,把 SecurityDecision 的 behavior 改为 allow(保留 action/identity/provenance)。**唯一归属:`src/permission/subagent-silent-policy.ts` 导出**(与 `applySubagentSilentPolicy` 同文件,复用内部 `rewrite` 辅助)。Task 5 从该文件 import。不创建 `decision-rewrite.ts`。

```ts
import { createSecurityDecision, SECURITY_PROTOCOL_VERSION, type SecurityDecision } from './decisions.js';

/** 把 SecurityDecision 改写为 allow(保留身份/provenance)。用于 allowlist 命中后仍走 gate。 */
export function rewriteToAllow(base: SecurityDecision): SecurityDecision {
  return createSecurityDecision({
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: base.decision_id,
    action: { ...base.action },
    behavior: 'allow',
    deciding_layer: base.deciding_layer,
    risk_kind: base.risk_kind,
    policy_id: base.policy_id,
    policy_version: base.policy_version,
    reason_code: 'permission.session_allowlist_hit',
    human_reason: base.human_reason,
    provenance_refs: base.provenance_refs.length > 0 ? [...base.provenance_refs] : ['permission:session-allowlist'],
  });
}
```

> **无第二套执行语义(修订)**:子代理静默路径、allowlist 命中、正常 ask 三条路径**全部统一调用 `runtimeGate.execute`**。不存在绕过 gate 直接调 `registered.executor` 的分支。deny/safety_uncertain 仍由 checkDecision 先行拦截(allowlist 命中分支的三层过滤保证它们到不了 rewriteToAllow)。remembered hit 产生的 `permission.session_allowlist_hit` allow decision 仍经 gate 的 authorize(allow → 立即 authorized → 执行 executor),不产生第二套 try/catch/finalize。

- [ ] **Step 8: 运行确认 GREEN**

```powershell
npx.cmd vitest run src/__tests__/permission/origin-routing.test.ts
```

Expected: 全部 8 个用例通过。

- [ ] **Step 9: 既有执行回归**

```powershell
npx.cmd vitest run src/__tests__/regression/streaming-permission-passthrough.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts
```

Expected: 全绿。origin 默认 main + 无 allowlist 时行为不变。

- [ ] **Step 10: typecheck + lint + Commit**

```powershell
npm.cmd run typecheck
npm.cmd run lint
git add src/agent/types.ts src/agent/streaming-executor.ts src/agent/streaming-query.ts src/agent/subagent.ts src/agent/tool-execution.ts src/__tests__/permission/origin-routing.test.ts
git commit -m "feat(permission): route by origin with subagent silent policy and session allowlist"
```

---

## Task 6: index.ts 装配 + UI 第 3 选项 + session 生命周期 clear

**Files:**
- Modify: `src/index.ts:174, 333-364, 395-399, 448-457, 563-622, 1044`
- Create: `src/__tests__/permission/decision-channel-remember.test.ts`

**目标**:装配 SessionAllowlist;getDecisionChannel 增第 3 选项;**三处 session 切换点调 allowlist.clear()**(已调查确认,见下)。

### Session 生命周期调查结果(已确认,非执行期探索)

当前项目所有 session 切换点:

| 位置 | 函数/场景 | 动作 | allowlist.clear() 需要? |
|---|---|---|---|
| `index.ts:174` | 模块加载 `let sessionId = randomUUID()` | 进程启动新 session | ✅(新建实例即空,无需显式 clear) |
| `index.ts:452` | `rotateSessionId` dep(plan approval 调用) | `sessionId = randomUUID()` | ✅ 在此闭包加 clear |
| `index.ts:615` | `handleRewindLastTurn`(撤回) | `sessionId = randomUUID()` | ✅ 加 clear |
| `index.ts:1044` | `--resume`/`--continue` | `sessionId = resumeId` | ✅ 加 clear(切到别的会话) |

`applyPlanApproval`(plan-approval-transition.ts:23-24)通过 deps 调 `clearSessionMessages` + `rotateSessionId`——在 `rotateSessionId` 闭包(index.ts:452)加 clear 即覆盖此路径。

- [ ] **Step 1: 写失败测试 — mapPermissionAnswerToUserDecision 精确映射(RED)**

**修订点 2**:getDecisionChannel 的 answer → UserDecision 映射必须是纯函数,精确映射,Reject/unknown 绝不变成 approved_once。本 Task 先 TDD 这个纯函数,再在 Step 4 让 getDecisionChannel 调用它。

Create `src/__tests__/permission/permission-answer-mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapPermissionAnswerToUserDecision } from '../../permission/permission-answer-mapping.js';
import { SECURITY_PROTOCOL_VERSION } from '../../permission/decisions.js';
import type { AskQuestionOutcome } from '../../agent/ask-user-types.js';

const decisionId = 'dec-1';

function submitted(answer: string | undefined): AskQuestionOutcome {
  // AskQuestionOutcome.answers 是 Record<string,string>;模拟单选问卷选中一个选项
  const answers = answer === undefined ? {} : { q0: answer };
  return { kind: 'submitted', answers };
}

describe('mapPermissionAnswerToUserDecision(精确映射)', () => {
  it('Allow once → approved_once, remember=false', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('Allow once'));
    expect(u.response).toBe('approved_once');
    expect(u.remember).toBe(false);
  });

  it('Allow this exact action for this session → approved_once, remember=true', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('Allow this exact action for this session'));
    expect(u.response).toBe('approved_once');
    expect(u.remember).toBe(true);
  });

  it('Reject → rejected', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('Reject'));
    expect(u.response).toBe('rejected');
  });

  it('unknown answer → rejected(不允许任何未知值变成 approved_once)', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('something else'));
    expect(u.response).toBe('rejected');
  });

  it('empty answers(选中但无值)→ rejected', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted(undefined));
    expect(u.response).toBe('rejected');
  });

  it('outcome 非 submitted(cancelled)→ rejected', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, { kind: 'cancelled' });
    expect(u.response).toBe('rejected');
  });

  it('outcome 非 submitted(chat)→ rejected', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, { kind: 'chat', feedback: 'discuss' });
    expect(u.response).toBe('rejected');
  });

  it('所有结果携带 decision_id + protocol_version + decided_at', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('Allow once'));
    expect(u.decision_id).toBe(decisionId);
    expect(u.protocol_version).toBe(SECURITY_PROTOCOL_VERSION);
    expect(typeof u.decided_at).toBe('string');
  });
});
```

**RED 原因**:模块 `permission-answer-mapping.ts` 不存在 → import 失败。这是本 Task 真正的 RED(不依赖 Task 4/5 已有行为)。

> **修订说明(修订点 2)**:原 Task 6 的 `decision-channel-remember.test.ts` 在 Task 4 完成后本就会 GREEN(它测的是 gate 侧 remember 透传,Task 4 已实现),不能作为 UI/answer mapping 的 RED 测试。该文件**降级为回归测试**,保留在 Task 6 Step 1b,仅验证"remember 端到端不退化",不再是本 Task 的主要 RED。本 Task 的 RED 是 `permission-answer-mapping.test.ts`(纯函数,模块不存在必然失败)。

- [ ] **Step 1b: 保留 decision-channel-remember 作为回归测试(非 RED)**

`src/__tests__/permission/decision-channel-remember.test.ts` 的内容(验证 Task 4 的 remember 透传在装配后仍端到端工作):

```ts
import { describe, it, expect } from 'vitest';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { createSecurityDecision, SECURITY_PROTOCOL_VERSION, type UserDecision } from '../../permission/decisions.js';

class MemStore { async save() {} async load() { return []; } async update() {} }

describe('remember → allowlist 回归', () => {
  it('remember=true 经 onAuthorized 写 allowlist', async () => {
    const allowlist = new SessionAllowlist();
    let resolveReq: ((u: UserDecision) => void) | null = null;
    const gate = new RuntimeSecurityGate({
      pendingStore: new MemStore() as any,
      channel: { request: () => new Promise<UserDecision>(r => { resolveReq = r; }) } as any,
    });
    const decision = createSecurityDecision({
      protocol_version: SECURITY_PROTOCOL_VERSION, decision_id: 'd1',
      action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 's1' },
      behavior: 'ask', deciding_layer: 'permission', risk_kind: 'workspace_mutation',
      policy_id: 'p', policy_version: '1',
      reason_code: 'permission.user_confirmation_required', human_reason: 't',
      provenance_refs: ['t'],
    });
    const input = { path: 'a.txt', content: 'x' };
    const p = gate.execute(decision, async () => 'ok', {
      onAuthorized: (a) => { if (a.remember) allowlist.add('write_file', input); },
    });
    await new Promise(r => setTimeout(r, 10));
    resolveReq!({ protocol_version: SECURITY_PROTOCOL_VERSION, decision_id: 'd1', response: 'approved_once', decided_at: new Date().toISOString(), remember: true });
    expect(await p).toBe('ok');
    expect(allowlist.has('write_file', input)).toBe(true);
  });
});
```

此测试在 Task 4 完成后即 GREEN(回归保护),不是本 Task 的 RED。

- [ ] **Step 2: 运行 permission-answer-mapping 确认 RED**

```powershell
npx.cmd vitest run src/__tests__/permission/permission-answer-mapping.test.ts
```

Expected: FAIL — 模块 `permission-answer-mapping.ts` 不存在。

- [ ] **Step 3: 实现纯函数 mapPermissionAnswerToUserDecision(GREEN)**

Create `src/permission/permission-answer-mapping.ts`:

```ts
// UI 问卷 answer → UserDecision 的精确映射。
// 物理本质:柜台三按钮,只有前两个能放行,其余一律视为拒绝。
// 关键安全不变量:Reject / unknown / empty / 非 submitted 绝不映射成 approved_once。
import { SECURITY_PROTOCOL_VERSION, type UserDecision } from './decisions.js';
import type { AskQuestionOutcome } from '../agent/ask-user-types.js';

/** 两个放行选项的文案常量(单一真相源)。
 * mapPermissionAnswerToUserDecision 精确匹配;index.ts 构造 Permission options 也用这两个常量,
 * 不再重复硬编码 label,保证 UI 显示与 answer 映射永远一致。 */
export const ALLOW_ONCE_LABEL = 'Allow once';
export const ALLOW_EXACT_LABEL = 'Allow this exact action for this session';

export function mapPermissionAnswerToUserDecision(
  decisionId: string,
  outcome: AskQuestionOutcome,
): UserDecision {
  const base = {
    protocol_version: SECURITY_PROTOCOL_VERSION,
    decision_id: decisionId,
    decided_at: new Date().toISOString(),
  };

  // 非 submitted(cancelled / chat)→ rejected
  if (outcome.kind !== 'submitted') {
    return { ...base, response: 'rejected' };
  }

  // submitted:取第一个 answer(单选问卷)。无值 → rejected
  const answer = Object.values(outcome.answers)[0];
  if (answer === undefined) {
    return { ...base, response: 'rejected' };
  }

  // 精确匹配两个放行选项;其余一律 rejected
  if (answer === ALLOW_ONCE_LABEL) {
    return { ...base, response: 'approved_once', remember: false };
  }
  if (answer === ALLOW_EXACT_LABEL) {
    return { ...base, response: 'approved_once', remember: true };
  }
  // Reject / unknown → rejected(绝不 approved_once)
  return { ...base, response: 'rejected' };
}
```

- [ ] **Step 3b: 运行 mapping 测试确认 GREEN**

```powershell
npx.cmd vitest run src/__tests__/permission/permission-answer-mapping.test.ts
```

Expected: 全部 8 用例通过。Reject/unknown/empty/cancelled/chat 全部 → rejected。

- [ ] **Step 4: index.ts 装配 SessionAllowlist + getDecisionChannel 调用纯函数**

In `src/index.ts`, near L395-399 装配:

```ts
import { SessionAllowlist } from './permission/session-allowlist.js';
import { mapPermissionAnswerToUserDecision, ALLOW_ONCE_LABEL, ALLOW_EXACT_LABEL } from './permission/permission-answer-mapping.js';

const sessionAllowlist = new SessionAllowlist();
const executionRuntime = { permissionChecker, runtimeGate, sessionAllowlist };
```

In `getDecisionChannel`(L333-364),options 增第 3 项。**label 直接复用常量**(修正点 3:UI 显示与 answer 映射同源,不再硬编码);response 映射**改为调用纯函数**(修正点 2:不再用"非 remember 即 allow once"的错误逻辑):

```ts
options: [
  { label: ALLOW_ONCE_LABEL, description: 'Run this action exactly once. It will not be remembered.' },
  { label: ALLOW_EXACT_LABEL, description: 'Run now and remember this exact command for the rest of this session.' },
  { label: 'Reject', description: 'Do not run this action.' },
],
```

response 映射(替换原 if/else 块):

```ts
const outcome: AskQuestionOutcome = await askManager.ask(request);
return mapPermissionAnswerToUserDecision(decision.decision_id, outcome);
```

> **修正点 2 核心改动**:原计划对所有 submitted answer 都返回 `approved_once`(只有 remember 不同),这是权限 bug——选 "Reject" 也会放行。现在 `mapPermissionAnswerToUserDecision` 精确匹配,只有两个明确的 Allow 选项才 approved_once,Reject/unknown/empty 全部 rejected。该纯函数有独立 RED 测试(Task 6 Step 1)锁定。

- [ ] **Step 5: 三处 session 切换点调 allowlist.clear()**

按调查结果:

L452 `rotateSessionId` 闭包:

```ts
rotateSessionId: () => { sessionId = randomUUID(); sessionAllowlist.clear(); },
```

L615 `handleRewindLastTurn`:

```ts
sessionId = randomUUID();
sessionAllowlist.clear();
```

L1044 `--resume`:

```ts
sessionId = resumeId;
sessionAllowlist.clear();
```

- [ ] **Step 6: 运行权限全量 + 回归**

```powershell
npx.cmd vitest run src/__tests__/permission/ src/__tests__/regression/streaming-permission-passthrough.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts src/__tests__/regression/build-mode-permission.test.ts
```

Expected: 全绿。

- [ ] **Step 7: typecheck + lint + Commit**

```powershell
npm.cmd run typecheck
npm.cmd run lint
git add src/index.ts src/__tests__/permission/decision-channel-remember.test.ts
git commit -m "feat(permission): wire session allowlist UI option and lifecycle clear"
```

---

## Task 7: 跨层回归 + 全量验收

- [ ] **Step 1: 权限层全量**

```powershell
npx.cmd vitest run src/__tests__/permission/ --reporter=verbose
```

Expected: checker-reason-code / subagent-silent-policy / session-allowlist / runtime-gate-remember / origin-routing / decision-channel-remember 全绿。

- [ ] **Step 2: 子代理 + 执行链路回归**

```powershell
npx.cmd vitest run src/__tests__/regression/streaming-permission-passthrough.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts src/__tests__/regression/build-mode-permission.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/task-tool.test.ts
```

Expected: 全绿。

- [ ] **Step 3: 静态检查**

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: exit 0。

- [ ] **Step 4: 全量测试**

```powershell
npm.cmd test
```

Expected: 全绿。

- [ ] **Step 5: diff 范围检查**

```powershell
$baseCommit = git merge-base HEAD origin/master
git diff --stat "$baseCommit..HEAD"
git diff --name-only "$baseCommit..HEAD"
```

Expected: 仅本计划文件 + 既有 feature 分支提交。

- [ ] **Step 6: code review + verification**

使用 `superpowers:requesting-code-review` + `superpowers:verification-before-completion`。

---

## Acceptance Traceability

| 必须覆盖行为 | 实现于 | 验证于 | RED 原因 |
|---|---|---|---|
| 子代理普通 write → 静默 allow | Task 2+5 | origin-routing S1 | origin 字段不存在 + 路由未实现 → channel 收到请求 |
| 子代理危险命令 → deny | Task 1+5 | origin-routing S2 | (checker 已 deny,路由前就拦截;测试锁定行为) |
| 子代理变量未知 bash → 静默 deny | Task 1+2+5 | origin-routing S3 | unresolvable_var 缺口 + 路由未实现 |
| 主 Agent 相同不确定命令 → 仍询问 | Task 5 | origin-routing S4 | origin=main 未走静默 → channel 收到请求 |
| 主 Agent remembered → 不询问,**且仍经 gate.execute** | Task 3+5 | origin-routing S5(executeSpy 断言) | allowlist 未接入 / origin 未透传 |
| remembered 命中危险规则仍 deny | Task 5 | origin-routing S7 | checkDecision 先 deny(allowlist 在其后) |
| remember → 写 allowlist | Task 4+5+6 | origin-routing S8 + decision-channel-remember(回归) | remember 透传不存在 |
| reason_code 同源产出 | Task 1 | checker-reason-code | reason_code 字段不存在 |
| unresolvable_var 缺口修复 | Task 1 | checker-reason-code | 当前落入 default |
| 未知 ask → fail-closed deny | Task 2 | subagent-silent-policy | 模块不存在 |
| allowlist exact-match | Task 3 | session-allowlist | 模块不存在 |
| gate non-interfering observer(remember 透传 + throw 不阻止) | Task 4 | runtime-gate-remember(4 用例) | execute 无第 3 参数;observer throw 会使 promise reject |
| **Reject 不可能映射成 approved_once** | Task 6 | permission-answer-mapping(8 用例) | 模块不存在 |
| **allowlist hit 统一经 gate(无第二套执行)** | Task 5 | origin-routing S5(executeSpy) | 原 bypass 分支直接调 executor(gate 未被调) |
| allowlist session 清空 | Task 6 | (装配 + 回归) | 三处切换点未调 clear |
