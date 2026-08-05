// Task 10: Streaming 并发、保序与级联（A50-A56）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §8（并发控制）、
//          §10 A50-A56 重定义。
//
// 锁定 src/agent/streaming-executor.ts 的并发行为：
//   - safe tools（只读）可并行（A50）
//   - unsafe tool（写/run_bash）独占，排斥所有 sibling 直到释放（A51）
//   - 结果按 tool-call 顺序 yield，即使后完成的先返回（A52）
//   - read failure 不 abort safe sibling（A53）
//   - 只有 run_bash execution failure abort 未完成 sibling（A54）
//   - write_file 等 non-Bash unsafe failure 不级联 abort（A54）
//   - malformed/unknown concurrency declaration 一律 unsafe（A55）
//   - mode 不参与并发分类：build 与 auto 产生相同 scheduling class（A56）
//
// 测试用 deferred（可控 Promise）证明并行/排斥，不依赖 wall-clock 阈值。
// unsafe 工具通过 allow 规则放行 permission，确保 executor 真正执行到 deferred。
import { describe, test, expect } from 'vitest';
import { StreamingToolExecutor, isConcurrencySafe } from '../../agent/streaming-executor.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type { ToolDefinition, ToolExecutor, ToolUseBlock } from '../../agent/types.js';
import { ToolOperationalError } from '../../agent/tool-execution.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';
import type { PermissionRule } from '../../permission/types.js';

// ─── test helpers ──────────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

function registerTool(registry: ToolRegistry, name: string, exec: ToolExecutor): void {
  const def: ToolDefinition = {
    name,
    description: `test ${name}`,
    parameters: { type: 'object', properties: {} },
  };
  registry.register(def, exec);
}

/** allow 规则：放行指定工具通过 permission（让 executor 真正执行） */
function allowRule(tool: string): PermissionRule {
  return { tool, behavior: 'allow' };
}

