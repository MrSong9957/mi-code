# Subagent Error Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子代理遇到 provider/流式异常时不再被 Node `EventEmitter` 的保留 `"error"` 事件二次终止，并向主代理返回包含真实、脱敏诊断信息的 `incomplete reason=error` 回执。

**Architecture:** 先修复最早的控制流破坏点：`StreamEventBus` 内部不再使用 Node 保留事件名 `"error"`。然后提供一个共享的 unknown-error 格式化函数，统一处理 `Error`、普通对象、循环引用和敏感字段。最后由 `runSubagent` 在子代理生命周期边界把异常转换成现有 `SubagentResult`，复用已有 envelope 与 UI 展示协议。

**Tech Stack:** Node.js 18+、TypeScript ES2022/NodeNext、Vitest 3、Node `EventEmitter`

## Global Constraints

- 使用中文注释和测试描述，匹配项目现有风格。
- 严格执行 RED → GREEN → REFACTOR；每个新增关键测试必须先观察到预期失败。
- 不新增依赖。
- 不改变 `spawn_agent` 输入 schema、角色白名单、provider 选择或自动委派策略。
- 不修改用户已有的 `src/prompts/planner.generated.ts` 工作区变更。
- 对用户可见的错误保留最多 300 字符正文；发生截断时再追加一个 `…`，最终最长 301 字符。不得泄露 API Key、Authorization、token、password、private key、secret 或 cookie。
- 当前全量测试基线并非常绿；完成标准是本计划列出的受影响测试全部通过，且全量测试相对实施前基线零新增失败。
- 本计划不授权 `git commit`；只有用户后续明确授权时才提交。

---

## Investigation Record

### Confirmed reproduction

当前 `ToolRegistry` 会丢失普通对象异常：

```powershell
npx.cmd tsx -e "import { ToolRegistry } from './src/agent/tool-registry.ts'; void (async()=>{ const r=new ToolRegistry(); r.register({name:'spawn_agent',description:'',parameters:{type:'object'}}, async()=>{throw {status:429,error:{message:'rate limit'}}}); console.log(await r.execute('spawn_agent',{})); })();"
```

当前输出：

```text
Error executing tool "spawn_agent": [object Object]
```

当前子代理路径还会用 `ERR_UNHANDLED_ERROR` 覆盖原始 provider 异常：

```powershell
npx.cmd tsx -e "import { runSubagent } from './src/agent/subagent.ts'; import { ToolRegistry } from './src/agent/tool-registry.ts'; const client={async *stream(){throw {status:503,error:{message:'upstream unavailable'}}}}; void (async()=>{try{await runSubagent('inspect',new ToolRegistry(),{role:'explore',client,maxSteps:2})}catch(e){console.log(String(e)); console.log(JSON.stringify(e));}})();"
```

当前关键输出：

```text
Error [ERR_UNHANDLED_ERROR]: Unhandled error.
{"code":"ERR_UNHANDLED_ERROR","context":{"errorType":"unknown","message":"[object Object]","recoverable":false}}
```

### Root-cause chain

```text
provider 抛出普通对象
  → streamingQuery catch
  → classifyError 使用 String(error)，得到 "[object Object]"
  → StreamEventBus.emitError()
  → EventEmitter.emit("error") 且子代理没有 error listener
  → Node 抛出 ERR_UNHANDLED_ERROR，覆盖原始异常
  → runSubagent reject
  → ToolRegistry 再次 String(error)
  → UI 只能显示通用工具错误，无法生成 Subagent incomplete 回执
```

### Full-suite baseline

在生产代码未修改时运行 `npx.cmd vitest run`，120 秒后超时。超时前已观察到以下预存失败：

```text
src/__tests__/tui/layout.test.tsx
src/tui/inline/thinking-gap-regression.test.ts
src/__tests__/task-tool.test.ts
src/__tests__/background.test.ts
src/__tests__/regression/bash-process-control.test.ts
src/__tests__/commands/image-command.test.ts
src/__tests__/regression/child-process-env-scrub.test.ts
src/__tests__/agent/image-utils.test.ts
```

