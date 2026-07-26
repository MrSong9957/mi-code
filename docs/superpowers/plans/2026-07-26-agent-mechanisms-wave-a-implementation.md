# mi-code Agent Mechanisms Wave A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：冻结

**Goal:** 实现 Wave A 的五个 Root Contract，为后续 Prompt、Context、Tool、Completion 和 Security 机制提供不可变、可验证的基础协议。

**Architecture:** 新增五组聚焦的契约模块，并通过兼容 adapter 接入现有 ToolRegistry、Provider clients、Subagent 和 PermissionChecker。Wave A 只建立治理、identity、snapshot、discovery、result 和 decision vocabulary；不提前实现 Wave B 的 compiler、overlay、blocking ask、pairing recovery 或 observability。

**Tech Stack:** Node.js >=18、TypeScript ES2022/NodeNext strict、Vitest 3、现有 `node:fs`/`node:path`、现有 Provider SDK。

## Global Constraints

- 冻结规格：`docs/superpowers/specs/2026-07-26-agent-foundation-wave-a-design.md`。
- 覆盖且只覆盖 M-006、M-010、M-018、M-019、M-023、M-037、M-057、M-062。
- M-019/M-057 是 Required Reuse：补契约与 conformance test，不重写 Provider tool plane/adapter。
- `asset_version`、`protocol_version`、Provider model version 三者正交。
- Snapshot 创建后不可变；同一输入必须产生确定性结果。
- Discovery 只输出候选，不读取正文、不建立 Trust/Authority/Placement。
- Background dispatch 不产生 Completion Outcome。
- `completed` 必须有达到最低等级的验证证据。
- `cancelled` 只能来自用户主动中止。
- `ask` 是等待 UserDecision 的协议状态，不是 warning；Wave A 不实现等待通道。
- 每个生产行为改动必须先有因正确原因失败的测试。
- 本计划不执行 Git 写操作；每个 Task 以 review checkpoint 代替 commit。

---

## 1. 文件责任图

| 文件 | 操作 | 单一职责 |
|---|---|---|
| `src/agent/contracts/identities.ts` | Create | 公共 ID/版本值校验，不承载 Authority |
| `src/agent/prompt/registry.ts` | Create | 构建 approved-only immutable Prompt Registry |
| `src/agent/tools/descriptor-snapshot.ts` | Create | Tool identity、canonical order、immutable base snapshot |
| `src/agent/contracts/request-snapshot.ts` | Create | Provider-neutral SemanticRequestSnapshot |
| `src/agent/context/discovery.ts` | Create | workspace/repository 内确定性规则候选发现 |
| `src/agent/contracts/completion-report.ts` | Create | CompletionReport/DispatchReceipt 创建与不变量校验 |
| `src/permission/decisions.ts` | Create | SecurityDecision/UserDecision 类型与兼容适配 |
| `src/agent/tool-registry.ts` | Modify | 拒绝重复注册，暴露 descriptor snapshot |
| `src/agent/subagent.ts` | Modify | 迁移为 CompletionReport 或 DispatchReceipt |
| `src/permission/checker.ts` | Modify | 输出完整 SecurityDecision 所需的确定性事实 |
| `src/permission/types.ts` | Modify | 保留旧 rule 类型，移除旧 PermissionDecision 主协议 |
| `src/agent/index.ts` | Modify | 导出 Wave A 公共契约 |

测试文件：

```text
src/__tests__/agent/contracts/identities.test.ts
src/__tests__/agent/prompt-registry.test.ts
src/__tests__/agent/tool-descriptor-snapshot.test.ts
src/__tests__/agent/request-snapshot.test.ts
src/__tests__/agent/provider-adapter-contract.test.ts
src/__tests__/agent/project-rule-discovery.test.ts
src/__tests__/agent/completion-report.test.ts
src/__tests__/agent/subagent-completion-migration.test.ts
src/__tests__/permission/security-decision.test.ts
src/__tests__/permission/security-decision-integration.test.ts
```

## 2. 接口依赖

```text
identities
 ├─ prompt/registry
 ├─ tools/descriptor-snapshot
 ├─ contracts/request-snapshot
 ├─ contracts/completion-report
 └─ permission/decisions

prompt/registry ────────────────→ Wave B BRC-1
tools/descriptor-snapshot ──────→ request-snapshot → Wave B BRC-2/BRC-5
context/discovery ──────────────→ Wave B BRC-3
completion-report ──────────────→ subagent → Wave B BRC-4/BRC-5
permission/decisions ───────────→ PermissionChecker → Wave B BRC-6
```

## Task 1: 公共身份与不可变值校验

**Files:**
- Create: `src/agent/contracts/identities.ts`
- Test: `src/__tests__/agent/contracts/identities.test.ts`

**Interfaces:**
- Consumes: 原始 `unknown` ID/version 值。
- Produces: `requireIdentity(value, field): string`、`freezeSnapshot<T>(value): Readonly<T>`。

- [ ] **Step 1: 写身份校验失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { freezeSnapshot, requireIdentity } from '../../../agent/contracts/identities.js';

describe('requireIdentity', () => {
  it.each([['', 'empty'], ['   ', 'blank'], [null, 'null'], [42, 'number']])(
    'rejects %s identity',
    (value) => {
      expect(() => requireIdentity(value, 'request_id')).toThrow('request_id');
    },
  );

  it('does not infer authority from an id prefix', () => {
    expect(requireIdentity('system:memory-1', 'source_id')).toBe('system:memory-1');
  });
});

