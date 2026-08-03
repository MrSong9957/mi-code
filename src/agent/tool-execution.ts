import { createHash } from 'node:crypto';
import type { PermissionChecker } from '../permission/checker.js';
import type { RuntimeSecurityGate } from '../permission/runtime-gate.js';
import type { SessionAllowlist } from '../permission/session-allowlist.js';
import {
  applySubagentSilentPolicy,
  rewriteToAllow,
} from '../permission/subagent-silent-policy.js';
import type { PermissionAskResolver } from '../permission/ask-resolver.js';
import { freezeSnapshot } from './contracts/identities.js';
import type { ToolRegistry } from './tool-registry.js';
import type {
  ToolExecutionContext,
  ToolParameter,
  ToolUseBlock,
} from './types.js';

export interface CallbackError {
  name: string;
  message: string;
  code?: string;
}

export interface ToolExecutionStageHits {
  preExecute: boolean;
  postExecute: boolean;
  failure: boolean;
}

export interface ToolExecutionBase {
  toolUseId: string;
  toolName: string;
  inputUsed: Readonly<Record<string, unknown>>;
  durationMs: number;
  stageHits: ToolExecutionStageHits;
}

export interface ToolExecutionSuccess extends ToolExecutionBase {
  status: 'success';
  output: string;
  postExecuteError?: CallbackError;
}

type ToolExecutionFailureDetail =
  | { kind: 'unknown_tool'; stage: 'lookup'; message: string }
  | { kind: 'invalid_input'; stage: 'validation'; message: string }
  | { kind: 'permission_denied'; stage: 'permission'; message: string; code?: string }
  | { kind: 'cancelled'; stage: 'execution'; message: string; code?: string }
  | { kind: 'timeout'; stage: 'execution'; message: string; code?: string }
  | { kind: 'operational_error'; stage: 'execution'; message: string; code?: string };

export interface ToolExecutionFailure extends ToolExecutionBase {
  status: 'failure';
  output: string;
  failure: ToolExecutionFailureDetail;
  failureCallbackError?: CallbackError;
}

export type ToolExecutionResult =
  | ToolExecutionSuccess
  | ToolExecutionFailure;

export interface ToolPreExecuteContext {
  toolUseId: string;
  toolName: string;
  input: Readonly<Record<string, unknown>>;
}

export interface ToolPreExecuteResult {
  updatedInput?: Record<string, unknown>;
}

export interface ToolExecutionCallbacks {
  onPreExecute?: (
    context: ToolPreExecuteContext,
  ) =>
    | void
    | ToolPreExecuteResult
    | Promise<void | ToolPreExecuteResult>;
  onPostExecute?: (
    result: ToolExecutionSuccess,
  ) => void | Promise<void>;
  onFailure?: (
    result: ToolExecutionFailure,
  ) => void | Promise<void>;
}

export interface ToolExecutionRuntime {
  permissionChecker: PermissionChecker;
  runtimeGate: RuntimeSecurityGate;
  callbacks?: ToolExecutionCallbacks;
  /**
   * 主 Agent session 级 exact-match 授权缓存。
   * 仅 origin=main 路径消费:build_write_confirmation ask 命中时改写为 allow(经 rewriteToAllow),
   * gate onAuthorized 回调在 remember=true 时写入。deny/safety_uncertain 永不读 allowlist。
   */
  sessionAllowlist?: SessionAllowlist;
  /**
   * Task 6：auto ask resolver。提供后，auto 模式下 checkDecision 产生的 ask 经此 resolver
   * 解析（allowlist/acceptEdits simulation/classifier），替代旧 origin 静默分流短路。
   * 未提供时（LEGACY）保持既有 origin 路由行为。
   */
  askResolver?: PermissionAskResolver;
}

export class ToolOperationalError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'ToolOperationalError';
  }
}

export class PreCallbackInputViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreCallbackInputViolation';
  }
}

type ValidationResult =
  | { valid: true }
  | { valid: false; message: string };

function invalid(path: string, message: string): ValidationResult {
  return { valid: false, message: `${path}: ${message}` };
}