其中图片相关失败包含写入 `C:\Users\sry27\.micode\image-cache` 的沙箱 `EPERM`；该列表是超时前观察值，不保证覆盖基线中的全部失败。实施后不得把这些无关失败纳入本次修改。

### Wheel Reuse Check

- 复用 `SubagentResult`、`finalizeSubagentExecution()` 和 `formatSubagentResult()`，不增加新的子代理状态类型。
- 复用 `buildSubagentCompletionPresentation()` 对 `incomplete reason=error` 的现有解析能力，不修改 UI 协议。
- 保留 `formatErrorForDisplay()` 的现有导出路径，通过委托共享工具保持调用方兼容。
- 不复用 telemetry redaction：它面向结构化遥测协议，依赖远重于本次单行用户错误格式化需求。

### Core Anchor Function

核心函数是：

```ts
runSubagent(
  prompt: string,
  tools: ToolRegistry,
  options?: SubagentOptions,
): Promise<SubagentResult>
```

输入是子任务、工具注册表和执行选项；输出必须始终表达子代理的完成状态。provider 异常跨出该边界并变成 rejected promise，正是当前契约缺口。

### Defense Boundaries

1. `StreamEventBus`：错误通知不得因“无人监听”而改变控制流。
2. `formatUnknownError`：任意 thrown value 都能安全、脱敏、限长地转成文本。
3. `streamingQuery`：错误分类和错误事件使用同一份规范化文本。
4. `runSubagent`：执行失败转换为 `status=incomplete, terminationReason=error`。
5. `ToolRegistry`：非子代理工具仍有通用、可诊断的最终兜底。

---

### Task 1: Remove Node EventEmitter `"error"` Fatal Semantics

**Files:**

- Modify: `src/agent/stream-event-bus.ts:17-29,124-133`
- Create: `src/__tests__/stream-event-bus-error.test.ts`

**Interfaces:**

- Consumes: 现有 `ErrorEvent` 和 `emitError/onError/offError` 公共方法。
- Produces: 保持公共方法签名不变；仅将内部 EventEmitter channel 改为非保留名称。

- [ ] **Step 1: 写出“无监听器也不抛异常”的失败测试**

创建 `src/__tests__/stream-event-bus-error.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { StreamEventBus, type ErrorEvent } from '../agent/stream-event-bus.js';

const failure: ErrorEvent = {
  errorType: 'unknown',
  message: 'provider failed',
  recoverable: false,
};

describe('StreamEventBus error channel', () => {
  it('没有 error listener 时 emitError 不改变控制流', () => {
    const bus = new StreamEventBus();
    expect(() => bus.emitError(failure)).not.toThrow();
  });

  it('有 listener 时投递一次，off 后不再投递', () => {
    const bus = new StreamEventBus();
    const listener = vi.fn();

    bus.onError(listener);
    bus.emitError(failure);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(failure);

    bus.offError(listener);
    bus.emitError(failure);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
npx.cmd vitest run src/__tests__/stream-event-bus-error.test.ts
```

Expected: 第一条测试失败，错误包含 `ERR_UNHANDLED_ERROR`。

- [ ] **Step 3: 最小修改内部事件名**

在 `src/agent/stream-event-bus.ts` 的常量区增加：

```ts
const INTERNAL_ERROR_EVENT = 'agent_error';
```

保持公共 `StreamEventType` 中的 `'error'` 语义不变，只修改三个内部调用：

```ts
emitError(data: ErrorEvent): void {
  this.emitter.emit(INTERNAL_ERROR_EVENT, data);
}

onError(handler: (data: ErrorEvent) => void): void {
  this.emitter.on(INTERNAL_ERROR_EVENT, handler);
}

offError(handler: (data: ErrorEvent) => void): void {
  this.emitter.removeListener(INTERNAL_ERROR_EVENT, handler);
}
```