describe('freezeSnapshot', () => {
  it('deep-freezes nested arrays and records', () => {
    const value = freezeSnapshot({ items: [{ id: 'a' }] });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.items)).toBe(true);
    expect(Object.isFrozen(value.items[0])).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
npx vitest run src/__tests__/agent/contracts/identities.test.ts
```

Expected: FAIL，模块 `identities.js` 不存在。

- [ ] **Step 3: 实现最小身份校验与深冻结**

```ts
export function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

export function freezeSnapshot<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeSnapshot(child);
    }
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
```

- [ ] **Step 4: 运行 GREEN 与类型检查**

```powershell
npx vitest run src/__tests__/agent/contracts/identities.test.ts
npm run typecheck
```

Expected: targeted test PASS；typecheck exit 0。

- [ ] **Step 5: Review checkpoint**

确认该模块没有 branded authority 类型、全局 ID generator 或 Provider 特定字段。

## Task 2: RC-1 Prompt Asset Registry

**Files:**
- Create: `src/agent/prompt/registry.ts`
- Test: `src/__tests__/agent/prompt-registry.test.ts`

**Interfaces:**
- Consumes: `PromptAssetRecord[]`、已存在的 evidence/capability ID 集合、`registrySnapshotId`。
- Produces: `buildPromptAssetRegistry(input): PromptAssetRegistrySnapshot`。

- [ ] **Step 1: 写 approved-only 与版本正交测试**

```ts
import { describe, expect, it } from 'vitest';
import { buildPromptAssetRegistry, type PromptAssetRecord } from '../../agent/prompt/registry.js';

const base: PromptAssetRecord = {
  asset_id: 'agent.base',
  asset_version: '1',
  source: { kind: 'mi-code', locator: 'src/prompts/base.md', license: 'ISC' },
  purpose: 'base agent behavior',
  owner: 'P1',
  target_models: [],
  target_capabilities: ['text'],
  prohibited_placements: [],
  adaptation_notes: '',
  evaluation: { status: 'approved', evidence_refs: ['eval:base:1'] },
  content_ref: 'prompt:agent.base:1',
};

describe('buildPromptAssetRegistry', () => {
  it('includes approved assets and excludes candidate assets', () => {
    const snapshot = buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [
        base,
        { ...base, asset_id: 'candidate', evaluation: { status: 'candidate', evidence_refs: [] } },
      ],
      known_evidence_refs: new Set(['eval:base:1']),
      known_capabilities: new Set(['text']),
    });
    expect(snapshot.assets.map((asset) => asset.asset_id)).toEqual(['agent.base']);
    expect(Object.isFrozen(snapshot.assets)).toBe(true);
  });

  it('rejects same identity/version with different content refs', () => {
    expect(() => buildPromptAssetRegistry({
      registry_snapshot_id: 'registry-1',
      records: [base, { ...base, content_ref: 'prompt:different' }],
      known_evidence_refs: new Set(['eval:base:1']),
      known_capabilities: new Set(['text']),
    })).toThrow('agent.base@1');
  });

  it('does not use protocol_version as asset_version', () => {
    expect(base).not.toHaveProperty('protocol_version');
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
npx vitest run src/__tests__/agent/prompt-registry.test.ts
```

Expected: FAIL，registry module 不存在。

- [ ] **Step 3: 定义冻结规格中的资产类型**

在 `registry.ts` 中精确实现：

```ts
export type PromptEvaluationStatus =
  | 'unverified'
  | 'candidate'
  | 'approved'
  | 'rejected'
  | 'retired';

export interface PromptAssetRecord {
  asset_id: string;
  asset_version: string;
  source: {
    kind: 'mi-code' | 'claude-reference' | 'external';
    locator: string;
    license: string | null;
  };
  purpose: string;
  owner: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
  target_models: string[];
  target_capabilities: string[];
  prohibited_placements: string[];
  adaptation_notes: string;
  evaluation: {
    status: PromptEvaluationStatus;
    evidence_refs: string[];
  };
  content_ref: string;
}

export interface PromptAssetRegistrySnapshot {
  registry_snapshot_id: string;
  assets: readonly Readonly<PromptAssetRecord>[];
}
```

- [ ] **Step 4: 实现确定性 Registry builder**

`buildPromptAssetRegistry()` 必须：

1. 校验 `registry_snapshot_id`。
2. 按 `asset_id + asset_version` 检测冲突。
3. 对 `approved` 强制 license、evidence、capability 存在。
4. 只输出 approved。
5. 按 `(asset_id, asset_version)` 稳定排序。
6. 先复制记录及其嵌套数组，再深冻结输出；不得冻结调用方传入对象。
7. 任一 approved 记录无效时整体失败，不部分加载。

核心排序实现：

```ts
const approved = records
  .filter((record) => record.evaluation.status === 'approved')
  .sort((left, right) =>
    left.asset_id.localeCompare(right.asset_id)
      || left.asset_version.localeCompare(right.asset_version));
```

- [ ] **Step 5: 补拒绝路径测试**

增加以下 case，每项明确断言 reason：

```text
approved external asset + license=null       → reject
approved + missing evidence ref              → reject
approved + unknown target capability         → reject
candidate + missing evidence                 → excluded, not fatal
same identity/version + same content_ref     → deduplicated
same inputs in different source order        → identical snapshot assets
```

- [ ] **Step 6: 运行验证**

```powershell
npx vitest run src/__tests__/agent/prompt-registry.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Review checkpoint**

确认没有读取 Claude Prompt Library、没有把 candidate 激活、没有实现 compiler。

## Task 3: RC-2 Tool Identity 与 Deterministic Base Order

**Files:**
- Create: `src/agent/tools/descriptor-snapshot.ts`
- Modify: `src/agent/tool-registry.ts`
- Test: `src/__tests__/agent/tool-descriptor-snapshot.test.ts`
- Test: `src/__tests__/agent/tool-registry-ctx.test.ts`

**Interfaces:**
- Consumes: `ReadonlyMap<string, RegisteredTool>`、`registry_snapshot_id`。
- Produces: `buildToolDefinitionSnapshot()`、`ToolRegistry.getDefinitionSnapshot()`。

- [ ] **Step 1: 写重复注册和顺序稳定性测试**

```ts
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../agent/tool-registry.js';

const definition = (name: string) => ({
  name,
  description: `${name} description`,
  parameters: { type: 'object' as const, properties: {}, required: [] },
});

describe('ToolRegistry definition snapshot', () => {
  it('seeds canonical order from registration order', () => {
    const registry = new ToolRegistry();
    registry.register(definition('zeta'), async () => 'z');
    registry.register(definition('alpha'), async () => 'a');
    const snapshot = registry.getDefinitionSnapshot('registry-1');
    expect(snapshot.descriptors.map(({ tool_id, canonical_order }) => [tool_id, canonical_order]))
      .toEqual([['zeta', 0], ['alpha', 1]]);
  });

  it('rejects duplicate tool ids instead of overwriting', () => {
    const registry = new ToolRegistry();
    registry.register(definition('read_file'), async () => 'first');
    expect(() => registry.register(definition('read_file'), async () => 'second'))
      .toThrow('Duplicate tool id');
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
npx vitest run src/__tests__/agent/tool-descriptor-snapshot.test.ts src/__tests__/agent/tool-registry-ctx.test.ts
```

Expected: FAIL，`getDefinitionSnapshot` 不存在，重复注册未拒绝。

- [ ] **Step 3: 实现 descriptor snapshot**

```ts
export interface ToolDescriptor {
  tool_id: string;
  canonical_order: number;
  definition: ToolDefinition;
}

export interface ToolDefinitionSnapshot {
  registry_snapshot_id: string;
  descriptors: readonly Readonly<ToolDescriptor>[];
}

export function buildToolDefinitionSnapshot(
  registrySnapshotId: string,
  tools: ReadonlyMap<string, RegisteredTool>,
): ToolDefinitionSnapshot {
  const descriptors = [...tools.entries()].map(([toolId, tool], index) => ({
    tool_id: toolId,
    canonical_order: index,
    definition: structuredClone(tool.definition),
  }));
  return freezeSnapshot({
    registry_snapshot_id: requireIdentity(registrySnapshotId, 'registry_snapshot_id'),
    descriptors,
  });
}
```

- [ ] **Step 4: 接入 ToolRegistry**

在 `register()` 入口拒绝重复 `definition.name`；增加：

```ts
getDefinitionSnapshot(registrySnapshotId: string): ToolDefinitionSnapshot {
  return buildToolDefinitionSnapshot(registrySnapshotId, this._tools);
}
```

保留 `getDefinitions()` 供兼容路径使用；Wave B 才切换请求构建入口。

- [ ] **Step 5: 补 identity 负向测试**

```text
empty registry_snapshot_id       → reject
descriptor tool_id != name       → impossible through builder
mutate source Map after snapshot → old snapshot unchanged
provider projection              → preserves descriptor order
```

- [ ] **Step 6: 运行模块验证**

```powershell
npx vitest run src/__tests__/agent/tool-descriptor-snapshot.test.ts src/__tests__/agent/tool-registry-ctx.test.ts src/__tests__/tools.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Review checkpoint**

确认没有实现 role/mode overlay（M-024）或 dynamic schema（Deferred M-021）。

## Task 4: RC-2 Semantic Request Snapshot

**Files:**
- Create: `src/agent/contracts/request-snapshot.ts`
- Test: `src/__tests__/agent/request-snapshot.test.ts`

**Interfaces:**
- Consumes: request/turn/registry identity、四类 placement 数据、`ToolDefinitionSnapshot`。
- Produces: `buildSemanticRequestSnapshot(input): SemanticRequestSnapshot`。

- [ ] **Step 1: 写 plane 分离与不可变测试**

```ts
import { describe, expect, it } from 'vitest';
import { buildSemanticRequestSnapshot } from '../../agent/contracts/request-snapshot.js';

describe('buildSemanticRequestSnapshot', () => {
  it('keeps system, meta, conversation, and tool planes separate', () => {
    const snapshot = buildSemanticRequestSnapshot({
      request_id: 'request-1',
      turn_id: 'turn-1',
      registry_snapshot_id: 'registry-1',
      system_sections: [{ section_id: 'base', placement: 'system_static', content: 'base' }],
      meta_context: [{ message_id: 'meta-1', role: 'user', content: 'project context', is_meta: true }],
      conversation: [{ message_id: 'user-1', role: 'user', content: 'fix bug', is_meta: false }],
      tools: { registry_snapshot_id: 'registry-1', descriptors: [] },
    });
    expect(snapshot.system_sections[0].placement).toBe('system_static');
    expect(snapshot.meta_context[0].is_meta).toBe(true);
    expect(snapshot.conversation[0].is_meta).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
npx vitest run src/__tests__/agent/request-snapshot.test.ts
```

Expected: FAIL，request snapshot module 不存在。

- [ ] **Step 3: 定义封闭 Placement 与语义类型**

```ts
export type SemanticPlacement =
  | 'system_static'
  | 'system_dynamic'
  | 'meta_context'
  | 'conversation'
  | 'tool_plane';

export interface SemanticSection {
  section_id: string;
  placement: 'system_static' | 'system_dynamic';
  content: string;
}

export interface SemanticMessage {
  message_id: string;
  role: 'user' | 'assistant';
  content: string | readonly ContentBlock[];
  is_meta: boolean;
}

export interface SemanticRequestSnapshot {
  request_id: string;
  turn_id: string;
  registry_snapshot_id: string;
  system_sections: readonly Readonly<SemanticSection>[];
  meta_context: readonly Readonly<SemanticMessage>[];
  conversation: readonly Readonly<SemanticMessage>[];
  tools: ToolDefinitionSnapshot;
}
```

- [ ] **Step 4: 实现 builder 不变量**

`buildSemanticRequestSnapshot()` 必须拒绝：

```text
tools.registry_snapshot_id != registry_snapshot_id
system section 使用 meta/conversation/tool placement
meta_context item is_meta=false
conversation item is_meta=true
空 request_id / turn_id / registry_snapshot_id
Provider SDK 专用对象或函数进入 snapshot
```

Provider 对象检测只接受 JSON-compatible plain data；不得调用 SDK serializer 来“修复”输入。
通过校验后先复制所有 section/message/tool 数据，再调用 `freezeSnapshot()`；不得冻结调用方的输入数组或 Registry 对象。

- [ ] **Step 5: 补 capture-then-mutate 测试**

构建 snapshot 后修改原始 section/message 数组，断言 snapshot 内容不变；尝试写入 snapshot，断言严格模式下抛错。

- [ ] **Step 6: 运行验证**

```powershell
npx vitest run src/__tests__/agent/request-snapshot.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Review checkpoint**

确认 attachment plane 未进入类型，Authority/Trust/Retention 未从 Placement 推断。

## Task 5: M-057 Provider Adapter Conformance

**Files:**
- Create: `src/__tests__/agent/provider-adapter-contract.test.ts`
- Modify only if a test exposes a violation:
  - `src/agent/anthropic-stream-client.ts`
  - `src/agent/openai-stream-client.ts`
  - `src/agent/google-stream-client.ts`

**Interfaces:**
- Consumes: 现有三家 `StreamingLLMClient` 和 `ToolUseBlock.id`。
- Produces: Provider adapter conformance evidence；不产生新 adapter 层。

- [ ] **Step 1: 建立三 Provider 契约矩阵**

测试表必须逐 Provider 断言：

```ts
const cases = [
  { provider: 'anthropic', toolCallId: 'toolu_123' },
  { provider: 'openai', toolCallId: 'call_123' },
  { provider: 'google', toolCallId: 'function-call-123' },
] as const;
```

每个 case 验证：

1. Provider tool call ID 映射为内部 `ToolUseBlock.id`。
2. 后续 `ToolResultBlock.tool_use_id` 原样引用该 ID。
3. adapter 不重排传入 tools。
4. adapter 不根据模型名删除工具。
5. 无法表达 tool identity 时返回 protocol error，不生成随机替代 ID。

- [ ] **Step 2: 运行测试并观察当前事实**

```powershell
npx vitest run src/__tests__/agent/provider-adapter-contract.test.ts src/__tests__/agent/openai-stream-client.test.ts src/__tests__/agent/google-stream-client.test.ts
```

Expected: 新测试至少因 fixture/契约尚未建立而 RED；记录每家 Provider 的真实差异。

- [ ] **Step 3: 只修复被测试证明的 adapter 违规**

允许修改仅限：

- 保留输入 tool order；
- 保留 Provider tool call ID；
- 在缺失 ID 时抛出带 Provider 名称的 protocol error。

禁止加入 capability registry（M-058）、Prompt 条件分支或第四家 Provider。

- [ ] **Step 4: 运行三 Provider GREEN**

```powershell
npx vitest run src/__tests__/agent/provider-adapter-contract.test.ts src/__tests__/agent/openai-stream-client.test.ts src/__tests__/agent/google-stream-client.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 5: Review checkpoint**

若现有 adapter 已满足全部断言，生产文件保持不变；测试证据本身即 M-057 Required Reuse 的交付。

## Task 6: RC-3 Project Rule Discovery

**Files:**
- Create: `src/agent/context/discovery.ts`
- Test: `src/__tests__/agent/project-rule-discovery.test.ts`

**Interfaces:**
- Consumes: `ProjectRuleDiscoveryInput`、`ProjectRuleSourcePolicy`。
- Produces: `discoverProjectRuleSources(input, policy): Promise<readonly DiscoveredRuleSource[]>`。

- [ ] **Step 1: 写临时目录行为测试**

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverProjectRuleSources } from '../../agent/context/discovery.js';

it('discovers candidates from repository root to working directory deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
  const child = join(root, 'packages', 'app');
  await mkdir(child, { recursive: true });
  await writeFile(join(root, 'CLAUDE.md'), 'root');
  await writeFile(join(child, 'AGENTS.md'), 'child');

  const result = await discoverProjectRuleSources({
    workspace_root: root,
    repository_root: root,
    working_directory: child,
    source_policy_id: 'default-project-rules',
  }, {
    source_policy_id: 'default-project-rules',
    candidate_names: ['AGENTS.md', 'CLAUDE.md'],
  });

  expect(result.map((entry) => entry.absolute_path)).toEqual([
    join(root, 'CLAUDE.md'),
    join(child, 'AGENTS.md'),
  ]);
  expect(result.every((entry) => !('trusted' in entry))).toBe(true);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
npx vitest run src/__tests__/agent/project-rule-discovery.test.ts
```

Expected: FAIL，discovery module 不存在。

- [ ] **Step 3: 定义输入、policy 和候选输出**

```ts
export interface ProjectRuleDiscoveryInput {
  workspace_root: string;
  repository_root: string | null;
  working_directory: string;
  source_policy_id: string;
}

export interface ProjectRuleSourcePolicy {
  source_policy_id: string;
  candidate_names: readonly string[];
}

export interface DiscoveredRuleSource {
  source_id: string;
  candidate_kind: string;
  absolute_path: string;
  scope_root: string;
  relative_depth: number;
  discovery_order: number;
  diagnostics: string[];
}
```

- [ ] **Step 4: 实现边界内确定性发现**

算法固定为：

1. `resolve()` 并校验 workspace/repository/working directory 为绝对路径。
2. 确认 working directory 位于 workspace；repository 存在时还必须位于 repository。
3. 从有效 root 到 working directory 枚举祖先目录。
4. 每层按 `candidate_names` 原顺序探测。
5. 使用规范化绝对路径去重。
6. 以发现顺序赋 `discovery_order`。
7. 不读取文件正文。
8. 不可读/符号链接/realpath 不确定只记录 diagnostic，绝不添加 trusted 字段。

- [ ] **Step 5: 补防御测试**

```text
relative root                         → reject
working directory outside workspace  → reject
repository boundary escape           → reject
unknown source_policy_id              → reject
same physical file via duplicate path→ one candidate
unreadable candidate                  → candidate with diagnostic
file content includes instructions    → output schema still has no content/authority/trust
```

- [ ] **Step 6: 运行验证**

```powershell
npx vitest run src/__tests__/agent/project-rule-discovery.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Review checkpoint**

确认没有实现 M-011 provenance formatting、M-012 routing 或 M-040 sanitization。

## Task 7: RC-4 Completion Contract

**Files:**
- Create: `src/agent/contracts/completion-report.ts`
- Test: `src/__tests__/agent/completion-report.test.ts`

**Interfaces:**
- Consumes: subject、termination、verification、deliverables、summary。
- Produces: `createCompletionReport()`、`createDispatchReceipt()`。

- [ ] **Step 1: 写 Outcome 不变量测试**

```ts
import { describe, expect, it } from 'vitest';
import { createCompletionReport, createDispatchReceipt } from '../../agent/contracts/completion-report.js';

const passedV2 = {
  required_level: 'V2' as const,
  achieved_level: 'V2' as const,
  status: 'passed' as const,
  evidence_refs: ['test:unit-and-integration'],
  failure_kind: null,
};

it('allows completed only with sufficient verification evidence', () => {
  const report = createCompletionReport({
    protocol_version: '1',
    subject: { kind: 'subagent', id: 'subagent-1' },
    outcome: 'completed',
    termination_reason: 'end_turn',
    verification: passedV2,
    deliverables: [],
    summary: 'implemented contract',
    remaining_uncertainty: [],
  });
  expect(report.outcome).toBe('completed');
});

it('rejects cancelled without user abort', () => {
  expect(() => createCompletionReport({
    protocol_version: '1',
    subject: { kind: 'turn', id: 'turn-1' },
    outcome: 'cancelled',
    termination_reason: 'provider_error',
    verification: { ...passedV2, status: 'blocked' },
    deliverables: [],
    summary: '',
    remaining_uncertainty: [],
  })).toThrow('cancelled');
});

it('returns no outcome for background dispatch', () => {
  expect(createDispatchReceipt({
    protocol_version: '1',
    task_id: 'task-1',
    accepted: true,
  })).toEqual({
    protocol_version: '1',
    execution_mode: 'background',
    task_id: 'task-1',
    accepted: true,
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
npx vitest run src/__tests__/agent/completion-report.test.ts
```

Expected: FAIL，completion module 不存在。

- [ ] **Step 3: 实现冻结类型**

精确实现：

```ts
export type CompletionOutcome = 'completed' | 'partial' | 'failed' | 'cancelled';
export type VerificationLevel = 'V0' | 'V1' | 'V2' | 'V3';
export type VerificationStatus = 'passed' | 'failed' | 'blocked' | 'not_run';
export type VerificationFailureKind = 'repairable' | 'blocked' | 'unrecoverable';
```

以及 Wave A §10.2～§10.5 的 `CompletionReport`、`DispatchReceipt`、`VerificationReport`、`DeliverableReport` 全字段。

- [ ] **Step 4: 实现确定性 builder 规则**

`createCompletionReport()` 必须强制：

```text
completed → verification.status=passed
completed → achieved_level >= required_level
passed    → evidence_refs.length > 0
partial   → 至少一个有 evidence 的独立 deliverable
failed    → 没有可独立交付的 verified deliverable
cancelled → termination_reason=user_abort
unrecoverable → 仅接受调用方提供的 deterministic_failure_ref
foreground only
```

V0<V1<V2<V3 使用显式 rank map，不使用字符串比较。

- [ ] **Step 5: 补全部非法组合测试**

至少覆盖：

```text
completed + insufficient level        → reject
completed + empty evidence             → reject
partial + no deliverable               → reject
failed + verified deliverable          → reject
cancelled + user_abort                  → accept
provider_error + verified deliverable   → partial
provider_error + no deliverable         → failed
background passed to completion builder → reject
```

- [ ] **Step 6: 运行验证**

```powershell
npx vitest run src/__tests__/agent/completion-report.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Review checkpoint**

确认 summary 文本不参与 Outcome 计算，Memory 写入不作为 evidence。

## Task 8: SubagentResult 兼容迁移

**Files:**
- Modify: `src/agent/subagent.ts`
- Modify: `src/ui/subagent-presentation.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Test: `src/__tests__/agent/subagent-completion-migration.test.ts`
- Test: `src/__tests__/subagent-result-integrity.test.ts`
- Test: `src/__tests__/ui/subagent-presentation.test.ts`

**Interfaces:**
- Consumes: Task 7 `CompletionReport` / `DispatchReceipt`。
- Produces: `SubagentExecutionResult = { kind: 'completion'; report } | { kind: 'dispatch'; receipt }`。

- [ ] **Step 1: 写旧状态禁用测试**

```ts
it('never exposes incomplete or unverified as top-level outcomes', async () => {
  const result = await runSubagent('inspect', registry, {
    role: 'explore',
    client: clientEndingWithoutEvidence,
    maxSteps: 2,
  });
  expect(result.kind).toBe('completion');
  if (result.kind === 'completion') {
    expect(['partial', 'failed']).toContain(result.report.outcome);
    expect(result.report).not.toHaveProperty('status');
  }
});

it('maps background launch to a dispatch receipt', async () => {
  const result = await runSubagent('inspect', registry, { background: true });
  expect(result.kind).toBe('dispatch');
  if (result.kind === 'dispatch') {
    expect(result.receipt.execution_mode).toBe('background');
    expect(result.receipt).not.toHaveProperty('outcome');
  }
});
```

- [ ] **Step 2: 运行现有与新增测试并确认 RED**

```powershell
npx vitest run src/__tests__/agent/subagent-completion-migration.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts
```

Expected: 新测试因旧 `SubagentStatus` RED；现有测试记录为迁移保护。

- [ ] **Step 3: 增加明确迁移分类函数**

在 `subagent.ts` 内新增单一纯函数：

```ts
export function classifySubagentCompletion(
  execution: SubagentExecutionEvidence,
): CompletionReport
```

输入必须包含：

```ts
interface SubagentExecutionEvidence {
  subject_id: string;
  termination_reason: 'end_turn' | 'max_turns' | 'user_abort' | 'error';
  required_level: VerificationLevel;
  achieved_level: VerificationLevel | null;
  evidence_refs: string[];
  deliverables: DeliverableReport[];
  summary: string;
}
```

不得从 `[Subagent ...]` 文本前缀解析机器状态。

- [ ] **Step 4: 按冻结迁移表切换 runSubagent 返回值**

删除顶层 `SubagentStatus` 的生产写入；保留一个只读 legacy presentation adapter：

```ts
export function formatSubagentExecutionResult(result: SubagentExecutionResult): string
```

该函数只负责 UI 文本，不能反向修改 report。

- [ ] **Step 5: 更新调用者为判别联合**

`spawn-agent-tool.ts` 和 UI presentation 必须显式处理：

```ts
if (result.kind === 'dispatch') {
  return renderDispatchReceipt(result.receipt);
}
return renderCompletionReport(result.report);
```

禁止用 optional chaining 把两类结果混为一个松散对象。

- [ ] **Step 6: 运行迁移回归**

```powershell
npx vitest run src/__tests__/agent/subagent-completion-migration.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/ui/subagent-presentation.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Review checkpoint**

确认代码中不再产生 `completed + user_abort`、`completed + insufficient verification`、顶层 `incomplete/unverified/background`。

## Task 9: RC-5 SecurityDecision 与 Permission 兼容适配

**Files:**
- Create: `src/permission/decisions.ts`
- Modify: `src/permission/types.ts`
- Modify: `src/permission/checker.ts`
- Test: `src/__tests__/permission/security-decision.test.ts`
- Test: `src/__tests__/permission/security-decision-integration.test.ts`
- Test: `src/__tests__/permission.test.ts`

**Interfaces:**
- Consumes: 旧 `{ behavior, reason }` 判定事实 + action/policy identity。
- Produces: `SecurityDecision`、`UserDecision`、`createSecurityDecision()`、`mergeSecurityDecisions()`。

- [ ] **Step 1: 写 fail-closed 与决策优先级测试**

```ts
import { describe, expect, it } from 'vitest';
import { createSecurityDecision, mergeSecurityDecisions } from '../../permission/decisions.js';

const decision = (behavior: 'allow' | 'ask' | 'deny') => createSecurityDecision({
  protocol_version: '1',
  decision_id: `decision-${behavior}`,
  action: { kind: 'tool_call', subject_id: 'run_bash', snapshot_id: 'action-1' },
  behavior,
  deciding_layer: 'permission',
  risk_kind: 'workspace_mutation',
  policy_id: 'permission-default',
  policy_version: '1',
  reason_code: `permission.${behavior}`,
  human_reason: behavior,
  provenance_refs: ['rule:default'],
});

it('merges deny over ask over allow', () => {
  expect(mergeSecurityDecisions([decision('allow'), decision('ask')]).behavior).toBe('ask');
  expect(mergeSecurityDecisions([decision('allow'), decision('deny')]).behavior).toBe('deny');
});

it('fails closed when policy evaluation fails', () => {
  const failed = createSecurityDecision({
    protocol_version: '1',
    decision_id: 'decision-failed-policy',
    action: { kind: 'tool_call', subject_id: 'run_bash', snapshot_id: 'action-2' },
    behavior: 'deny',
    deciding_layer: 'permission',
    risk_kind: 'policy_failure',
    policy_id: 'permission-default',
    policy_version: '1',
    reason_code: 'policy.invalid',
    human_reason: 'Policy evaluation failed',
    provenance_refs: ['policy-load:error'],
  });
  expect(failed.behavior).toBe('deny');
});
```

- [ ] **Step 2: 运行测试并确认 RED**

```powershell
npx vitest run src/__tests__/permission/security-decision.test.ts
```

Expected: FAIL，decision module 不存在。

- [ ] **Step 3: 实现完整决策协议**

按 Wave A §11.2/§11.4 实现：

```ts
export interface SecurityDecision {
  protocol_version: string;
  decision_id: string;
  action: {
    kind: string;
    subject_id: string;
    snapshot_id: string;
  };
  behavior: 'allow' | 'ask' | 'deny';
  deciding_layer: string;
  risk_kind: string;
  policy_id: string;
  policy_version: string;
  reason_code: string;
  human_reason: string;
  provenance_refs: string[];
}

export interface UserDecision {
  protocol_version: string;
  decision_id: string;
  response: 'approved_once' | 'rejected';
  decided_at: string;
}
```

`createSecurityDecision()` 校验所有 identity/provenance 并深冻结。未知 behavior、缺 policy、缺 provenance 一律返回或转换为结构化 deny；不得抛出后由调用方默认 allow。

- [ ] **Step 4: 实现确定性 merge**

```ts
const behaviorRank = { allow: 0, ask: 1, deny: 2 } as const;

export function mergeSecurityDecisions(
  decisions: readonly SecurityDecision[],
): SecurityDecision {
  if (decisions.length === 0) return createMissingPolicyDeny();
  return [...decisions].sort((left, right) =>
    behaviorRank[right.behavior] - behaviorRank[left.behavior]
      || left.deciding_layer.localeCompare(right.deciding_layer)
      || left.decision_id.localeCompare(right.decision_id))[0];
}
```

返回对象必须是新的 immutable merged decision，包含所有输入 decision provenance refs；不能直接返回并修改某个输入。

- [ ] **Step 5: 适配 PermissionChecker**

增加结构化主协议 `PermissionChecker.checkDecision()`：

```ts
checkDecision(
  toolName: string,
  input: Record<string, unknown>,
  context: {
    decision_id: string;
    action_snapshot_id: string;
    policy_id: string;
    policy_version: string;
  },
): SecurityDecision
```

迁移期保留现有 `check(toolName, input): PermissionDecision`，其实现复用同一个内部 policy fact evaluator；不得复制两套判定规则。Wave B 切换所有调用者到 `checkDecision()` 后再删除旧 `check()`。`checkDecision()` 不得内部生成随机 ID。

旧 reason 文本映射为稳定 `reason_code`：

```text
dangerous bash              → permission.dangerous_command
outside workspace           → permission.path_outside_workspace
unparseable command         → permission.command_unparseable
plan write                  → permission.plan_write_blocked
matched deny rule           → permission.rule_deny
matched allow rule          → permission.rule_allow
write needs confirmation    → permission.user_confirmation_required
```

- [ ] **Step 6: 写 ask 不越权的 Wave A 边界测试**

本 Task 只验证协议：

```ts
const ask = checker.checkDecision('write_file', { path: 'x' }, context);
expect(ask.behavior).toBe('ask');
expect(ask.action.snapshot_id).toBe(context.action_snapshot_id);
expect(ask).not.toHaveProperty('approved');
```

不要在本 Task 实现 pending store/UI；该工作属于 Wave B M-066。

- [ ] **Step 7: 运行权限回归**

```powershell
npx vitest run src/__tests__/permission/security-decision.test.ts src/__tests__/permission/security-decision-integration.test.ts src/__tests__/permission.test.ts src/__tests__/regression/permission-executor-integration.test.ts
npm run typecheck
```

Expected: PASS。

- [ ] **Step 8: Review checkpoint**

确认 Prompt/模型输出不能创建 allow/deny，`human_reason` 不参与机器分支。

## Task 10: Wave A 公共出口与跨契约验收

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/permission/index.ts`
- Create: `src/__tests__/agent/wave-a-contracts.test.ts`
- Create: `logs/agent-mechanisms-wave-a-verification.md`

**Interfaces:**
- Consumes: Task 1～9 的公共接口。
- Produces: 稳定导出面、INV-A1～A8 的机器验收证据。

- [ ] **Step 1: 写公共导出 smoke test**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildPromptAssetRegistry,
  buildSemanticRequestSnapshot,
  createCompletionReport,
  discoverProjectRuleSources,
} from '../../agent/index.js';
import { createSecurityDecision } from '../../permission/index.js';

describe('Wave A public contracts', () => {
  it('exports every root contract anchor', () => {
    expect(buildPromptAssetRegistry).toBeTypeOf('function');
    expect(buildSemanticRequestSnapshot).toBeTypeOf('function');
    expect(discoverProjectRuleSources).toBeTypeOf('function');
    expect(createCompletionReport).toBeTypeOf('function');
    expect(createSecurityDecision).toBeTypeOf('function');
  });
});
```

- [ ] **Step 2: 运行 smoke test 并确认 RED**

```powershell
npx vitest run src/__tests__/agent/wave-a-contracts.test.ts
```

Expected: FAIL，公共出口尚未导出。

- [ ] **Step 3: 增加显式导出**

只导出 Contract 所需类型和函数；不从 index 导出内部排序 helper、测试 factory 或 legacy adapter。

- [ ] **Step 4: 增加 INV-A1～A8 验收表驱动测试**

`wave-a-contracts.test.ts` 必须逐项包含以下 test name：

```text
INV-A1 keeps asset and protocol versions orthogonal
INV-A2 provider adapter cannot mutate semantic request
INV-A3 discovery never returns authority or trust
INV-A4 tool call identity survives request and result mapping
INV-A5 text cannot override structured result or decision
INV-A6 ask has no approved execution state
INV-A7 completed requires verification evidence
INV-A8 registry and request snapshots are immutable
```

- [ ] **Step 5: 运行 Wave A targeted suite**

```powershell
npx vitest run src/__tests__/agent/contracts/ src/__tests__/agent/prompt-registry.test.ts src/__tests__/agent/tool-descriptor-snapshot.test.ts src/__tests__/agent/request-snapshot.test.ts src/__tests__/agent/provider-adapter-contract.test.ts src/__tests__/agent/project-rule-discovery.test.ts src/__tests__/agent/completion-report.test.ts src/__tests__/agent/subagent-completion-migration.test.ts src/__tests__/agent/wave-a-contracts.test.ts src/__tests__/permission/security-decision.test.ts src/__tests__/permission/security-decision-integration.test.ts
```

Expected: all PASS, 0 failed。

- [ ] **Step 6: 运行受影响模块回归**

```powershell
npx vitest run src/__tests__/streaming-query.test.ts src/__tests__/streaming-executor.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/permission.test.ts src/__tests__/regression/permission-executor-integration.test.ts
```

Expected: all PASS。

- [ ] **Step 7: 运行静态与构建验证**

```powershell
npm run typecheck
npm run lint
npm run build
```

Expected: all commands exit 0。

- [ ] **Step 8: 运行 Wave Gate 全量测试**

```powershell
npm test
```

Expected: all tests PASS；expected-failure tests 仍按测试框架语义单独记录，不能算作缺口已修复。

- [ ] **Step 9: 写验证日志**

`logs/agent-mechanisms-wave-a-verification.md` 只记录：

```markdown
# Wave A Verification

- changed: [实际文件]
- mechanisms: M-006, M-010, M-018, M-019, M-023, M-037, M-057, M-062
- verification_level: V2
- red_evidence: [命令与失败原因]
- green_evidence: [命令与通过计数]
- invariant_evidence: INV-A1 through INV-A8
- remaining_uncertainty: [仅列真实未验证项]
- deferred_hold_check: no Deferred or Hold implementation activated
```

- [ ] **Step 10: Review checkpoint**

逐条对照 Wave A §16 验收矩阵和 §17 完成标准。任何一项没有测试或 runtime assertion，Wave A 保持部分完成，不进入 Wave B。

## 3. Wave A Handoff

Wave A 通过后，Wave B 可以依赖：

- approved-only immutable Prompt Registry；
- stable `asset_id + asset_version`；
- immutable SemanticRequestSnapshot 词汇；
- deterministic ToolDefinitionSnapshot 与 stable tool identity；
- Project Rule candidates；
- CompletionReport/DispatchReceipt；
- SecurityDecision/UserDecision vocabulary；
- Provider adapter identity conformance evidence。

Wave B 仍然不能假设：

- Prompt compiler 已存在；
- candidate Prompt 已 approved；
- Context candidate 已 trusted；
- tool overlay/capability registry 已存在；
- ask 已阻塞并可恢复；
- tool transcript pairing 已运行时强制；
- production telemetry 已启用。

## 4. 完成标准

Wave A 只有满足以下条件才能声明完成：

1. 8 个机制均映射到上述 Task，且没有 Deferred/Hold 代码。
2. RC-1～RC-5 公共接口可从稳定 index 导入。
3. INV-A1～A8 各有机器可判定测试。
4. M-019/M-057 保持复用，没有重写 Provider tool plane/adapter。
5. Subagent 不再产生旧顶层状态。
6. Permission 主协议携带 action/policy/decision identity。
7. `ask` 没有被标记为 approved；运行时阻塞明确保留给 Wave B。
8. targeted、affected regression、typecheck、lint、build、full test 均有新鲜成功证据。
9. 验证日志记录实际结果与剩余不确定性。
10. 未执行部署、依赖升级、数据库迁移或 Git 历史写操作。
