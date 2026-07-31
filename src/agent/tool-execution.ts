import { createHash } from 'node:crypto';
import type { PermissionChecker } from '../permission/checker.js';
import type { RuntimeSecurityGate } from '../permission/runtime-gate.js';
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
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { valid: true }
        : invalid(path, 'expected number');
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
    return {
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
    };
  }

  const validation = validateToolInput(
    originalInput,
    registered.definition.parameters,
  );
  if (!validation.valid) {
    return {
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
    };
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
  const gated = await runtime.runtimeGate.execute(
    decision,
    async () => registered.executor(executorInput, {
      ...context,
      toolUseId: call.id,
    }),
  );

  if (typeof gated !== 'string') {
    return {
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
    };
  }

  return {
    status: 'success',
    toolUseId: call.id,
    toolName: call.name,
    inputUsed,
    durationMs: performance.now() - startedAt,
    stageHits: hits,
    output: gated,
  };
}