在常量旁说明：Node `EventEmitter` 对裸 `"error"` 事件有特殊的抛异常语义，类型安全包装层不能使用该内部 channel 名。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run:

```powershell
npx.cmd vitest run src/__tests__/stream-event-bus-error.test.ts
```

Expected: 2 tests passed。

- [ ] **Step 5: 检查任务边界**

Run:

```powershell
git diff -- src/agent/stream-event-bus.ts src/__tests__/stream-event-bus-error.test.ts
```

Expected: 只有内部 channel 名、解释注释和两条行为测试发生变化；不提交 commit。

---

### Task 2: Normalize Unknown Errors Without Leaking Secrets

**Files:**

- Create: `src/utils/error-message.ts`
- Create: `src/__tests__/utils/error-message.test.ts`
- Modify: `src/cli/format-error.ts:1-38`
- Modify: `src/agent/recovery.ts:108-130`
- Modify: `src/agent/streaming-query.ts:687-719,852-872`
- Modify: `src/agent/tool-registry.ts:78-83`
- Modify: `src/agent/subagent.ts:650-678`

**Interfaces:**

- Produces: `formatUnknownError(error: unknown, maxLength?: number): string`
- Preserves: `formatErrorForDisplay(error: unknown): string` 的现有导出与 300 字符行为。
- Consumes: Task 3 使用 `formatUnknownError()` 构造子代理失败正文。

- [ ] **Step 1: 写共享格式化函数的失败测试**

创建 `src/__tests__/utils/error-message.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatUnknownError } from '../../utils/error-message.js';

describe('formatUnknownError', () => {
  it('保留 Error message 且不输出 stack', () => {
    const output = formatUnknownError(new Error('Invalid API Key'));
    expect(output).toBe('Invalid API Key');
    expect(output).not.toContain(' at ');
  });

  it('序列化 provider 普通对象并保留分类字段', () => {
    const output = formatUnknownError({
      status: 429,
      code: 'rate_limit_exceeded',
      error: { message: 'Too many requests' },
    });
    expect(output).toContain('"status":429');
    expect(output).toContain('rate_limit_exceeded');
    expect(output).toContain('Too many requests');
    expect(output).not.toBe('[object Object]');
  });

  it('循环引用不会抛异常', () => {
    const value: Record<string, unknown> = { status: 503 };
    value.self = value;
    expect(formatUnknownError(value)).toContain('[Circular]');
  });

  it.each([
    'apiKey',
    'api_key',
    'authorization',
    'token',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'password',
    'privateKey',
    'private_key',
    'secret',
    'clientSecret',
    'client_secret',
    'cookie',
    'set-cookie',
  ])('脱敏敏感字段 %s', (key) => {
    const output = formatUnknownError({ status: 401, [key]: 'sensitive-value' });
    expect(output).not.toContain('sensitive-value');
    expect(output).toContain('[REDACTED]');
  });

  it('对象无法产生 JSON 文本时使用稳定 fallback', () => {
    const noJsonOutput = formatUnknownError({
      toJSON() {
        return undefined;
      },
    });
    const serializationFailure = formatUnknownError({ value: 1n });

    expect(noJsonOutput).toBe('[Unserializable error object]');
    expect(serializationFailure).toBe('[Unserializable error object]');
    expect(noJsonOutput).not.toBe('[object Object]');
    expect(serializationFailure).not.toBe('[object Object]');
  });

  it('默认截断到 300 字符加省略号', () => {
    const output = formatUnknownError({ message: 'x'.repeat(500) });
    expect(output).toHaveLength(301);
    expect(output.endsWith('…')).toBe(true);
  });

  it('尊重自定义 maxLength', () => {
    const output = formatUnknownError('x'.repeat(100), 50);
    expect(output).toBe(`${'x'.repeat(50)}…`);
    expect(output).toHaveLength(51);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
npx.cmd vitest run src/__tests__/utils/error-message.test.ts
```

