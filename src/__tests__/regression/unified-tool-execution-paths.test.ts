import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

// Resolve the repo root from this test file's location instead of
// process.cwd(). Other tests (e.g. worktree-integration) chdir into temporary
// directories, which would otherwise break source reads under full-suite runs.
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

// P1-P5 production paths that must route through executeToolCall() and never
// call ToolRegistry.execute() directly after the unified-execution migration.
const PRODUCTION_PATHS = [
  'src/agent/streaming-executor.ts',
  'src/agent/streaming-query.ts',
  'src/agent/subagent.ts',
  'src/agent/self-organizing.ts',
  'src/agent/tools/spawn-agent-tool.ts',
  'src/agent/tools/task-tool.ts',
  'src/agent/tools/spawn-self-organizing-tool.ts',
  'src/index.ts',
] as const;

const FORBIDDEN_DIRECT_EXECUTION =
  /\b(?:this\.)?registry\.execute\s*\(/;

function readSource(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('unified tool execution source boundary', () => {
  it.each(PRODUCTION_PATHS)(
    '%s does not call ToolRegistry.execute() directly',
    (rel) => {
      const source = readSource(rel);
      expect(FORBIDDEN_DIRECT_EXECUTION.test(source)).toBe(false);
    },
  );

  it('detects direct registry execution in source text', () => {
    expect(FORBIDDEN_DIRECT_EXECUTION.test(
      'await registry.execute(name, input);',
    )).toBe(true);
  });

  it('does not flag executeToolCall or unrelated execute() calls', () => {
    expect(FORBIDDEN_DIRECT_EXECUTION.test(
      'await executeToolCall(registry, call, runtime);',
    )).toBe(false);
    expect(FORBIDDEN_DIRECT_EXECUTION.test(
      'await runtime.runtimeGate.execute(decision, cb);',
    )).toBe(false);
  });
});

describe('ESLint enforcement of the unified execution boundary', () => {
  it('reports the configured restriction for direct registry.execute() in a production path', async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const [result] = await eslint.lintText(
      'await registry.execute(name, input);',
      { filePath: 'src/agent/direct-execution-fixture.ts' },
    );

    expect(result.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            'Use executeToolCall() instead of ToolRegistry.execute() in production paths.',
        }),
      ]),
    );
  });
});

// ─── Task 6: resolver 路径统一经 gate 执行 ──────────────────────────────────────
//
// legacy 路径（无 askResolver）与 resolver 路径（有 askResolver）都经 runtimeGate.execute
// 唯一执行入口。messages 从 context 传入 resolver。
import { vi, it as _it } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import type { ToolExecutionRuntime } from '../../agent/tool-execution.js';
import type { PermissionAskResolver } from '../../permission/ask-resolver.js';
import type { SecurityDecision } from '../../permission/decisions.js';
import type { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import type { PermissionChecker } from '../../permission/checker.js';
import type { ToolUseBlock, Message } from '../../agent/types.js';
const it6 = _it;

function makeBlock(name: string, input: Record<string, unknown>, id = 't1'): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}
function fakeExecutor(output = 'ok'): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(output);
}
function fakeGate(): RuntimeSecurityGate & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async (decision: SecurityDecision, run: () => Promise<unknown>) => {
      if (decision.behavior === 'deny') return { kind: 'denied' as const };
      const result = await run();
      return { kind: 'executed' as const, result };
    }),
  } as unknown as RuntimeSecurityGate & { execute: ReturnType<typeof vi.fn> };
}
function fakeChecker(behavior: 'allow' | 'ask' | 'deny', rc = 'permission.user_confirmation_required'): PermissionChecker {
  return {
    check: () => ({ behavior, reason: 'test', reason_code: rc }),
    checkDecision: () => ({
      protocol_version: '1', decision_id: 'd', action: { kind: 'tool_call', subject_id: 't', snapshot_id: 's' },
      behavior, deciding_layer: 'p', risk_kind: 'r', policy_id: 'p', policy_version: '1',
      reason_code: rc, human_reason: 'h', provenance_refs: behavior === 'allow' ? ['t'] : [],
    }),
    checkWithEvaluationMode: () => ({ behavior, reason: 'test', reason_code: rc }),
  } as unknown as PermissionChecker;
}
function makeRuntime(opts: { gate: RuntimeSecurityGate; checker: PermissionChecker; askResolver?: PermissionAskResolver }): ToolExecutionRuntime {
  return { permissionChecker: opts.checker, runtimeGate: opts.gate, askResolver: opts.askResolver };
}
function toolRegistry(name: string, executor: ReturnType<typeof vi.fn>): Map<string, { definition: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, never> } }; executor: ReturnType<typeof vi.fn> }> {
  return new Map([[name, { definition: { name, description: 'd', parameters: { type: 'object' as const, properties: {} } }, executor }]]);
}