function validateToolInput(
  value: unknown,
  schema: ToolParameter,
  path = '$',
): ValidationResult {
  switch (schema.type) {
    case 'null':
      return value === null ? { valid: true } : invalid(path, 'expected null');
    case 'string':
      return typeof value === 'string'
        ? { valid: true }
        : invalid(path, 'expected string');
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return invalid(path, 'expected number');
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return invalid(path, `expected number >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return invalid(path, `expected number <= ${schema.maximum}`);
      }
      return { valid: true };
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? { valid: true }
        : invalid(path, 'expected boolean');
    case 'array': {
      if (!Array.isArray(value)) return invalid(path, 'expected array');
      if (!schema.items) return { valid: true };
      for (let index = 0; index < value.length; index += 1) {
        const result = validateToolInput(
          value[index],
          schema.items,
          `${path}[${index}]`,
        );
        if (!result.valid) return result;
      }
      return { valid: true };
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return invalid(path, 'expected object');
      }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(record, key)) {
          return invalid(`${path}.${key}`, 'required property missing');
        }
      }
      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        if (!Object.hasOwn(record, key)) continue;
        const result = validateToolInput(
          record[key],
          propertySchema,
          `${path}.${key}`,
        );
        if (!result.valid) return result;
      }
      return { valid: true };
    }
  }
}

function stageHits(): ToolExecutionStageHits {
  return {
    preExecute: false,
    postExecute: false,
    failure: false,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function readUpdatedInput(
  value: void | ToolPreExecuteResult,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new Error('onPreExecute returned an invalid result');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'updatedInput')) {
    throw new Error('onPreExecute returned an invalid result');
  }
  if (!Object.hasOwn(value, 'updatedInput')) return undefined;
  if (!isPlainRecord(value.updatedInput)) {
    throw new Error('onPreExecute returned an invalid result');
  }
  return value.updatedInput;
}

function classifyExecutorError(
  error: unknown,
): ToolExecutionFailureDetail | undefined {
  if (error instanceof ToolOperationalError) {
    return {
      kind: 'operational_error',
      stage: 'execution',
      message: error.message,
      code: error.code,
    };
  }
  if (
    error instanceof Error
    && 'code' in error
    && typeof (error as NodeJS.ErrnoException).code === 'string'
  ) {
    return {
      kind: 'operational_error',
      stage: 'execution',
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      kind: 'cancelled',
      stage: 'execution',
      message: error.message,
    };
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return {
      kind: 'timeout',
      stage: 'execution',
      message: error.message,
    };
  }
  return undefined;
}

type ExecutorOutcome =
  | { kind: 'returned'; output: string }
  | { kind: 'threw'; error: unknown };

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
    return String(value);
  } catch {
    return '[unserializable thrown value]';
  }
}

function toCallbackError(value: unknown): CallbackError {
  if (value instanceof Error) {
    const result: CallbackError = {
      name: value.name || 'Error',
      message: value.message,
    };
    if (
      'code' in value
      && typeof (value as NodeJS.ErrnoException).code === 'string'
    ) {
      result.code = (value as NodeJS.ErrnoException).code;
    }
    return result;
  }
  return {
    name: 'NonErrorThrown',
    message: safeString(value),
  };
}

async function finalizeSuccess(
  result: ToolExecutionSuccess,
  callback?: ToolExecutionCallbacks['onPostExecute'],
): Promise<ToolExecutionSuccess> {
  if (!callback) return result;
  result.stageHits.postExecute = true;
  try {
    await callback(result);
  } catch (error) {
    result.postExecuteError = toCallbackError(error);
  }
  return result;
}

async function finalizeFailure(
  result: ToolExecutionFailure,
  callback?: ToolExecutionCallbacks['onFailure'],
): Promise<ToolExecutionFailure> {
  if (!callback) return result;
  result.stageHits.failure = true;
  try {
    await callback(result);
  } catch (error) {
    result.failureCallbackError = toCallbackError(error);
  }
  return result;
}

export async function executeToolCall(
  registry: ToolRegistry,
  call: ToolUseBlock,
  runtime: ToolExecutionRuntime,
  context: Omit<ToolExecutionContext, 'toolUseId'> = {},
): Promise<ToolExecutionResult> {
  const startedAt = performance.now();
  const hits = stageHits();
  const originalInput = structuredClone(call.input);
  const registered = registry.get(call.name);
  if (!registered) {
    const message = `Unknown tool "${call.name}"`;
    return finalizeFailure({
      status: 'failure',
      toolUseId: call.id,
      toolName: call.name,
      inputUsed: freezeSnapshot(originalInput),
      durationMs: performance.now() - startedAt,
      stageHits: hits,
      output: `Error: ${message}`,
      failure: {
        kind: 'unknown_tool',
        stage: 'lookup',
        message,
      },
    }, runtime.callbacks?.onFailure);
  }

  const validation = validateToolInput(
    originalInput,
    registered.definition.parameters,
  );
  if (!validation.valid) {
    return finalizeFailure({
      status: 'failure',
      toolUseId: call.id,
      toolName: call.name,
      inputUsed: freezeSnapshot(originalInput),
      durationMs: performance.now() - startedAt,
      stageHits: hits,
      output: `Error: Invalid input for "${call.name}": ${validation.message}`,
      failure: {
        kind: 'invalid_input',
        stage: 'validation',
        message: validation.message,
      },
    }, runtime.callbacks?.onFailure);
  }

  let finalInput = structuredClone(originalInput);
  if (runtime.callbacks?.onPreExecute) {
    hits.preExecute = true;
    const preResult = await runtime.callbacks.onPreExecute({
      toolUseId: call.id,
      toolName: call.name,
      input: freezeSnapshot(structuredClone(originalInput)),
    });
    const updatedInput = readUpdatedInput(preResult);
    if (updatedInput !== undefined) {
      const replacement = structuredClone(updatedInput);
      const replacementValidation = validateToolInput(
        replacement,
        registered.definition.parameters,
      );
      if (!replacementValidation.valid) {
        throw new PreCallbackInputViolation(replacementValidation.message);
      }
      finalInput = replacement;
    }
  }

  const executorInput = structuredClone(finalInput);
  const inputUsed = freezeSnapshot(structuredClone(executorInput));
  const actionSnapshotId = `snap:${createHash('sha256')
    .update(JSON.stringify({ name: call.name, input: executorInput }))
    .digest('hex')
    .slice(0, 16)}`;
  const decision = runtime.permissionChecker.checkDecision(
    call.name,
    executorInput,
    {
      decision_id: `exec:${call.id}`,
      action_snapshot_id: actionSnapshotId,
      policy_id: 'permission-default',
      policy_version: '1',
    },
  );

  // ── origin 路由:在 checkDecision 后、gate.execute 前改写 effectiveDecision ──
  // tool executor 永远只有 runtimeGate.execute 一个执行入口(不变量)。
  // deny/safety_uncertain 已被 checkDecision 先行拦截,到达此处时:
  //   - askResolver 提供（Task 6）→ auto ask 经 resolver 解析（allowlist/acceptEdits/classifier）
  //   - origin=subagent（LEGACY 无 resolver）→ applySubagentSilentPolicy 静默分流
  //   - origin=main + allowlist exact-match 命中（LEGACY）→ rewriteToAllow
  const origin = context.origin ?? 'main';
  let effectiveDecision = decision;

  if (decision.behavior === 'ask' && runtime.askResolver) {
    // Task 6：auto ask resolver。classifier pending 时此处 await，gate/executor 不调用。
    const resolved = await runtime.askResolver.resolve({
      decision,
      executableToolCall: {
        callId: call.id,
        canonicalToolName: call.name,
        input: executorInput,
      },
      messages: context.messages ?? [], // 真实 session 历史（含 authoredByUser 标记）
      origin,
      permissionContext: null,
    });
    // resolver 可能返回简化 decision（只有 behavior + reason_code）；
    // 合并原始 decision 的结构字段（action/protocol_version 等），保证 gate 能读 snapshot_id。
    effectiveDecision = { ...decision, ...resolved, action: decision.action };
  } else if (origin === 'subagent') {
    // 子代理:按 reason_code 静默分流(ask→allow/deny 改写),仍走 gate。
    effectiveDecision = applySubagentSilentPolicy(decision);
  } else if (
    decision.behavior === 'ask' &&
    decision.reason_code === 'permission.user_confirmation_required' &&
    runtime.sessionAllowlist?.has(call.name, executorInput) === true
  ) {
    // 主 Agent allowlist exact-match 命中 → 把 ask 改写成 allow(不绕过 gate)。
    effectiveDecision = rewriteToAllow(decision);
  }

  // ★ 唯一执行入口:所有路径(子代理静默 / allowlist 命中 / 正常 ask)统一经 gate.execute。
  // onAuthorized 回调写 allowlist(仅 main + remember);observer 异常不影响执行(gate 保证)。
  const gated = await runtime.runtimeGate.execute(
    effectiveDecision,
    async (): Promise<ExecutorOutcome> => {
      try {
        return {
          kind: 'returned',
          output: await registered.executor(executorInput, {
            ...context,
            toolUseId: call.id,
          }),
        };
      } catch (error) {
        return { kind: 'threw', error };
      }
    },
    origin === 'main'
      ? {
          onAuthorized: (action) => {
            if (action.remember) {
              runtime.sessionAllowlist?.add(call.name, executorInput);
            }
          },
        }
      : undefined,
  );

  if (gated.kind === 'denied') {
    return finalizeFailure({
      status: 'failure',
      toolUseId: call.id,
      toolName: call.name,
      inputUsed,
      durationMs: performance.now() - startedAt,
      stageHits: hits,
      output: gated.human_reason,
      failure: {
        kind: 'permission_denied',
        stage: 'permission',
        message: gated.human_reason,
        code: gated.reason_code,
      },
    }, runtime.callbacks?.onFailure);
  }

  if (gated.kind === 'threw') {
    const failure = classifyExecutorError(gated.error);
    if (!failure) throw gated.error;
    return finalizeFailure({
      status: 'failure',
      toolUseId: call.id,
      toolName: call.name,
      inputUsed,
      durationMs: performance.now() - startedAt,
      stageHits: hits,
      output: `Error executing tool "${call.name}": ${failure.message}`,
      failure,
    }, runtime.callbacks?.onFailure);
  }

  return finalizeSuccess({
    status: 'success',
    toolUseId: call.id,
    toolName: call.name,
    inputUsed,
    durationMs: performance.now() - startedAt,
    stageHits: hits,
    output: gated.output,
  }, runtime.callbacks?.onPostExecute);
}