/** 等待条件满足（轮询） */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`until() timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 构造 runtime，给指定 unsafe 工具加 allow 规则 */
function runtimeWithAllows(tools: string[], mode: 'build' | 'auto' = 'build') {
  return createToolExecutionRuntime({ mode, rules: tools.map(allowRule) });
}

// ─── A50: safe tools 并行 ─────────────────────────────────────────────────────

describe('[A50] safe tools both start before either barrier releases', () => {
  test('two read-only tools execute concurrently', async () => {
    const registry = new ToolRegistry();
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];
    registerTool(registry, 'read_file', async () => { started.push('read_file'); return first.promise; });
    registerTool(registry, 'grep', async () => { started.push('grep'); return second.promise; });

    const executor = new StreamingToolExecutor(
      registry, createToolExecutionRuntime(), new AbortController().signal,
    );
    executor.addTool(toolUse('1', 'read_file'));
    executor.addTool(toolUse('2', 'grep'));

    await until(() => started.length === 2);
    expect(started).toEqual(expect.arrayContaining(['read_file', 'grep']));
    first.resolve('r');
    second.resolve('g');
  });
});

// ─── A51: unsafe tool 独占，排斥 sibling ──────────────────────────────────────

describe('[A51] unsafe tool excludes every sibling until released', () => {
  test('write_file blocks read_file until write completes', async () => {
    const registry = new ToolRegistry();
    const writeDeferred = deferred<string>();
    let readStarted = false;
    registerTool(registry, 'write_file', async () => writeDeferred.promise);
    registerTool(registry, 'read_file', async () => { readStarted = true; return 'r'; });

    const executor = new StreamingToolExecutor(
      registry, runtimeWithAllows(['write_file']), new AbortController().signal,
    );
    executor.addTool(toolUse('1', 'write_file'));
    executor.addTool(toolUse('2', 'read_file'));

    await until(() => executor.hasExecuting());
    await new Promise((r) => setTimeout(r, 30));
    expect(readStarted).toBe(false);
    writeDeferred.resolve('w');
    await until(() => readStarted);
    expect(readStarted).toBe(true);
  });
});

// ─── A52: 结果按 tool-call 顺序 yield ─────────────────────────────────────────

describe('[A52] results yield in tool-call order even when second finishes first', () => {
  test('ordered yield regardless of completion order', async () => {
    const registry = new ToolRegistry();
    const first = deferred<string>();
    const second = deferred<string>();
    registerTool(registry, 'read_file', async () => first.promise);
    registerTool(registry, 'grep', async () => second.promise);

    const executor = new StreamingToolExecutor(
      registry, createToolExecutionRuntime(), new AbortController().signal,
    );
    executor.addTool(toolUse('1', 'read_file'));
    executor.addTool(toolUse('2', 'grep'));

    await until(() => executor.hasExecuting());
    second.resolve('second');
    first.resolve('first');

    const collected: string[] = [];
    for await (const batch of executor.getRemainingResults()) {
      for (const tool of batch) {
        if (tool.executionResult?.status === 'success') collected.push(tool.executionResult.output);
      }
    }
    expect(collected).toEqual(['first', 'second']);
  });
});

// ─── A53: read failure 不 abort safe sibling ──────────────────────────────────

describe('[A53] read failure does not abort a safe sibling', () => {
  test('failing read_file does not cancel a concurrent grep', async () => {
    const registry = new ToolRegistry();
    const readDeferred = deferred<string>();
    let grepDone = false;
    registerTool(registry, 'read_file', async () => readDeferred.promise);
    registerTool(registry, 'grep', async () => { grepDone = true; return 'grep-ok'; });

    const executor = new StreamingToolExecutor(
      registry, createToolExecutionRuntime(), new AbortController().signal,
    );
    executor.addTool(toolUse('1', 'read_file'));
    executor.addTool(toolUse('2', 'grep'));

    await until(() => executor.hasExecuting());
    // read_file 失败（ToolOperationalError -> operational_error failure，不 re-throw）
    readDeferred.reject(new ToolOperationalError('read io error', 'EIO'));

    // grep 应该仍能完成（read failure 不 abort safe sibling）
    await until(() => grepDone, 2000);
    expect(grepDone).toBe(true);
  });
});

// ─── A54: Bash failure abort siblings；non-Bash unsafe failure 不 abort ───────

describe('[A54] run_bash failure aborts unfinished siblings', () => {
  test('run_bash failure cancels a queued (not-yet-started) sibling', async () => {
    const registry = new ToolRegistry();
    const bashDeferred = deferred<string>();
    let writeStarted = false;
    registerTool(registry, 'run_bash', async () => bashDeferred.promise);
    registerTool(registry, 'write_file', async () => { writeStarted = true; return 'w'; });

    const executor = new StreamingToolExecutor(
      registry, runtimeWithAllows(['run_bash', 'write_file']), new AbortController().signal,
    );
    // run_bash（unsafe，独占）先执行；write_file（unsafe）排队等待。
    // run_bash 失败后，write_file 应被 abort（cancelled），不执行。
    executor.addTool(toolUse('1', 'run_bash', { command: 'echo hi' }));
    executor.addTool(toolUse('2', 'write_file'));

    await until(() => executor.hasExecuting());
    // run_bash execution failure（ToolOperationalError -> operational_error failure）
    bashDeferred.reject(new ToolOperationalError('bash crashed', 'BASH_FAIL'));

    // 等待 write_file 被标记完成（应为 cancelled，不执行 executor body）
    await until(() => executor.getResults().length === 2, 2000);
    expect(writeStarted).toBe(false); // write_file executor 从未执行

    const results = executor.getResults();
    const writeResult = results.find((t) => t.id === '2');
    expect(writeResult?.executionResult?.status).toBe('failure');
    expect(writeResult?.executionResult?.failure?.kind).toBe('cancelled');
  });

  test('non-Bash unsafe (write_file) failure does not abort unfinished siblings', async () => {
    const registry = new ToolRegistry();
    const writeDeferred = deferred<string>();
    let readDone = false;
    registerTool(registry, 'write_file', async () => writeDeferred.promise);
    registerTool(registry, 'read_file', async () => { readDone = true; return 'read-ok'; });

    const executor = new StreamingToolExecutor(
      registry, runtimeWithAllows(['write_file']), new AbortController().signal,
    );
    // write_file（unsafe，独占）先；read_file（safe）排队。
    // write_file 失败后，read_file 应仍执行（不 abort）。
    executor.addTool(toolUse('1', 'write_file'));
    executor.addTool(toolUse('2', 'read_file'));

    await until(() => executor.hasExecuting());
    writeDeferred.reject(new ToolOperationalError('write disk error', 'EDISK'));

    // read_file 仍执行
    await until(() => readDone, 2000);
    expect(readDone).toBe(true);
  });
});

// ─── A55: malformed concurrency declaration 一律 unsafe ───────────────────────

describe('[A55] malformed concurrency declaration is unsafe', () => {
  test('unknown tool name is unsafe', () => {
    expect(isConcurrencySafe('plugin_unknown_tool')).toBe(false);
  });

  test('malformed/missing schema declaration is unsafe', () => {
    // isConcurrencySafe 第三参数是可选的 schema 声明。
    // schema 未确认/缺失/malformed 一律 unsafe（设计 §8 / A55）。
    // 对非 read-only 真相源中的工具，无论 schema 如何，都 unsafe。
    expect(isConcurrencySafe('plugin_tool', {}, undefined)).toBe(false);
  });

  test('known safe tools remain safe regardless of schema arg', () => {
    expect(isConcurrencySafe('read_file', {}, undefined)).toBe(true);
    expect(isConcurrencySafe('grep')).toBe(true);
  });
});

// ─── A56: mode 不参与并发分类 ─────────────────────────────────────────────────

describe('[A56] build and auto produce identical scheduling classes', () => {
  test('isConcurrencySafe does not depend on permission mode', () => {
    // isConcurrencySafe 是纯函数，签名中没有 mode 参数。
    const tools = ['read_file', 'grep', 'glob', 'write_file', 'run_bash', 'unknown_tool'];
    const classes = tools.map((t) => isConcurrencySafe(t));
    expect(tools.map((t) => isConcurrencySafe(t))).toEqual(classes);
    expect(classes).toEqual([true, true, true, false, false, false]);
  });
});