Expected: FAIL，原因是 `src/utils/error-message.ts` 尚不存在。

- [ ] **Step 3: 实现最小共享格式化函数**

创建 `src/utils/error-message.ts`：

```ts
const DEFAULT_MAX_LENGTH = 300;

const SENSITIVE_FIELD = /^(?:apiKey|api_key|api-key|authorization|token|accessToken|access_token|access-token|refreshToken|refresh_token|refresh-token|password|privateKey|private_key|private-key|secret|clientSecret|client_secret|client-secret|(?:set-)?cookie)$/i;

function serializeObject(value: object): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (key, nested) => {
    if (key && SENSITIVE_FIELD.test(key)) return '[REDACTED]';
    if (typeof nested === 'object' && nested !== null) {
      if (seen.has(nested)) return '[Circular]';
      seen.add(nested);
    }
    return nested;
  });
  return serialized ?? '[Unserializable error object]';
}

export function formatUnknownError(
  error: unknown,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string {
  let message: string;
  if (error instanceof Error) {
    message = error.message || error.name;
  } else if (typeof error === 'string') {
    message = error;
  } else if (typeof error === 'object' && error !== null) {
    try {
      message = serializeObject(error);
    } catch {
      message = '[Unserializable error object]';
    }
  } else {
    message = String(error);
  }

  const safeMaxLength = Number.isFinite(maxLength)
    ? Math.max(0, Math.floor(maxLength))
    : DEFAULT_MAX_LENGTH;
  return message.length > safeMaxLength
    ? `${message.slice(0, safeMaxLength)}…`
    : message;
}
```

- [ ] **Step 4: 保留 CLI 兼容入口**

将 `src/cli/format-error.ts` 的实现替换为：

```ts
import { formatUnknownError } from '../utils/error-message.js';

export function formatErrorForDisplay(error: unknown): string {
  return formatUnknownError(error);
}
```

不要改变现有调用方 import 路径。

- [ ] **Step 5: 先扩展各消费边界的失败测试**

在 `src/__tests__/recovery.test.ts` 的 `classifyError` describe 中增加：

```ts
it('应从 provider 普通对象识别 429', () => {
  expect(classifyError({
    status: 429,
    error: { message: 'Too many requests' },
  })).toBe('rate_limited_429');
});
```

在 `src/__tests__/agent/tool-registry-ctx.test.ts` 增加：

```ts
it('普通对象异常保留诊断字段而不是 [object Object]', async () => {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'failing_tool',
      description: 'test',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    async () => {
      throw { status: 503, error: { message: 'upstream unavailable' } };
    },
  );

  const output = await registry.execute('failing_tool', {});
  expect(output).toContain('"status":503');
  expect(output).toContain('upstream unavailable');
  expect(output).not.toContain('[object Object]');
});
```

- [ ] **Step 6: 运行消费边界测试并确认 RED**

Run:

```powershell
npx.cmd vitest run src/__tests__/recovery.test.ts src/__tests__/agent/tool-registry-ctx.test.ts
```

Expected:

- object 429 当前被分类为 `unknown`；
- ToolRegistry 当前输出 `[object Object]`。

- [ ] **Step 7: 接入共享格式化函数**

在下列位置 import `formatUnknownError` 并替换 `String(error)`/`String(err)`：

```ts
// src/agent/recovery.ts
const msg = formatUnknownError(error);

// src/agent/streaming-query.ts
message: formatUnknownError(error),
const output = `[Tool Error] ${formatUnknownError(error)}`;

// src/agent/tool-registry.ts
const message = formatUnknownError(err);

// src/agent/subagent.ts background catch
options.onBackgroundComplete(
  `[Subagent error] ${formatUnknownError(err)}`,
);
```

