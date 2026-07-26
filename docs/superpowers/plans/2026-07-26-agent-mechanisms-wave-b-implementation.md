# mi-code Agent Mechanisms Wave B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：冻结

**Goal:** 实现 Wave B 的七个 Primary Anchor Contract，使 Prompt compilation、最终工具视图、Context intake、Agent profile、tool transcript integrity、runtime security gate 和 observability plane 成为可供 Wave C 消费的稳定运行时协议。

**Architecture:** 所有 BRC 都消费 Wave A 的 immutable snapshot/identity，不建立中央 Manager。实施按纯契约→局部 adapter→单入口 cutover 推进；`streaming-query.ts` 只在 transcript checkpoint 和 blocking ask 两个串行 Task 中修改，避免多个机制同时改写核心循环。

**Tech Stack:** Node.js >=18、TypeScript ES2022/NodeNext strict、Vitest 3、`node:crypto`、`node:path`、现有 Provider SDK、现有 SessionStore/AskUserManager/StreamEventBus。

## Global Constraints

- 冻结规格：`docs/superpowers/specs/2026-07-26-agent-primary-anchors-wave-b-design.md`。
- 上游冻结计划：`2026-07-26-agent-prompt-mechanisms-master-plan.md`、`2026-07-26-agent-mechanisms-wave-a-implementation.md`。
- 覆盖且只覆盖 M-001、M-011、M-014、M-020、M-024、M-035、M-039、M-040、M-042、M-050、M-051、M-058、M-063、M-066、M-070。
- BRC-1 不定义 precedence、conditions 或 cache scope。
- BRC-2 overlay 只能收窄工具视图，不能修改 schema、executor、permission 或 canonical order。
- Capability `unknown` 采用安全默认，不从 model ID 猜测。
- BRC-3 的文件、Markdown、schema、路径和正文自报来源都不建立信任。
- `writer_kind` 是封闭枚举；instruction 与 auto memory 不共享 writer/Authority/Placement。
- Context sanitizer 异常 fail closed；截断必须确定且显式。
- Profile 只请求工具/能力，不授予权限。
- Pairing validator 不合成 tool result，不判断工具业务结果正确性。
- `ask` 必须在 UserDecision 前阻止 executor；无持久化阻塞通道时 deny。
- Parent environment 不得整包传给子进程。
- BRC-7 只定义 plane/envelope；production telemetry 和 full dump 保持关闭。
- 每个生产行为修改必须先观察正确原因的 RED。
- 本计划不授权 Prompt 原文适配、数据库迁移、依赖升级、部署或 Git 历史写操作。

---

## 1. 文件责任图

```text
src/agent/
├── prompt/
│   ├── compiler.ts                 # BRC-1
│   └── profiles.ts                 # BRC-4
├── tools/
│   ├── capability-snapshot.ts      # BRC-2 / M-058
│   ├── prompt-metadata.ts          # BRC-2 / M-020
│   ├── overlay.ts                  # BRC-2 / M-024
│   └── transcript-validator.ts     # BRC-5 / M-070
├── context/
│   ├── intake.ts                   # BRC-3 facade + writer separation
│   └── intake/
│       ├── environment.ts          # M-039
│       ├── sanitizer.ts            # M-040
│       ├── source-budget.ts        # M-050
│       └── provenance.ts           # M-011
└── observability/
    └── envelopes.ts                # BRC-7 / M-051

src/permission/
├── runtime-gate.ts                 # BRC-6 / M-066
└── child-environment.ts            # BRC-6 / M-063
```

该结构不新增主计划之外的架构域：`context/intake/` 只是主计划 `context/intake.ts` 的内部实现分解，`capability-snapshot.ts`/`prompt-metadata.ts` 只是主计划 `tools/overlay.ts` 的输入类型模块。公共出口仍分别由 `intake.ts` 与 `overlay.ts` 控制；下游不得绕过 facade 直接耦合内部 helper。

现有文件的修改所有权：

| 文件 | 唯一修改 Task |
|---|---|
| `src/agent/query-engine.ts` | Task 4 |
| `src/agent/roles.ts`、`src/agent/subagent.ts` | Task 9 |
| `src/agent/compression.ts`、`src/session/store.ts` | Task 11 |
| `src/agent/streaming-query.ts` | Task 4 → Task 11 → Task 13 串行修改 |
| `src/agent/streaming-executor.ts` | Task 13 |
| `src/agent/tool-registry.ts` | Task 4 |
| `src/agent/tool-registry.ts` 的 bash spawn env | Task 12 |
| `src/background/background-manager.ts` | Task 12 |
| `src/agent/stream-event-bus.ts` | Task 14 |

Task 4、Task 11 与 Task 13 禁止并行，因为三者按“最终工具视图 → pairing checkpoints → blocking ask”顺序修改请求/执行生命周期。

## 2. Task 依赖

```text
T1 Prompt Compiler

T2 Capability Snapshot
 └─ T3 Tool Metadata + Overlay
     └─ T4 Request Tool View Cutover

T5 Context Envelope
 ├─ T6 Environment Normalization
 ├─ T7 Sanitizer
 └─ T8 Budget + Provenance + Intake Pipeline

T1 + T3 ─→ T9 Agent Profiles

T10 Transcript Validator
 └─ T11 Four Checkpoint Integration

Wave A SecurityDecision
 ├─ T12 Child Environment Scrub
 └─ T13 Blocking Ask

T14 Observability Envelope

T1–T14 ─→ T15 Wave B Acceptance
```

## Task 1: BRC-1 Prompt Compilation

**Files:**
- Create: `src/agent/prompt/compiler.ts`
- Test: `src/__tests__/agent/prompt-compiler.test.ts`

**Interfaces:**
- Consumes: Wave A Prompt Registry lookup、`PromptCompilationInput`。
- Produces: `compilePromptSnapshot(input, lookup): CompiledPromptSnapshot`。