describe('unified tool execution paths: resolver integration (Task 6)', () => {
  it6('resolver path: ask resolved to allow, then gate executes', async () => {
    const executor = fakeExecutor();
    const gate = fakeGate();
    const askResolver: PermissionAskResolver = {
      resolve: vi.fn().mockResolvedValue({
        protocol_version: '1', decision_id: 'd', action: { kind: 'tool_call', subject_id: 't', snapshot_id: 's' },
        behavior: 'allow', deciding_layer: 'p', risk_kind: 'r', policy_id: 'p', policy_version: '1',
        reason_code: 'permission.classifier_allow', human_reason: 'h', provenance_refs: ['t'],
      } as SecurityDecision),
    };
    const runtime = makeRuntime({ gate, checker: fakeChecker('ask'), askResolver });
    const result = await executeToolCall(
      toolRegistry('write_file', executor),
      makeBlock('write_file', { path: 'a.ts', content: 'x' }),
      runtime,
      { toolUseId: 't1', origin: 'main' },
    );
    expect(result.status).toBe('success');
    expect(askResolver.resolve).toHaveBeenCalledOnce();
    expect(gate.execute).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledOnce();
  });

  it6('resolver path: ask resolved to deny, executor 0', async () => {
    const executor = fakeExecutor();
    const gate = fakeGate();
    const askResolver: PermissionAskResolver = {
      resolve: vi.fn().mockResolvedValue({
        protocol_version: '1', decision_id: 'd', action: { kind: 'tool_call', subject_id: 't', snapshot_id: 's' },
        behavior: 'deny', deciding_layer: 'p', risk_kind: 'r', policy_id: 'p', policy_version: '1',
        reason_code: 'permission.classifier_deny', human_reason: 'h', provenance_refs: [],
      } as SecurityDecision),
    };
    const runtime = makeRuntime({ gate, checker: fakeChecker('ask'), askResolver });
    const result = await executeToolCall(
      toolRegistry('write_file', executor),
      makeBlock('write_file', { path: 'a.ts', content: 'x' }),
      runtime,
      { toolUseId: 't1', origin: 'main' },
    );
    expect(result.status).toBe('failure');
    expect(executor).not.toHaveBeenCalled();
  });

  it6('resolver receives context.messages (authoredByUser preserved)', async () => {
    const executor = fakeExecutor();
    const gate = fakeGate();
    const resolveSpy = vi.fn().mockResolvedValue({
      protocol_version: '1', decision_id: 'd', action: { kind: 'tool_call', subject_id: 't', snapshot_id: 's' },
      behavior: 'allow', deciding_layer: 'p', risk_kind: 'r', policy_id: 'p', policy_version: '1',
      reason_code: 'permission.classifier_allow', human_reason: 'h', provenance_refs: ['t'],
    } as SecurityDecision);
    const askResolver: PermissionAskResolver = { resolve: resolveSpy };
    const runtime = makeRuntime({ gate, checker: fakeChecker('ask'), askResolver });
    const messages: Message[] = [{ role: 'user', content: 'real user intent', authoredByUser: true }];
    await executeToolCall(
      toolRegistry('write_file', executor),
      makeBlock('write_file', { path: 'a.ts', content: 'x' }),
      runtime,
      { toolUseId: 't1', origin: 'main', messages },
    );
    expect(resolveSpy).toHaveBeenCalledOnce();
    const req = resolveSpy.mock.calls[0][0];
    expect(req.messages).toBe(messages);
    expect(req.messages[0].authoredByUser).toBe(true);
  });
});