`streamingQuery` 继续调用 `classifyError(error)` 并传入原始异常；规范化发生在
`classifyError()` 内部：先执行 `const msg = formatUnknownError(error)`，再执行
`const lower = msg.toLowerCase()`。因此不需要增加独立的 `error.status` 分支：
规范化后的 `{"status":429,...}` 文本已经包含字符串 `429`，会命中现有
`lower.includes('429')`。本任务的 RED→GREEN 正是验证对象先在分类器内部被
规范化，再复用现有分类规则。

只替换错误文本边界，不改变重试次数、错误分类枚举、工具执行顺序或 background 生命周期。

- [ ] **Step 8: 运行格式化与消费测试并确认 GREEN**

Run:

```powershell
npx.cmd vitest run src/__tests__/utils/error-message.test.ts src/__tests__/cli/format-error.test.ts src/__tests__/recovery.test.ts src/__tests__/agent/tool-registry-ctx.test.ts
```

Expected: 全部通过。

- [ ] **Step 9: 检查任务边界**

Run:

```powershell
git diff -- src/utils/error-message.ts src/cli/format-error.ts src/agent/recovery.ts src/agent/streaming-query.ts src/agent/tool-registry.ts src/agent/subagent.ts src/__tests__/utils/error-message.test.ts src/__tests__/recovery.test.ts src/__tests__/agent/tool-registry-ctx.test.ts
```

Expected: 只有共享格式化、四个错误边界和对应测试发生变化；不提交 commit。

---

### Task 3: Convert Foreground Subagent Exceptions Into Existing Incomplete Results

**Files:**