- [ ] **Step 1: 写确定性编译 RED 测试**

```ts
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { compilePromptSnapshot } from '../../agent/prompt/compiler.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

it('sorts sections by ordinal and produces an immutable aggregate hash', () => {
  const snapshot = compilePromptSnapshot({
    compiler_protocol_version: '1',
    registry_snapshot_id: 'registry-1',
    request_snapshot_id: 'request-1',
    sections: [
      {
        section_id: 'dynamic',
        asset_ref: { asset_id: 'dynamic', asset_version: '1' },
        placement: 'system_dynamic',
        authority: 'environment',
        trust: 'trusted',
        retention: 'turn',
        ordinal: 20,
        content: 'dynamic',
        content_hash: hash('dynamic'),
        provenance_refs: ['source:environment'],
      },
      {
        section_id: 'base',
        asset_ref: { asset_id: 'base', asset_version: '1' },
        placement: 'system_static',
        authority: 'system',
        trust: 'trusted',
        retention: 'session',
        ordinal: 10,
        content: 'base',
        content_hash: hash('base'),
        provenance_refs: ['asset:base@1'],
      },
    ],
  }, { isApproved: () => true });

  expect(snapshot.section_order).toEqual(['base', 'dynamic']);
  expect(snapshot.aggregate_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(snapshot.sections)).toBe(true);
});
```

- [ ] **Step 2: 运行并确认 RED**

```powershell
npx vitest run src/__tests__/agent/prompt-compiler.test.ts
```

Expected: FAIL，compiler module 不存在。

- [ ] **Step 3: 实现冻结接口**

实现规格 §7.2/§7.3 的 `PromptSectionInput`、`PromptCompilationInput`、`CompiledPromptSnapshot`，并增加：

```ts
export interface PromptAssetApprovalLookup {
  isApproved(ref: { asset_id: string; asset_version: string }): boolean;
}

export function compilePromptSnapshot(
  input: PromptCompilationInput,
  lookup: PromptAssetApprovalLookup,
): CompiledPromptSnapshot
```

- [ ] **Step 4: 实现 hash 与错误规则**

`compilePromptSnapshot()` 必须：

1. 复制输入。
2. 拒绝空 section、重复 ID、重复 ordinal。
3. 验证 placement 仅为 system plane。
4. 验证每个 `content_hash`。
5. 验证 asset approved。
6. 按 `(ordinal, section_id)` 排序。
7. aggregate hash 覆盖 section identity、asset version、placement、content hash。
8. 使用 aggregate hash 派生稳定 `compiled_prompt_snapshot_id`。
9. 深冻结输出。

- [ ] **Step 5: 增加负向测试矩阵**

```text
duplicate section_id        → reject
duplicate ordinal           → reject
candidate asset             → reject
content hash mismatch       → reject
meta_context placement      → reject
empty section content       → reject
input mutation after build  → snapshot unchanged
same logical input ordering → same aggregate hash
```

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/prompt-compiler.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 compiler 没有 precedence、condition、cache 或资产选择逻辑。

## Task 2: M-058 Provider Capability Snapshot

**Files:**
- Create: `src/agent/tools/capability-snapshot.ts`
- Modify: `src/agent/anthropic-stream-client.ts`
- Modify: `src/agent/openai-stream-client.ts`
- Modify: `src/agent/google-stream-client.ts`
- Test: `src/__tests__/agent/capability-snapshot.test.ts`

**Interfaces:**
- Consumes: Provider adapter 显式默认能力。
- Produces: `createModelCapabilitySnapshot()`、每个 adapter 的 `getDefaultCapabilities()`。

- [ ] **Step 1: 写 unknown 安全默认测试**

```ts
it('does not infer capabilities from model id', () => {
  const snapshot = createModelCapabilitySnapshot({
    capability_protocol_version: '1',
    capability_snapshot_id: 'cap-1',
    provider_id: 'openai-compatible',
    model_id: 'claude-looking-name',
    adapter_version: '1',
    source: 'provider_adapter_default',
    capabilities: { native_tools: 'unknown' },
    diagnostics: ['adapter did not declare native_tools'],
  });
  expect(snapshot.capabilities.native_tools).toBe('unknown');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/capability-snapshot.test.ts
```

- [ ] **Step 3: 实现三态 snapshot**

```ts
export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';

export interface ModelCapabilitySnapshot {
  capability_protocol_version: string;
  capability_snapshot_id: string;
  provider_id: string;
  model_id: string;
  adapter_version: string;
  source: 'provider_adapter_default';
  capabilities: Readonly<Record<string, CapabilitySupport>>;
  diagnostics: readonly string[];
}
```

`createModelCapabilitySnapshot()` 拒绝未知 support 字符串并深冻结。

- [ ] **Step 4: 为三家 adapter 声明默认能力**

每个 adapter 只声明其代码路径确实支持的能力。初始 key 限定为：

```text
native_tools
tool_result_identity
system_instruction
provider_annotations
```

不能根据 model 名称生成不同值；第三方 override 留给 M-059。

- [ ] **Step 5: 运行 Provider conformance**

