# Task 9 Classifier Production Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `projectClassifierConfigSources` + `loadStaticClassifierProviderMetadata` into the production runtime path via a testable composition seam, with real `userSettings` from config and correct `staticallySelectableModels` from provider model declarations.

**Architecture:** Extract `createConfiguredExecutionRuntimeForTurn` as a production composition seam in `authority-gate.ts`. It receives real `ClassifierConfigSourcesInput` (userSettings from config), provider metadata, and provider-declared model IDs, then calls `projectClassifierConfigSources` + `loadStaticClassifierProviderMetadata` to build `ClassifierModelContext` with `staticallySelectableModels` from provider declarations only. `index.ts` calls this seam exclusively. `createResolver` no longer has a hardcoded fallback — enforced/shadow missing `classifierModelContext` throws.

**Tech Stack:** TypeScript ESM, Vitest, Node 18+.

**Base commit:** `c97ba87` (current HEAD of `feat/auto-permission-prerequisite`). This plan fixes/amends `c97ba87`.

**TDD phase expectations:**

| Test group | After Task 1 (RED) | After Task 2 (seam + fallback removal + existing test updates) | After Task 3 (index.ts wiring) |
|---|---|---|---|
| Group 1 (composition seam) | FAIL (seam doesn't exist) | **PASS** | PASS |
| Group 2 (staticallySelectableModels) | FAIL (seam doesn't exist) | **PASS** | PASS |
| Group 3 (fail-closed) | FAIL (fallback still exists) | **PASS** | PASS |
| Group 4 (index.ts wiring contract) | FAIL (seam doesn't exist) | **FAIL** (index.ts not updated yet) | **PASS** |

Tests GREENing early is correct — they're satisfied by the seam implementation. Only Group 4 requires index.ts wiring.

---

### Task 1: RED — composition seam + fail-closed contract tests

**Files:**
- Create: `src/__tests__/permission/classifier-production-wiring.test.ts`

- [ ] **Step 1: Write the RED test file**

```ts
// Task 9 production wiring: composition seam + fail-closed contracts.
// Tests prove config reaches classifier via the real production path.
import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createConfiguredExecutionRuntimeForTurn,
  createExecutionRuntimeForTurn,
  type TurnRuntimeDeps,
} from '../../permission/authority-gate.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate, type PendingDecisionStore, type PendingSecurityDecision } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { SessionState } from '../../permission/session-state.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { executeToolCall } from '../../agent/tool-execution.js';
import type { StreamingLLMClient, StreamEvent, AssistantMessage } from '../../agent/types.js';
import type { ClassifierConfigSourcesInput } from '../../config/permission-sources.js';

// ─── shared helpers ───

class RecordingStreamClient implements StreamingLLMClient {
  calls: Array<{ model: { providerId: string; modelId: string }; systemPrompt: string; prompt: string }> = [];
  constructor(private readonly stage1: string, private readonly stage2: string = 'DENY') {}
  async completeText(req: {
    readonly model: { readonly providerId: string; readonly modelId: string };
    readonly systemPrompt?: string;
    readonly prompt?: string;
  }): Promise<string> {
    this.calls.push({
      model: req.model,
      systemPrompt: req.systemPrompt ?? '',
      prompt: req.prompt ?? '',
    });
    return this.calls.length === 1 ? this.stage1 : this.stage2;
  }
  async *stream(): AsyncGenerator<StreamEvent | AssistantMessage> {
    yield { type: 'message_start', messageId: 'm', model: 'f', inputTokens: 1 };
    yield { type: 'message_stop' };
  }
}
class FakeStore implements PendingDecisionStore {
  async save(): Promise<void> {}
  async load(): Promise<readonly PendingSecurityDecision[]> { return []; }
  async update(): Promise<void> {}
}
function bashRegistry(executor: ReturnType<typeof vi.fn>) {
  const r = new ToolRegistry();
  r.register(
    { name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
    executor,
  );
  return r;
}

interface SeamOverrides {
  readonly authority?: 'enforced' | 'shadow' | 'legacy';
  readonly streamClient?: StreamingLLMClient;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly providerConfig?: { fastClassifierModel?: string; classifierCapabilities?: Record<string, unknown> };
  readonly providerModelIds?: readonly string[];
  readonly classifierConfigSources?: ClassifierConfigSourcesInput;
}
function makeSeamInput(overrides: SeamOverrides = {}) {
  return {
    authority: 'enforced' as const,
    streamClient: new RecordingStreamClient('ALLOW'),
    providerId: 'test',
    modelId: 'main-model',
    providerConfig: undefined as { fastClassifierModel?: string; classifierCapabilities?: Record<string, unknown> } | undefined,
    providerModelIds: ['main-model'],
    classifierConfigSources: {} as ClassifierConfigSourcesInput,
    permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
    runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
    sessionAllowlist: new SessionAllowlist(),
    sessionState: new SessionState(new SessionAllowlist(), 's1'),
    hooks: [] as never[],
    ...overrides,
  };
}

async function triggerClassifier(
  runtime: ReturnType<typeof createConfiguredExecutionRuntimeForTurn>,
  sc: RecordingStreamClient,
) {
  await executeToolCall(
    bashRegistry(vi.fn().mockResolvedValue('ok')),
    { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } },
    runtime,
    { messages: [{ role: 'user', content: 'run echo', authoredByUser: true }] },
  );
  return sc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 1: composition seam — userSettings rules + model reach classifier
// ═══════════════════════════════════════════════════════════════════════════════

describe('[task9-wiring] composition seam', () => {
  test('userSettings rules reach classifier via real resolver/classifier path', async () => {
    const sc = new RecordingStreamClient('ALLOW');
    const runtime = createConfiguredExecutionRuntimeForTurn(makeSeamInput({
      streamClient: sc,
      classifierConfigSources: {
        userSettings: { rules: ['CUSTOM_RULE: deny writes to /prod'] },
      },
    }));
    await triggerClassifier(runtime, sc);
    expect(sc.calls.length).toBeGreaterThanOrEqual(1);
    const allText = sc.calls[0].systemPrompt + sc.calls[0].prompt;
    expect(allText).toContain('CUSTOM_RULE: deny writes to /prod');
  });

  test('userSettings classifierModel is the model selected by classifier', async () => {
    const sc = new RecordingStreamClient('ALLOW');
    const runtime = createConfiguredExecutionRuntimeForTurn(makeSeamInput({
      streamClient: sc,
      providerModelIds: ['main-model', 'classifier-special'],
      classifierConfigSources: {
        userSettings: { classifierModel: 'classifier-special' },
      },
    }));
    await triggerClassifier(runtime, sc);
    // Verify the model actually selected is classifier-special (not main-model)
    expect(sc.calls.length).toBeGreaterThanOrEqual(1);
    expect(sc.calls[0].model.modelId).toBe('classifier-special');
  });

  test('provider fastClassifierModel is used when no explicit classifierModel', async () => {
    const sc = new RecordingStreamClient('ALLOW');
    const runtime = createConfiguredExecutionRuntimeForTurn(makeSeamInput({
      streamClient: sc,
      providerConfig: { fastClassifierModel: 'fast-model' },
      providerModelIds: ['main-model', 'fast-model'],
    }));
    await triggerClassifier(runtime, sc);
    // fastClassifierModel is advisory: if selectable, it's used; otherwise session main
    expect(sc.calls.length).toBeGreaterThanOrEqual(1);
    expect(sc.calls[0].model.modelId).toBe('fast-model');
  });

  test('session main model used when no classifierModel and no fastClassifierModel', async () => {
    const sc = new RecordingStreamClient('ALLOW');
    const runtime = createConfiguredExecutionRuntimeForTurn(makeSeamInput({
      streamClient: sc,
      providerModelIds: ['main-model'],
    }));
    await triggerClassifier(runtime, sc);
    expect(sc.calls.length).toBeGreaterThanOrEqual(1);
    expect(sc.calls[0].model.modelId).toBe('main-model');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 2: staticallySelectableModels correctness — fail-closed at classifier execution
// ClassifierModelUnavailableError is thrown by selectStage1() during classifier.classify(),
// NOT during runtime construction. Must trigger via executeToolCall.
// ═══════════════════════════════════════════════════════════════════════════════

describe('[task9-wiring] staticallySelectableModels', () => {
  test('classifierModel not in provider declarations → classifier deny (fail-closed via ClassifierModelUnavailableError)', async () => {
    const sc = new RecordingStreamClient('ALLOW');
    const runtime = createConfiguredExecutionRuntimeForTurn(makeSeamInput({
      streamClient: sc,
      providerModelIds: ['main-model'],  // does NOT contain 'unknown-model'
      classifierConfigSources: {
        userSettings: { classifierModel: 'unknown-model' },
      },
    }));
    const executor = vi.fn();
    const result = await executeToolCall(
      bashRegistry(executor),
      { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } },
      runtime,
      { messages: [{ role: 'user', content: 'run echo', authoredByUser: true }] },
    );
    // ClassifierModelUnavailableError → classifier catch → deny → permission failure
    expect(result.status).toBe('failure');
    expect(executor).not.toHaveBeenCalled();
    // Provider was NOT called (error before RPC)
    expect(sc.calls.length).toBe(0);
  });

  test('classifierModel in provider declarations → classifier invoked normally', async () => {
    const sc = new RecordingStreamClient('ALLOW');
    const runtime = createConfiguredExecutionRuntimeForTurn(makeSeamInput({
      streamClient: sc,
      providerModelIds: ['main-model', 'claude-haiku'],
      classifierConfigSources: {
        userSettings: { classifierModel: 'claude-haiku' },
      },
    }));
    await triggerClassifier(runtime, sc);
    expect(sc.calls.length).toBeGreaterThanOrEqual(1);
    expect(sc.calls[0].model.modelId).toBe('claude-haiku');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 3: fail-closed — no hardcoded fallback for enforced/shadow
// ═══════════════════════════════════════════════════════════════════════════════

describe('[task9-wiring] fail-closed contracts', () => {
  test('enforced without classifierModelContext → throws at construction', () => {
    const deps: TurnRuntimeDeps = {
      authority: 'enforced',
      streamClient: new RecordingStreamClient('ALLOW'),
      providerId: 'test', modelId: 'main',
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
    };
    expect(() => createExecutionRuntimeForTurn(deps)).toThrow();
  });

  test('shadow without classifierModelContext → throws at construction', () => {
    const deps: TurnRuntimeDeps = {
      authority: 'shadow',
      streamClient: new RecordingStreamClient('ALLOW'),
      providerId: 'test', modelId: 'main',
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
    };
    expect(() => createExecutionRuntimeForTurn(deps)).toThrow();
  });

  test('legacy without classifierModelContext → no throw', () => {
    const deps: TurnRuntimeDeps = {
      authority: 'legacy',
      streamClient: new RecordingStreamClient('ALLOW'),
      providerId: 'test', modelId: 'main',
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
    };
    expect(() => createExecutionRuntimeForTurn(deps)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP 4: index.ts wiring contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('[task9-wiring] index.ts wiring contract', () => {
  test('index.ts imports and calls createConfiguredExecutionRuntimeForTurn', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf-8');
    expect(source).toContain('createConfiguredExecutionRuntimeForTurn');
    const calls = source.match(/createConfiguredExecutionRuntimeForTurn\s*\(/g);
    expect(calls?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test('index.ts does not directly call low-level createExecutionRuntimeForTurn', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf-8');
    // Match createExecutionRuntimeForTurn( but NOT createConfiguredExecutionRuntimeForTurn(
    const directCalls = source.match(/(?<!Configured)createExecutionRuntimeForTurn\s*\(/g);
    expect(directCalls?.length ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `npx vitest run src/__tests__/permission/classifier-production-wiring.test.ts`

Expected: ALL FAIL. `createConfiguredExecutionRuntimeForTurn` does not exist (import error).

---

### Task 2: Implement seam + schema + store + remove fallback + update existing tests

**Files:**
- Modify: `src/permission/authority-gate.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/store.ts`
- Modify: `src/__tests__/permission/authority-gate-production.test.ts`
- Modify: `src/__tests__/permission/authority-gate-contracts.test.ts`
- Modify: `src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts`

- [ ] **Step 1: Add classifier fields to PermissionConfig in `src/config/schema.ts`**

```ts
export interface PermissionConfig {
  mode: PermissionMode;
  rules: PermissionRuleConfig[];
  /**
   * Task 9：用户级 classifier rules（trusted userSettings 来源）。
   * 经 projectClassifierConfigSources 投影后进入 classifier prompt 的 Rules 段。
   */
  classifierRules?: string[];
  /**
   * Task 9：用户级显式 classifier model（trusted userSettings 来源）。
   * 经 projectClassifierConfigSources 投影后进入 ClassifierModelContext.classifierModel。
   * 必须在 provider 声明的模型列表中，否则 ClassifierModelUnavailableError。
   */
  classifierModel?: string;
}
```

- [ ] **Step 2: Add `getClassifierUserSettings` to ConfigStore in `src/config/store.ts`**

After the `getPermissionRules` method:

```ts
  /** Task 9：读取用户级 classifier config（trusted userSettings 来源）。 */
  getClassifierUserSettings(): { rules?: readonly string[]; classifierModel?: string } {
    const perms = this.config.permissions;
    const section: { rules?: readonly string[]; classifierModel?: string } = {};
    if (perms.classifierRules && perms.classifierRules.length > 0) {
      section.rules = [...perms.classifierRules];
    }
    if (perms.classifierModel) {
      section.classifierModel = perms.classifierModel;
    }
    return section;
  }
```

- [ ] **Step 3: Add `createConfiguredExecutionRuntimeForTurn` to `src/permission/authority-gate.ts`**

Add imports (after existing imports):

```ts
import { projectClassifierConfigSources, loadStaticClassifierProviderMetadata, type ClassifierConfigSourcesInput } from '../config/permission-sources.js';
import type { ProviderConfig } from '../config/schema.js';
```

Note: do NOT import `getModelsForProvider` here — model list is resolved by index.ts and passed as `providerModelIds`.

Add the seam function after `createExecutionRuntimeForTurn`:

```ts
/**
 * Production composition seam (Task 9): 组装 classifier config 并构造 turn runtime。
 *
 * index.ts 必须通过此函数构造 auto-mode runtime，不得直接调 createExecutionRuntimeForTurn。
 */
export function createConfiguredExecutionRuntimeForTurn(input: {
  readonly authority: PermissionAuthority;
  readonly streamClient: StreamingLLMClient;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerConfig?: ProviderConfig;
  readonly providerModelIds: readonly string[];
  readonly classifierConfigSources: ClassifierConfigSourcesInput;
  readonly permissionChecker: PermissionChecker;
  readonly runtimeGate: RuntimeSecurityGate;
  readonly sessionAllowlist: SessionAllowlist;
  readonly sessionState: SessionState;
  readonly hooks?: readonly PermissionRequestHook[];
  readonly dialogProvider?: (input: import('./interactive-ask.js').InteractiveAskInput) => Promise<import('./interactive-ask.js').DialogResult>;
  readonly dialogDelayMs?: number;
}): ToolExecutionRuntime {
  const projected = projectClassifierConfigSources(input.classifierConfigSources);
  const metadata = loadStaticClassifierProviderMetadata(
    input.providerConfig
      ? {
          fastClassifierModel: input.providerConfig.fastClassifierModel,
          classifierCapabilities: input.providerConfig.classifierCapabilities,
        }
      : {},
    {},
  );
  // staticallySelectableModels 只来自 provider 声明的模型列表（不含 classifierModel 自举）
  const staticallySelectableModels = input.providerModelIds.map((id) => ({
    providerId: input.providerId,
    modelId: id,
  }));
  const modelContext: ClassifierModelContext = {
    sessionMainModel: { providerId: input.providerId, modelId: input.modelId },
    staticallySelectableModels,
    ...(metadata.fastClassifierModel !== undefined
      ? { providerFastClassifierModel: { providerId: input.providerId, modelId: metadata.fastClassifierModel } }
      : {}),
    ...(projected.classifierModel !== undefined
      ? { classifierModel: { providerId: input.providerId, modelId: projected.classifierModel } }
      : {}),
  };
  return createExecutionRuntimeForTurn({
    authority: input.authority,
    streamClient: input.streamClient,
    providerId: input.providerId,
    modelId: input.modelId,
    permissionChecker: input.permissionChecker,
    runtimeGate: input.runtimeGate,
    sessionAllowlist: input.sessionAllowlist,
    sessionState: input.sessionState,
    hooks: input.hooks,
    classifierRules: projected.rules,
    classifierModelContext: modelContext,
    ...(input.dialogProvider !== undefined ? { dialogProvider: input.dialogProvider } : {}),
    ...(input.dialogDelayMs !== undefined ? { dialogDelayMs: input.dialogDelayMs } : {}),
  });
}
```

- [ ] **Step 4: Remove hardcoded fallback in `createResolver`**

**Before:**
```ts
  const modelContext: ClassifierModelContext = deps.classifierModelContext ?? {
    sessionMainModel: { providerId: deps.providerId, modelId: deps.modelId },
    staticallySelectableModels: [{ providerId: deps.providerId, modelId: deps.modelId }],
  };
```

**After:**
```ts
  if (!deps.classifierModelContext) {
    throw new Error('classifierModelContext is required for enforced/shadow authority (Task 9 production wiring)');
  }
  const modelContext = deps.classifierModelContext;
```

- [ ] **Step 5: Update existing tests that construct enforced/shadow TurnRuntimeDeps without classifierModelContext**

Removing the fallback means tests calling `createExecutionRuntimeForTurn` with enforced/shadow authority without `classifierModelContext` will throw. Add the field to the `makeDeps` helper (or equivalent) in these 3 files:

**`src/__tests__/permission/authority-gate-production.test.ts`** — find the deps construction, add:
```ts
  classifierModelContext: {
    sessionMainModel: { providerId: 'test', modelId: 'test-model' },
    staticallySelectableModels: [{ providerId: 'test', modelId: 'test-model' }],
  },
```

**`src/__tests__/permission/authority-gate-contracts.test.ts`** — in `makeDeps`:
```ts
  classifierModelContext: {
    sessionMainModel: { providerId: 'test', modelId: 'test-model' },
    staticallySelectableModels: [{ providerId: 'test', modelId: 'test-model' }],
  },
```

**`src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts`** — in `makeDeps`:
```ts
  classifierModelContext: {
    sessionMainModel: { providerId: 'test', modelId: 'test-model' },
    staticallySelectableModels: [{ providerId: 'test', modelId: 'test-model' }],
  },
```

Legacy test cases in these files do NOT need the field.

- [ ] **Step 6: Run Groups 1-3 to verify GREEN (Group 4 still RED)**

Run: `npx vitest run src/__tests__/permission/classifier-production-wiring.test.ts -t "composition seam|staticallySelectableModels|fail-closed"`

Expected: PASS (Groups 1-3).

- [ ] **Step 7: Verify Group 4 still RED**

Run: `npx vitest run src/__tests__/permission/classifier-production-wiring.test.ts -t "index.ts wiring contract"`

Expected: FAIL (index.ts not updated yet — `createConfiguredExecutionRuntimeForTurn` not called in index.ts).

- [ ] **Step 8: Run updated existing tests**

Run: `npx vitest run src/__tests__/permission/authority-gate-production.test.ts src/__tests__/permission/authority-gate-contracts.test.ts src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts`

Expected: PASS.

---

### Task 3: Wire `src/index.ts` to use the composition seam

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace import and inline composition with seam call**

Change the import:

**Before:**
```ts
import { createExecutionRuntimeForTurn } from './permission/authority-gate.js';
```

**After:**
```ts
import { createConfiguredExecutionRuntimeForTurn } from './permission/authority-gate.js';
```

Delete the `projectClassifierConfigSources` / `loadStaticClassifierProviderMetadata` import line (now handled inside the seam):

**Before:**
```ts
import { projectClassifierConfigSources, loadStaticClassifierProviderMetadata } from './config/permission-sources.js';
```
Delete this line entirely.

Replace the entire inline classifier composition + `createExecutionRuntimeForTurn` call with:

```ts
    // Task 9：通过 composition seam 构造 auto-mode production runtime。
    const providerConfig = configStore.getProvider(provider);
    const providerModelIds = getModelsForProvider(provider, undefined, providerConfig?.models).map((m) => m.value);
    const classifierConfigSources = {
      // userSettings：当前架构唯一可用的 trusted classifier config 来源（config 文件）。
      userSettings: configStore.getClassifierUserSettings(),
      // localSettings / flagSettings / policySettings：当前架构未实现，保留为 undefined。
    };
    const turnRuntime = createConfiguredExecutionRuntimeForTurn({
      authority: permissionAuthority,
      streamClient,
      providerId: provider,
      modelId: model,
      providerConfig,
      providerModelIds,
      classifierConfigSources,
      permissionChecker,
      runtimeGate,
      sessionAllowlist,
      sessionState,
      hooks: [],
    });
```

- [ ] **Step 2: Run full wiring test (all groups now GREEN)**

Run: `npx vitest run src/__tests__/permission/classifier-production-wiring.test.ts`

Expected: PASS (all 4 groups).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

---

### Task 4: Remove old insufficient test

**Files:**
- Delete: `src/__tests__/permission/classifier-config-wiring.test.ts`

- [ ] **Step 1: Delete old test**

```bash
rm src/__tests__/permission/classifier-config-wiring.test.ts
```

- [ ] **Step 2: Run affected tests to verify no broken references**

Run: `npx vitest run src/__tests__/permission/classifier-production-wiring.test.ts src/__tests__/permission/auto-settings.test.ts src/__tests__/permission/auto-classifier.test.ts src/__tests__/permission/auto-classifier-model-policy.test.ts`

Expected: PASS.

---

### Task 5: Affected regression + typecheck + full suite + commit

- [ ] **Step 1: Run permission + agent regression**

Run: `npx vitest run src/__tests__/permission/ src/__tests__/agent/`

Expected: PASS (0 failures).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 3: Run fresh full suite (once)**

Run: `npm test`

Expected: 0 failures, or only pre-existing load-dependent flaky tests (`child-process-env-scrub.test.ts` / `run-bash-tool.test.ts` on Windows under load). If failures occur, verify they are in these known flaky files and not in files touched by this diff. Record the raw result.

- [ ] **Step 4: Commit (new commit on top of c97ba87, no history rewrite)**

```bash
git add src/config/schema.ts src/config/store.ts src/permission/authority-gate.ts src/index.ts src/__tests__/permission/classifier-production-wiring.test.ts src/__tests__/permission/authority-gate-production.test.ts src/__tests__/permission/authority-gate-contracts.test.ts src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts
git rm src/__tests__/permission/classifier-config-wiring.test.ts
git commit -m "fix(task9): production composition seam + real userSettings + fail-closed modelContext

Replaces c97ba87's incorrect inline wiring with:
- createConfiguredExecutionRuntimeForTurn: production composition seam
- PermissionConfig.classifierRules + classifierModel: real userSettings source
- ConfigStore.getClassifierUserSettings(): reads from config file
- createResolver: no hardcoded fallback; enforced/shadow missing context throws
- index.ts: calls seam exclusively
- staticallySelectableModels from provider declarations only
- Wiring contract test: index.ts must use seam"
```

---

## Self-Review

**1. TDD phase correctness:**
- Task 2 Step 6: Groups 1-3 GREEN ✓
- Task 2 Step 7: Group 4 still RED ✓ (index.ts not updated)
- Task 3 Step 2: All 4 groups GREEN ✓

**2. ClassifierModelUnavailableError semantics:**
- Error thrown in `selectStage1()` during `classifier.classify()` (classifier-model-policy.ts:84), NOT during runtime construction
- Group 2 tests trigger via `executeToolCall` → resolver → classifier → selectStage1, verify result=failure + executor=0 + provider not called ✓

**3. Model wiring assertions:**
- `RecordingStreamClient` captures `req.model` (providerId + modelId) from `completeText` request
- Group 1 tests assert `sc.calls[0].model.modelId` equals expected model ✓
- Not just "classifier invoked" — actual model selection verified ✓

**4. Code correctness:**
- Uses `import { readFileSync } from 'node:fs'` / `import { join } from 'node:path'` (ESM, not require) ✓
- No `getModelsForProvider` import in authority-gate.ts ✓
- Commit is a new commit (no `--amend`, no history rewrite) ✓

**5. Scope — no expansion to other sources:**
- localSettings/flagSettings/policySettings: all undefined, no implementation ✓
- No CLI flags, no config layering, no policy subsystem ✓
- auditSink/dialogProvider not touched ✓

**6. c97ba87 handling:**
- TurnRuntimeDeps.classifierRules/classifierModelContext: retained ✓
- createResolver consuming deps: retained ✓
- Hardcoded fallback: deleted ✓
- index.ts inline composition: replaced by seam ✓
- classifier-config-wiring.test.ts: deleted ✓