- Modify: `src/agent/subagent.ts:600-644`
- Modify: `src/__tests__/subagent-result-integrity.test.ts`
- Modify: `src/__tests__/role-agents.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `formatUnknownError(error: unknown): string`。
- Produces: provider 异常对应 `SubagentResult`：

```ts
{
  status: 'incomplete',
  terminationReason: 'error',
  isBackground: false,
  text: '[Subagent incomplete: terminated: error] <normalized error>',
  evidence: {
    toolCallCount: number,
    successfulToolResultCount: number,
  },
}
```

- [ ] **Step 1: 写 `runSubagent` 生命周期失败测试**

在 `src/__tests__/subagent-result-integrity.test.ts` 增加：

```ts
it('provider 抛普通对象时返回 incomplete/error 而不是 reject', async () => {
  const client: StreamingLLMClient = {
    async *stream() {
      throw {
        status: 503,
        code: 'upstream_unavailable',
        error: { message: 'provider temporarily unavailable' },
      };
    },
  };

  const result = await runSubagent('inspect files', makeReadRegistry(), {
    role: 'explore',
    client,
    maxSteps: 2,
  });

  expect(result.status).toBe('incomplete');
  expect(result.terminationReason).toBe('error');
  expect(result.isBackground).toBe(false);
  expect(result.text).toContain('"status":503');
  expect(result.text).toContain('provider temporarily unavailable');
  expect(result.text).not.toContain('[object Object]');
  expect(result.text).not.toContain('ERR_UNHANDLED_ERROR');
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts
```

Expected: promise reject，而不是返回 `SubagentResult`。

- [ ] **Step 3: 在核心生命周期边界转换异常**

在 `runSubagent()` 同步执行分支中，将证据变量移到 `try` 外，使 catch 和正常返回共享它们：

```ts
const prevCwd = options.cwd ? process.cwd() : null;
if (options.cwd) process.chdir(options.cwd);

let toolCallCount = 0;
let successfulToolResultCount = 0;
let finalTurnSynthesized: boolean | undefined;

try {
  let text: string;
  let terminationReason = 'end_turn';

  if (options.client) {
    const exec = await runSubagentWithClient(
      options.client,
      toolSubset,
      prompt,
      effectiveSystem,
      options,
    );
    text = exec.text;
    toolCallCount = exec.toolCallCount;
    successfulToolResultCount = exec.successfulToolResultCount;
    terminationReason = exec.terminationReason;
    finalTurnSynthesized = exec.finalTurnSynthesized;
  } else {
    const result = await runWithVercelAI(prompt, toolSubset, {
      model: options.model,
      maxSteps: options.maxSteps || 10,
      system: effectiveSystem,
      permissionChecker: options.permissionChecker,
    });
    text = result.text || '(no summary)';
  }

  if (options.readFileState) {
    for (const [key, value] of options.readFileState) {
      sharedFileState.set(key, value);
    }
  }

  return finalizeSubagentExecution(text, false, options.role, {
    toolCallCount,
    successfulToolResultCount,
    terminationReason,
    finalTurnSynthesized,
  });
} catch (error) {
  return finalizeSubagentExecution(
    formatUnknownError(error),
    false,
    options.role,
    {
      toolCallCount,
      successfulToolResultCount,
      terminationReason: 'error',
      finalTurnSynthesized,
    },
  );
} finally {
  if (prevCwd) process.chdir(prevCwd);
}
```

不要在 `spawn-agent-tool.ts` 再增加第二个 catch；错误状态应由 `runSubagent` 这个核心生命周期边界统一生成。

- [ ] **Step 4: 运行核心测试并确认 GREEN**

Run:

```powershell
npx.cmd vitest run src/__tests__/subagent-result-integrity.test.ts
```

Expected: 新测试和原有 7 条完整性测试全部通过。

- [ ] **Step 5: 写 `spawn_agent` 端到端失败回执测试**

在 `src/__tests__/role-agents.test.ts` 的 `createSpawnAgentTool` describe 中增加：

```ts
it('provider 异常通过 spawn_agent 输出 incomplete/error envelope', async () => {
  const registry = makeRegistry();
  const failingClient: StreamingLLMClient = {
    async *stream() {
      throw {
        status: 503,
        error: { message: 'upstream unavailable' },
      };
    },
  };
  const { executor } = createSpawnAgentTool(
    registry,
    () => failingClient,
    undefined,
    runSubagent,
  );

  const output = await executor({
    role: 'explore',
    prompt: 'inspect files',
    description: '检查文件',
  });

  expect(output).toContain('[Subagent status=incomplete reason=error]');
  expect(output).toContain('"status":503');
  expect(output).toContain('upstream unavailable');
  expect(output).not.toContain('[object Object]');
  expect(output).not.toContain('ERR_UNHANDLED_ERROR');
});
```

同时在测试文件顶部从现有模块导入 `runSubagent` 和 `StreamingLLMClient` 类型。

- [ ] **Step 6: 运行端到端测试并确认 GREEN**

Run:

```powershell
npx.cmd vitest run src/__tests__/role-agents.test.ts src/__tests__/ui/subagent-presentation.test.ts src/__tests__/ui/block-pipeline.test.ts
```

Expected:

- `spawn_agent` 返回 `incomplete reason=error` envelope；
- 现有 UI parser 继续把 incomplete 结果渲染为 Agent 专用单行；
- malformed fallback 行为不变。

- [ ] **Step 7: 重跑最初的源码复现**

Run:

```powershell
npx.cmd tsx -e "import { runSubagent } from './src/agent/subagent.ts'; import { ToolRegistry } from './src/agent/tool-registry.ts'; const client={async *stream(){throw {status:503,error:{message:'upstream unavailable'}}}}; void (async()=>{const result=await runSubagent('inspect',new ToolRegistry(),{role:'explore',client,maxSteps:2}); console.log(JSON.stringify(result));})();"
```

Expected output contains:

```text
"status":"incomplete"
"terminationReason":"error"
"status\":503"
```

Expected output does not contain:

```text
[object Object]
ERR_UNHANDLED_ERROR
```

- [ ] **Step 8: 检查任务边界**

Run:

```powershell
git diff -- src/agent/subagent.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts
```

Expected: 只有 foreground 子代理异常归类和两条回归测试发生变化；不提交 commit。

---

### Task 4: Verification and Handoff

**Files:**

- Verify only; no production file changes.
- Append verification evidence to `logs/subagent-error-propagation.md` only if the implementation session is explicitly asked to preserve a project log.

**Interfaces:**

- Consumes: Tasks 1-3 的代码和测试。
- Produces: 可审查的测试、类型和构建证据。

- [ ] **Step 1: 运行当前问题的最小回归集合**

Run:

```powershell
npx.cmd vitest run src/__tests__/stream-event-bus-error.test.ts src/__tests__/utils/error-message.test.ts src/__tests__/cli/format-error.test.ts src/__tests__/recovery.test.ts src/__tests__/agent/tool-registry-ctx.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/role-agents.test.ts src/__tests__/ui/subagent-presentation.test.ts src/__tests__/ui/block-pipeline.test.ts
```

Expected: 9 test files passed，0 failed。

- [ ] **Step 2: 运行影响模块测试**

Run:

```powershell
npx.cmd vitest run src/__tests__/agent/ src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/recovery.test.ts src/__tests__/ui/
```

Expected: 0 failed；若存在预先标记的 skipped，数量与基线一致。

- [ ] **Step 3: 运行全量测试**

Run:

```powershell
npx.cmd vitest run
```

Expected: 本计划受影响测试保持全绿，且相对 `Full-suite baseline` 零新增失败；预存失败和 skipped 单独记录，不计入本次修复，但不得恶化。

若命令失败：

1. 将失败文件与 `Full-suite baseline` 中的已知列表比较；
2. 对每个不在基线列表中的失败文件单独运行 `npx.cmd vitest run <file>`；
3. 任何涉及本计划修改文件、import 链或错误文本断言的新失败均视为本次回归，必须修复；
4. 与本次修改无关且可在未修改基线复现的失败只记录，不修改其生产代码或测试；
5. 因 120 秒超时导致无法获得完整基线时，不得仅凭“文件看起来无关”判定为预存失败，必须在干净基线 worktree 中单独复现。

- [ ] **Step 4: 运行 TypeScript 静态检查**

Run:

```powershell
npm.cmd run typecheck
```

Expected: exit code 0，无 TypeScript error。

- [ ] **Step 5: 运行 lint**

Run:

```powershell
npm.cmd run lint
```

Expected: 本次修改无新增 error；如仓库仍有基线 warning，逐条确认不来自本次文件。

- [ ] **Step 6: 运行构建**

注意：`npm run build` 会执行 prompt codegen，而当前工作区已有用户的 `src/prompts/planner.generated.ts` 修改。先记录该文件 hash，构建后确认内容未被本次工作意外改变：

```powershell
git diff -- src/prompts/planner.generated.ts
npm.cmd run build
git diff -- src/prompts/planner.generated.ts
```

Expected: build exit code 0；前后该用户文件 diff 相同。

- [ ] **Step 7: 最终 diff 审计**

Run:

```powershell
git status --short
git diff --check
git diff --stat
```

Expected:

- `git diff --check` exit code 0；
- 没有修改自动委派 prompt、角色工具白名单或 provider 配置；
- 用户原有 `src/prompts/planner.generated.ts` 变更仍被保留；
- 未创建 commit。

---

## Self-Review

- **Spec coverage:** EventEmitter 致命事件、普通对象诊断丢失、错误分类、子代理状态回执、UI 兼容、敏感字段、模块测试和全量测试均有对应任务。
- **Placeholder scan:** 计划中没有未定义的实现步骤；所有新增函数、测试输入、断言和命令均已给出。
- **Type consistency:** `formatUnknownError(error: unknown, maxLength?: number): string` 在 Tasks 2-3 中签名一致；失败状态复用现有 `SubagentResult` 字段和 `terminationReason: 'error'`。
- **Scope:** 自动委派过于积极是独立策略问题，不是本次子代理异常终止的根因，因此明确不在此修复中修改。
