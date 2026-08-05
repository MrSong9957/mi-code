// Task 9 production wiring: composition seam + fail-closed contracts.
// Tests prove config reaches classifier via the real production path.
import { describe, test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

// 仓库根：基于本测试文件位置解析，不依赖 process.cwd()
// （full-suite 下其它测试可能 process.chdir 污染 cwd）。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INDEX_TS_PATH = join(REPO_ROOT, 'src', 'index.ts');

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
    const source = readFileSync(INDEX_TS_PATH, 'utf-8');
    expect(source).toContain('createConfiguredExecutionRuntimeForTurn');
    const calls = source.match(/createConfiguredExecutionRuntimeForTurn\s*\(/g);
    expect(calls?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test('index.ts does not directly call low-level createExecutionRuntimeForTurn', () => {
    const source = readFileSync(INDEX_TS_PATH, 'utf-8');
    // Match createExecutionRuntimeForTurn( but NOT createConfiguredExecutionRuntimeForTurn(
    const directCalls = source.match(/(?<!Configured)createExecutionRuntimeForTurn\s*\(/g);
    expect(directCalls?.length ?? 0).toBe(0);
  });
});