```powershell
npx vitest run src/__tests__/agent/capability-snapshot.test.ts src/__tests__/agent/provider-adapter-contract.test.ts src/__tests__/agent/openai-stream-client.test.ts src/__tests__/agent/google-stream-client.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 `unknown` 不被转换成 supported，未添加生命周期 metadata（Deferred M-061）。

## Task 3: M-020/M-024 Tool Prompt Metadata 与 Overlay

**Files:**
- Create: `src/agent/tools/prompt-metadata.ts`
- Create: `src/agent/tools/overlay.ts`
- Test: `src/__tests__/agent/tool-view-overlay.test.ts`

**Interfaces:**
- Consumes: Wave A `ToolDefinitionSnapshot`、Task 2 capability snapshot、approved asset lookup、Security policy exclusions。
- Produces: `deriveRequestToolView(input): RequestToolViewSnapshot`。

- [ ] **Step 1: 写“只能收窄”RED 测试**

```ts
it('cannot restore a capability-excluded tool through requested visibility', () => {
  const view = deriveRequestToolView({
    tool_view_protocol_version: '1',
    tool_view_snapshot_id: 'view-1',
    base: baseWith(['read_file', 'image_tool']),
    capability: capability({ image_input: 'unsupported' }),
    metadata: metadataFor({
      image_tool: { required_capabilities: ['image_input'] },
    }),
    overlay: {
      base_tool_snapshot_id: 'base-1',
      capability_snapshot_id: 'cap-1',
      control_mode: 'build',
      role_id: null,
      security_policy_snapshot_id: 'security-1',
      requested_visibility: { image_tool: 'include' },
    },
    security_excluded_tool_ids: new Set(),
    approvedAsset: () => true,
  });
  expect(view.entries.find((entry) => entry.tool_id === 'image_tool')).toMatchObject({
    visibility: 'excluded',
    exclusion_reason_code: 'capability.unsupported.image_input',
  });
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/tool-view-overlay.test.ts
```

- [ ] **Step 3: 实现 ToolPromptMetadata**

精确实现规格 §8.3，验证：

- metadata tool ID 必须存在于 base；
- candidate/rejected description asset 不进入 entry；
- `declared_policy_refs` 只作为引用；
- required capability unknown/unsupported 均排除。

- [ ] **Step 4: 实现 overlay**

精确实现 `ToolViewOverlayInput`、`RequestToolViewEntry`、`RequestToolViewSnapshot`。派生顺序固定为：

```text
base existence
→ capability requirement
→ security exclusion
→ role/mode requested exclusion
→ approved description
→ allowed provider annotations
```

请求 include 不能覆盖前面任何 exclusion。

- [ ] **Step 5: 补不可变字段测试**

```text
unknown overlay tool ID        → reject overlay
change canonical order         → impossible
change parameters schema       → impossible
add non-base tool              → reject
remaining included tools       → retain relative order
candidate description          → excluded
prompt asks to restore tool    → no API surface exists
```

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/tool-view-overlay.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认没有 tool-local policy 文本（M-026）或 third-party override（M-059）。

## Task 4: 最终 Tool View 请求接线

**Files:**
- Modify: `src/agent/query-engine.ts`
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/agent/tool-registry.ts`
- Test: `src/__tests__/agent/request-tool-view-integration.test.ts`

**Interfaces:**
- Consumes: `RequestToolViewSnapshot` + Wave A base descriptors。
- Produces: `materializeIncludedToolDefinitions(view, base)`；QueryEngine 只接收最终 definitions。

- [ ] **Step 1: 写最终视图测试**

```ts
it('sends only included tools in canonical order', async () => {
  const client = new CapturingStreamingClient();
  const engine = new QueryEngine(client);
  await drain(engine.submit([], {
    systemPrompt: 'system',
    toolView: viewWith([
      ['read_file', 'included', 0],
      ['write_file', 'excluded', 1],
      ['grep', 'included', 2],
    ]),
    baseToolSnapshot: baseWith(['read_file', 'write_file', 'grep']),
    signal: new AbortController().signal,
  }));
  expect(client.tools.map((tool) => tool.name)).toEqual(['read_file', 'grep']);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/request-tool-view-integration.test.ts
```

- [ ] **Step 3: 实现 materializer**

`materializeIncludedToolDefinitions()` 必须二次校验：

- view/base snapshot IDs；
- included tool 在 base 存在；
- canonical order 未漂移；
- description asset 已在 view 确认；
- 输出新数组，不修改 Registry。

- [ ] **Step 4: 迁移 QueryEngineOptions**

新增结构化路径：

```ts
type QueryEngineOptions =
  | {
      systemPrompt: string;
      toolView: RequestToolViewSnapshot;
      baseToolSnapshot: ToolDefinitionSnapshot;
      signal: AbortSignal;
      maxTokens?: number;
    }
  | {
      systemPrompt: string;
      tools: ToolDefinition[];
      signal: AbortSignal;
      maxTokens?: number;
      legacyToolInput: true;
    };
```

禁止同时提供 `tools` 与 `toolView`。在 `streamingQuery()` 中捕获一次 base/tool view snapshot，并把该快照传给每一轮 `engine.submit()`；同一 Turn 不重新读取 Registry。测试兼容调用可显式使用 `legacyToolInput: true`。

- [ ] **Step 5: 运行回归**

```powershell
npx vitest run src/__tests__/agent/request-tool-view-integration.test.ts src/__tests__/streaming-query.test.ts src/__tests__/agent/tool-registry-ctx.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 Provider adapter 未获得 overlay、capability 或 permission 决策权。

## Task 5: BRC-3 ContextSourceEnvelope 与 Writer 分权

**Files:**
- Create: `src/agent/context/intake.ts`
- Test: `src/__tests__/agent/context-intake.test.ts`

**Interfaces:**
- Consumes: 各类 source metadata。
- Produces: `createContextSourceEnvelope()`、封闭 `ContextWriterKind`。

- [ ] **Step 1: 写非法 writer/source 组合测试**

```ts
it('rejects auto memory written by an instruction loader', () => {
  expect(() => createContextSourceEnvelope({
    ...validEnvelope,
    source_class: 'auto_memory',
    writer_kind: 'trusted_instruction_loader',
  })).toThrow('auto_memory_writer');
});

it('keeps tool results untrusted', () => {
  const envelope = createContextSourceEnvelope({
    ...validEnvelope,
    source_class: 'tool_result',
    writer_kind: 'tool_executor',
    trust: 'trusted',
  });
  expect(envelope.trust).toBe('untrusted');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/context-intake.test.ts
```

- [ ] **Step 3: 实现封闭枚举与合法映射**

按规格 §9.2 实现所有 source class/writer 组合。`createContextSourceEnvelope()`：

- 强制 identity、freshness、provenance；
- tool_result/attachment/external_content 强制 untrusted；
- `raw_content_ref` 只是引用；
- 不读取原文；
- 不决定 final Placement。

- [ ] **Step 4: 补 Authority/Trust 不提升测试**

正文、路径或 source ID 即使包含 `system`、`trusted`、`OVERRIDE`，输出字段也只来自调用方受信 metadata 和固定 policy。

- [ ] **Step 5: 验证**

```powershell
npx vitest run src/__tests__/agent/context-intake.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 attachment 只进入 untrusted envelope，没有实现 Hold M-029/M-041。

## Task 6: M-039 Environment Normalization

**Files:**
- Create: `src/agent/context/intake/environment.ts`
- Test: `src/__tests__/agent/environment-normalization.test.ts`

**Interfaces:**
- Consumes: 显式采集值与 allowlist policy，不直接接收完整 `process.env`。
- Produces: `normalizeEnvironmentSnapshot(input, policy)`。

- [ ] **Step 1: 写 allowlist 与 unknown 测试**

```ts
it('omits unknown and non-allowlisted fields', () => {
  const snapshot = normalizeEnvironmentSnapshot({
    environment_snapshot_id: 'env-1',
    platform_family: 'windows',
    shell_family: null,
    workspace_root: 'D:\\repo',
    working_directory: 'D:\\repo\\src',
    repository_present: true,
    observed_at: '2026-07-26T00:00:00.000Z',
    collected_fields: {
      terminal_columns: 120,
      API_KEY: 'secret',
    },
  }, {
    allowed_fields: new Set(['terminal_columns']),
    privacy_omitted_fields: new Set(),
  });
  expect(snapshot.allowed_fields).toEqual({ terminal_columns: 120 });
  expect(snapshot.omitted_field_codes).toContain('field.not_allowlisted.API_KEY');
  expect(JSON.stringify(snapshot)).not.toContain('secret');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/environment-normalization.test.ts
```

- [ ] **Step 3: 实现 NormalizedEnvironmentSnapshot**

路径先 `resolve/normalize`，平台和 shell 使用明确 collector 输出。未知字段省略并记录 code；privacy policy 只能删除。

- [ ] **Step 4: 实现确定性环境 section formatter**

在 `environment.ts` 提供：

```ts
formatNormalizedEnvironment(snapshot: NormalizedEnvironmentSnapshot): string
```

它只格式化 `allowed_fields` 和固定核心字段，不读取 `process.cwd/process.platform/process.env`。Task 9 负责把该 formatter 接入子 Agent。

- [ ] **Step 5: 运行回归**

```powershell
npx vitest run src/__tests__/agent/environment-normalization.test.ts src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 parent environment 未被复制到 Prompt，resume freshness 只记录 requirement，重验证由后续生命周期接线。

## Task 7: M-040 Deterministic Context Sanitization

**Files:**
- Create: `src/agent/context/intake/sanitizer.ts`
- Test: `src/__tests__/agent/context-sanitizer.test.ts`

**Interfaces:**
- Consumes: `ContextSourceEnvelope`、受控 content resolver、deterministic policy。
- Produces: `sanitizeContextSource(): ContextSanitizationResult`。

- [ ] **Step 1: 写 secret 与异常 fail-closed 测试**

```ts
it('rejects on sanitizer failure without returning raw content', async () => {
  const result = await sanitizeContextSource(envelope, {
    policy_id: 'ingress-1',
    policy_version: '1',
    readContent: async () => 'token=secret-value',
    inspect: () => { throw new Error('scanner unavailable'); },
  });
  expect(result).toMatchObject({
    status: 'rejected',
    sanitized_content_ref: null,
  });
  expect(JSON.stringify(result)).not.toContain('secret-value');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/context-sanitizer.test.ts
```

- [ ] **Step 3: 实现 result 与确定性 policy**

finding 只记录 code 和 location ref；允许的 transformation 必须由 policy 明确返回。模型输出不能作为 inspector。

- [ ] **Step 4: 实现 trusted extraction 边界**

sanitizer 只能产生 sanitized untrusted content ref。受信结构化数据必须通过独立 API：

```ts
extractTrustedStructure(
  source: ContextSourceEnvelope,
  gate: {
    trusted_source_policy: boolean;
    schema_valid: boolean;
    deterministic_loader: boolean;
  },
): TrustedStructuredContext
```

三项必须全部为 true，且原 envelope trust 不改变。

- [ ] **Step 5: 验证**

```powershell
npx vitest run src/__tests__/agent/context-sanitizer.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认没有 Prompt injection 模型软告警（M-069）和最终 trusted routing（M-012）。

## Task 8: M-050/M-011 Source Budget、Provenance 与 Intake Pipeline

**Files:**
- Create: `src/agent/context/intake/source-budget.ts`
- Create: `src/agent/context/intake/provenance.ts`
- Modify: `src/agent/context/intake.ts`
- Test: `src/__tests__/agent/bounded-context-source.test.ts`

**Interfaces:**
- Consumes: envelope + sanitization result + per-source policy。
- Produces: `buildBoundedContextSource()`、`runContextIntake()`。

- [ ] **Step 1: 写显式 overflow RED 测试**

```ts
it('truncates only at deterministic line boundaries and emits overflow metadata', () => {
  const result = buildBoundedContextSource({
    envelope,
    sanitization: acceptedRef('content-1'),
    content: 'one\ntwo\nthree\n',
    policy: {
      source_class: 'instruction_candidate',
      max_bytes: 8,
      max_lines: 2,
      overflow_behavior: 'deterministic_truncate',
      policy_id: 'source-budget',
      policy_version: '1',
    },
  });
  expect(result.truncated).toBe(true);
  expect(result.lines_included).toBe(2);
  expect(result.overflow_ref).not.toBeNull();
  expect(result.provenance_label).toContain('instruction_candidate');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-context-source.test.ts
```

- [ ] **Step 3: 实现 source-specific budget**

精确实现 `SourceBudgetPolicy`、`BoundedContextSource`。字节按 UTF-8 `Buffer.byteLength()` 计算；截断只在完整 line 或 source policy 明确的完整 record 边界。

- [ ] **Step 4: 实现 provenance formatter**

label 只从 envelope metadata 产生，安全显示路径失败时保留 source ID 并省略路径。正文里的来源声明不能进入 label。

- [ ] **Step 5: 实现固定 intake 顺序**

```ts
export async function runContextIntake(
  envelope: ContextSourceEnvelope,
  dependencies: ContextIntakeDependencies,
): Promise<BoundedContextSource>
```

严格执行：

```text
identity → normalization → sanitization → writer separation
→ source budget → provenance → bounded output
```

缺 policy、sanitizer rejected 或 overflow metadata 缺失均拒绝，不返回无限预算内容。

- [ ] **Step 6: 运行 BRC-3 suite**

```powershell
npx vitest run src/__tests__/agent/context-intake.test.ts src/__tests__/agent/environment-normalization.test.ts src/__tests__/agent/context-sanitizer.test.ts src/__tests__/agent/bounded-context-source.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 bounded source 未自动注入 Prompt，Claude 的任何数值未成为默认预算。

## Task 9: M-014/M-035 Agent Role 与 Task Profile

**Files:**
- Create: `src/agent/prompt/profiles.ts`
- Modify: `src/agent/roles.ts`
- Modify: `src/agent/subagent.ts`
- Test: `src/__tests__/agent/agent-prompt-profiles.test.ts`
- Test: `src/__tests__/role-agents.test.ts`

**Interfaces:**
- Consumes: approved asset lookup、capability snapshot、Task 3 tool view 请求、Wave A Completion protocol。
- Produces: `composeAgentPromptProfile()`。

- [ ] **Step 1: 写 profile 不授予工具测试**

```ts
it('reports a requested tool excluded by the final tool view', () => {
  const result = composeAgentPromptProfile({
    profile_protocol_version: '1',
    profile_snapshot_id: 'profile-1',
    role,
    task: null,
    capability,
    finalToolView: viewExcluding('run_bash'),
    approvedAsset: () => true,
  });
  expect(result.snapshot.requested_tool_ids).toContain('run_bash');
  expect(result.actual_tool_ids).not.toContain('run_bash');
  expect(result.diagnostic_codes).toContain('profile.tool_excluded.run_bash');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/agent-prompt-profiles.test.ts
```

- [ ] **Step 3: 实现 Role/Task/Profile 类型**

精确实现规格 §10.2～§10.4。Role version、template version、profile protocol version 分字段。

- [ ] **Step 4: 实现组合规则**

- 两类 asset 必须 approved；
- required capability 全部 supported；
- no-tool requirement 只记录请求，不当 enforcement；
- output schema 必须与 CompletionReport protocol 兼容；
- profile 深冻结；
- child output 标记 provenance，默认 untrusted。

- [ ] **Step 5: 迁移现有 ROLE_REGISTRY**

只迁移现有 `explore/plan/general`，不添加 Claude Prompt 库中的角色。旧 `RoleConfig` 通过 adapter 生成 `AgentRoleProfile`；工具过滤改为消费实际 `RequestToolViewSnapshot`。

同时把 `enhanceSubagentSystemPrompt()` 改为消费 Task 6 的 `NormalizedEnvironmentSnapshot` 和 `formatNormalizedEnvironment()`，禁止该函数直接读取 `process.env`。现有三个 role prompt 分别登记为 `source.kind='mi-code'` 的治理资产，evidence refs 指向现有 role/subagent 回归测试；不得借迁移批准新的 Prompt Library 资产。

- [ ] **Step 6: 运行回归**

```powershell
npx vitest run src/__tests__/agent/agent-prompt-profiles.test.ts src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 profile 没有执行 permission check，也没有把 verification role 的结论直接变成 completed。

## Task 10: M-070 Tool Transcript Validator

**Files:**
- Create: `src/agent/tools/transcript-validator.ts`
- Test: `src/__tests__/agent/tool-transcript-validator.test.ts`

**Interfaces:**
- Consumes: immutable transcript snapshot、checkpoint、validator policy identity、可选 execution journal facts。
- Produces: `validateToolTranscript(): ToolTranscriptValidation`。

- [ ] **Step 1: 写 pairing 状态 RED 测试**

```ts
it.each([
  ['paired', transcript(use('c1'), result('c1')), 'accepted'],
  ['missing_result', transcript(use('c1')), 'rejected'],
  ['orphan_result', transcript(result('c1')), 'rejected'],
  ['duplicate_result', transcript(use('c1'), result('c1'), result('c1')), 'rejected'],
])('classifies %s deterministically', (_name, snapshot, status) => {
  const validation = validateToolTranscript(snapshot, {
    checkpoint: 'before_provider_send',
    validator_policy_id: 'pairing',
    validator_policy_version: '1',
  });
  expect(validation.status).toBe(status);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/tool-transcript-validator.test.ts
```

- [ ] **Step 3: 实现状态与四个 checkpoint**

精确实现 `ToolPairState`、`ToolPairRecord`、`ToolTranscriptValidation`。validator 扫描内部 Message/ContentBlock：

- use ID session 内唯一；
- result 引用存在 use；
- 每个 use 最多一个 final result；
- progress/receipt/text 不计 result；
- pending execution 仅由 journal 的确定性 executing fact 建立。

- [ ] **Step 4: 实现 deterministic validation ID**

validation ID 由以下字段 hash：

```text
transcript_snapshot_id
checkpoint
validator_policy_id
validator_policy_version
canonical pair records
canonical reason codes
```

同一输入重复调用深相等。新 result 必须先形成新 transcript snapshot。

- [ ] **Step 5: 验证**

```powershell
npx vitest run src/__tests__/agent/tool-transcript-validator.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 validator 不生成 result、不读取 summary 判断已完成、不决定 partial/failed。

## Task 11: M-070 四检查点接线

**Files:**
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/agent/compression.ts`
- Modify: `src/session/store.ts`
- Create: `src/__tests__/agent/tool-transcript-checkpoints.test.ts`
- Test: `src/__tests__/streaming-query.test.ts`
- Test: `src/__tests__/compression.test.ts`
- Test: `src/__tests__/session/session-store.test.ts`

**Interfaces:**
- Consumes: Task 10 validator。
- Produces: `assertTranscriptCheckpoint(snapshot, checkpoint)` 在 send/persist/compact/finalize 前强制执行。

- [ ] **Step 1: 写四检查点 spy 测试**

```ts
it.each([
  'before_provider_send',
  'before_persistence',
  'before_compaction',
  'before_finalization',
] as const)('blocks lifecycle at %s when transcript is incomplete', async (checkpoint) => {
  const harness = createLifecycleHarness({ transcript: transcript(use('c1')) });
  await expect(harness.runUntil(checkpoint)).rejects.toMatchObject({
    code: 'tool_transcript.invalid',
    checkpoint,
  });
  expect(harness.providerCallsAfter(checkpoint)).toBe(0);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/tool-transcript-checkpoints.test.ts
```

- [ ] **Step 3: 接入 next Provider send**

在每次 `engine.submit()` 前从当前 messages 构建 immutable transcript snapshot 并执行 `before_provider_send`。`blocked` 等待真实 result；`rejected` 走 protocol failure。

- [ ] **Step 4: 接入 persistence**

`SessionStore` 增加 `appendValidatedTranscript()`，只接受 accepted `before_persistence` validation。不得把不完整 transcript 序列化为看似 paired。

- [ ] **Step 5: 接入 compaction 与 finalization**

`runCompaction()` 前要求 accepted `before_compaction`；end_turn/final report 前要求 accepted `before_finalization`。不要在 Wave B 实现 no-tools compaction（M-031）。

- [ ] **Step 6: 删除占位 result 兼容**

搜索并移除只为补齐缺失 pairing 而创建的 synthetic result。真实 executor failure 仍可产生匹配 call ID 的失败 result。

- [ ] **Step 7: 运行回归**

```powershell
npx vitest run src/__tests__/agent/tool-transcript-checkpoints.test.ts src/__tests__/streaming-query.test.ts src/__tests__/compression.test.ts src/__tests__/session/session-store.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 BRC-5 未被误接成 Wave C D-edge，且 pairing failure 不直接决定 Outcome。

## Task 12: M-063 Child-Process Environment Scrubbing

**Files:**
- Create: `src/permission/child-environment.ts`
- Modify: `src/agent/tool-registry.ts`
- Modify: `src/background/background-manager.ts`
- Test: `src/__tests__/permission/child-environment.test.ts`
- Test: `src/__tests__/regression/child-process-env-scrub.test.ts`

**Interfaces:**
- Consumes: Wave A SecurityDecision、launcher-specific policy、required variable names。
- Produces: `decideChildProcessEnvironment()`、sanitized env passed to spawn。

- [ ] **Step 1: 写 secret 不继承 RED 测试**

```ts
it('passes only explicitly allowed environment variables to spawn', () => {
  const result = decideChildProcessEnvironment({
    launch_snapshot_id: 'launch-1',
    launcher_kind: 'shell_tool',
    executable_ref: 'cmd',
    parent_environment: { PATH: 'safe-path', API_KEY: 'secret', TEMP: 'temp' },
    required_variable_names: ['PATH'],
    environment_policy_id: 'shell-env',
    environment_policy_version: '1',
  }, policyAllowing(['PATH', 'TEMP']));
  expect(result.environment).toEqual({ PATH: 'safe-path', TEMP: 'temp' });
  expect(result.decision.removed_variable_names).toContain('API_KEY');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/child-environment.test.ts
```

- [ ] **Step 3: 实现决策协议**

精确实现 `ChildProcessEnvironmentInput/Decision`。policy 缺失、scrubber 异常、required var 缺失或 unknown 均返回 deny；日志只允许变量名/reason code。

初始 launcher policy 必须显式版本化，且以现有 Node shell 启动所需最小集合为起点：

```text
shell_tool/windows:
  required: PATH, SystemRoot, ComSpec
  optional: PATHEXT, TEMP, TMP

shell_tool/unix:
  required: PATH
  optional: HOME, TMPDIR, SHELL, LANG, LC_ALL

background/windows:
  required: PATH, SystemRoot, ComSpec
  optional: PATHEXT, TEMP, TMP

background/unix:
  required: PATH
  optional: HOME, TMPDIR, SHELL, LANG, LC_ALL
```

名称匹配 `*_API_KEY`、`*_TOKEN`、`*_SECRET`、`PASSWORD`、`AWS_*`、`AZURE_*`、`GOOGLE_APPLICATION_CREDENTIALS` 的变量默认移除。执行者必须用 Windows/Unix fixture 证明 required 集合足够；如果真实 launcher 需要新增变量，先以失败测试证明，再更新 policy version。

- [ ] **Step 4: 接入两个 spawn 入口**

`createBashTool()` 与 `BackgroundManager.run()` 都必须显式传：

```ts
spawn(command, args, {
  ...existingOptions,
  env: sanitizedEnvironment,
});
```

禁止省略 `env` 继续隐式继承 parent environment。

- [ ] **Step 5: 运行回归**

```powershell
npx vitest run src/__tests__/permission/child-environment.test.ts src/__tests__/regression/child-process-env-scrub.test.ts src/__tests__/background.test.ts src/__tests__/tools.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认没有解析 inline assignment（M-065）或照搬 Claude 环境变量列表。

## Task 13: M-066 Persisted Blocking Ask

**Files:**
- Create: `src/permission/runtime-gate.ts`
- Modify: `src/agent/streaming-executor.ts`
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/session/store.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/permission/runtime-gate.test.ts`
- Test: `src/__tests__/regression/streaming-permission-passthrough.test.ts`
- Test: `src/__tests__/plan-mode-streaming.test.ts`

**Interfaces:**
- Consumes: Wave A `SecurityDecision/UserDecision`、`ActionProvenance`、UI decision channel。
- Produces: `RuntimeSecurityGate.authorize(action): Promise<AuthorizedAction | DeniedAction>`。

- [ ] **Step 1: 写 executor 调用次数为零的 RED 测试**

```ts
it('does not call the executor before matching approved_once', async () => {
  const executor = vi.fn(async () => 'done');
  const pendingStore = new InMemoryPendingDecisionStore();
  const channel = new DeferredUserDecisionChannel();
  const gate = new RuntimeSecurityGate({ pendingStore, channel });

  const promise = gate.execute(askDecision('decision-1', 'action-1'), executor);
  await Promise.resolve();
  expect(executor).not.toHaveBeenCalled();

  channel.resolve({
    protocol_version: '1',
    decision_id: 'decision-1',
    response: 'approved_once',
    decided_at: '2026-07-26T00:00:00.000Z',
  });
  await expect(promise).resolves.toBe('done');
  expect(executor).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/runtime-gate.test.ts src/__tests__/regression/streaming-permission-passthrough.test.ts
```

Expected: 当前 ask 继续执行测试暴露违规。

- [ ] **Step 3: 实现 pending 状态机**

精确实现 `ActionProvenance`、`PendingSecurityDecision`。合法转换：

```text
awaiting_user → approved_once
awaiting_user → rejected
awaiting_user → expired
```

终态不可变；UserDecision 必须匹配 decision ID 和 action snapshot。

- [ ] **Step 4: 实现持久化 adapter**

`SessionStore` 使用独立 record kind 保存 pending decision，不塞进 Provider-visible Message。resume 读取 pending 后重新验证 action snapshot；变化则旧批准失效。

存储使用独立 sidecar：

```text
~/.micode/sessions/<session-id>.pending-decisions.jsonl
```

`load()`/`loadSync()` 继续只读取 `<session-id>.jsonl` 的 Provider-visible messages，二者不得混写。

- [ ] **Step 5: 接入 UI channel**

复用 AskUserManager 的 UI transport，但使用独立 permission request/result schema；不能伪装成 `ask_user_question` tool result。无 UI/transport 时将 ask 转为结构化 deny。

- [ ] **Step 6: 串行接入两条执行路径**

`StreamingToolExecutor.executeTool()` 与传统 `streamingQuery` 分支统一调用 RuntimeSecurityGate。删除“ask 放行”逻辑和注释。`approved_once` 消费后不能重放。

- [ ] **Step 7: 增加跨机器/unknown provenance 测试**

```text
cross_machine + classifier allow → ask
unknown provenance               → ask or deny, never allow
ask channel unavailable          → deny
stale UserDecision ID            → deny
changed action snapshot          → old approval invalid
resume pending unchanged action  → awaiting_user restored
```

- [ ] **Step 8: 运行 V3 路径**

```powershell
npx vitest run src/__tests__/permission/runtime-gate.test.ts src/__tests__/regression/streaming-permission-passthrough.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/ask-user.test.ts src/__tests__/session/session-store.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认 `ask` 不产生 tool result 占位、不写永久 allow rule、不因通道失败继续执行。

## Task 14: M-051 Observability Plane Envelopes

**Files:**
- Create: `src/agent/observability/envelopes.ts`
- Modify: `src/agent/stream-event-bus.ts`
- Test: `src/__tests__/agent/observability-envelopes.test.ts`

**Interfaces:**
- Consumes: component metadata，不消费原始 Prompt/user/tool payload。
- Produces: `createObservabilityEnvelope()`、`canEnterPlane()`、event bus metadata event。

- [ ] **Step 1: 写 production/full-dump 默认关闭测试**

```ts
it.each([
  ['production_telemetry', 'pending'],
  ['production_telemetry', 'dropped'],
  ['full_request_dump', 'not_required'],
] as const)('does not create a sendable %s event with %s redaction', (plane, redaction) => {
  const result = createObservabilityEnvelope({
    ...baseEvent,
    plane,
    redaction_state: redaction,
  }, disabledPolicies);
  expect(result.status).toBe('dropped');
  expect(result.envelope.payload_ref).toBeNull();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/observability-envelopes.test.ts
```

- [ ] **Step 3: 实现 plane/envelope**

精确实现规格 §13.2。准入规则：

```text
local_debug         → explicit local policy
full_request_dump   → disabled in Wave B
decision_trace      → envelope only, no payload schema
production_telemetry→ disabled until M-056
unknown plane       → drop
unknown sensitivity → drop for production
pending/failed redaction → drop
```

- [ ] **Step 4: 接入 StreamEventBus metadata channel**

新增 `emitObservabilityEvent()`，只接收已构建 envelope。不得在 bus 内自动抓取 Prompt、message、tool output 或 hidden reasoning。

- [ ] **Step 5: 测试 sink failure 独立性**

listener 抛错或 serialization failure 不改变 `SecurityDecision`、`CompletionReport` 或 streaming Outcome；只增加最小本地 error counter。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/observability-envelopes.test.ts src/__tests__/streaming-query.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认未实现 M-054/M-056/M-052/M-055，未创建正文 payload。

## Task 15: Wave B 公共出口与 INV-B1～B13 验收

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/permission/index.ts`
- Create: `src/__tests__/agent/wave-b-contracts.test.ts`
- Create: `logs/agent-mechanisms-wave-b-verification.md`

**Interfaces:**
- Consumes: Task 1～14。
- Produces: Wave C 稳定 imports、13 条不变量证据。

- [ ] **Step 1: 写公共出口 RED**

```ts
import {
  compilePromptSnapshot,
  createModelCapabilitySnapshot,
  deriveRequestToolView,
  runContextIntake,
  composeAgentPromptProfile,
  validateToolTranscript,
  createObservabilityEnvelope,
} from '../../agent/index.js';
import {
  decideChildProcessEnvironment,
  RuntimeSecurityGate,
} from '../../permission/index.js';

it('exports all Wave B anchors', () => {
  for (const anchor of [
    compilePromptSnapshot,
    createModelCapabilitySnapshot,
    deriveRequestToolView,
    runContextIntake,
    composeAgentPromptProfile,
    validateToolTranscript,
    createObservabilityEnvelope,
    decideChildProcessEnvironment,
    RuntimeSecurityGate,
  ]) expect(anchor).toBeDefined();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/wave-b-contracts.test.ts
```

- [ ] **Step 3: 增加显式公共导出**

只导出 Contract interface、builder、validator、runtime gate；不导出 legacy adapter、测试 factory 或内部 hash helper。

- [ ] **Step 4: 建立 13 条不变量测试名**

```text
INV-B1 snapshots do not absorb mutable state
INV-B2 identities remain in distinct fields
INV-B3 provider adapters only encode semantics
INV-B4 trust never rises from agent text
INV-B5 runtime decisions override prompt text
INV-B6 unknown uses safe defaults
INV-B7 ask blocks before execution
INV-B8 pairing precedes lifecycle checkpoints
INV-B9 source budget overflow is explicit
INV-B10 profile requests but does not grant tools
INV-B11 observability plane is not collection permission
INV-B12 protocol versions are orthogonal
INV-B13 failures never become successful states
```

- [ ] **Step 5: 运行 Wave B targeted suite**

```powershell
npx vitest run src/__tests__/agent/prompt-compiler.test.ts src/__tests__/agent/capability-snapshot.test.ts src/__tests__/agent/tool-view-overlay.test.ts src/__tests__/agent/request-tool-view-integration.test.ts src/__tests__/agent/context-intake.test.ts src/__tests__/agent/environment-normalization.test.ts src/__tests__/agent/context-sanitizer.test.ts src/__tests__/agent/bounded-context-source.test.ts src/__tests__/agent/agent-prompt-profiles.test.ts src/__tests__/agent/tool-transcript-validator.test.ts src/__tests__/agent/tool-transcript-checkpoints.test.ts src/__tests__/permission/child-environment.test.ts src/__tests__/permission/runtime-gate.test.ts src/__tests__/agent/observability-envelopes.test.ts src/__tests__/agent/wave-b-contracts.test.ts
```

- [ ] **Step 6: 运行受影响回归**

```powershell
npx vitest run src/__tests__/streaming-query.test.ts src/__tests__/streaming-executor.test.ts src/__tests__/compression.test.ts src/__tests__/session/session-store.test.ts src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/permission.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/background.test.ts src/__tests__/regression/
```

- [ ] **Step 7: 静态与构建验证**

```powershell
npm run typecheck
npm run lint
npm run build
```

- [ ] **Step 8: Wave Gate 全量验证**

```powershell
npm test
```

- [ ] **Step 9: 写验证日志**

```markdown
# Wave B Verification

- changed: [实际文件]
- mechanisms: M-001, M-011, M-014, M-020, M-024, M-035, M-039, M-040, M-042, M-050, M-051, M-058, M-063, M-066, M-070
- verification_level: V3
- red_evidence: [命令与失败原因]
- green_evidence: [命令与通过计数]
- invariant_evidence: INV-B1 through INV-B13
- activation_evidence:
  - blocking ask
  - four transcript checkpoints
  - child environment scrub
- remaining_uncertainty: [仅列真实未验证项]
- deferred_hold_check: no Deferred or Hold implementation activated
```

- [ ] **Step 10: Review checkpoint**

逐条对照 Wave B §18 验收矩阵、§19 完成标准和 §16 Wave C handoff。任一项缺少 runtime assertion 或测试时，不进入 Wave C。

## 3. Wave C Handoff

Wave B 通过后，Wave C 可以依赖：

- stable Prompt section identity/order/hash 与 CompiledPromptSnapshot；
- supported/unsupported/unknown capability snapshot；
- immutable base→request tool view；
- ContextSourceEnvelope、normalized environment、sanitization、writer separation、source budget/provenance；
- role/task/profile identity 与 requested/actual tool 分离；
- deterministic transcript validation；
- child environment scrub、action provenance、persisted blocking ask；
- observability plane/envelope 与默认禁用 gate。

Wave C 不能假设：

- 当前 section 顺序就是 precedence；
- system_static 已产生 cache 收益；
- third-party capability override 已可信；
- bounded Context 已 trusted 或已决定 Placement；
- auto memory 已 admitted；
- tool description 是 enforcement；
- no-tools Prompt 文本能阻止执行；
- child output trusted；
- injection soft signal 能改变权限；
- production telemetry/full dump 已启用。

BRC-5 没有 Wave C 直接 D-edge；Wave C 只能遵守全局 transcript 不变量。

## 4. 完成标准

1. 15 个机制均有且只有一个主 Task。
2. 7 个 BRC 均有公开 anchor 和错误语义测试。
3. INV-B1～B13 均有机器可判定证据。
4. `streaming-query.ts` 的 Task 11 与 Task 13 串行完成。
5. 所有 Provider 请求只使用最终 included tool view。
6. Context intake 不自动注入、不提升 trust。
7. Role/profile 不授予工具或 permission。
8. 四个 transcript checkpoint 均 fail closed。
9. ask 在 matching UserDecision 前 executor 调用次数为零。
10. child spawn 显式使用 sanitized env。
11. production telemetry/full dump 保持关闭。
12. targeted、affected regression、typecheck、lint、build、full test 有新鲜证据。
13. 没有实现任何 Deferred/Hold。
14. 未执行部署、依赖升级、数据库迁移或 Git 历史写操作。
