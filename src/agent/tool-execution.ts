import type { PermissionChecker } from '../permission/checker.js';
import type { RuntimeSecurityGate } from '../permission/runtime-gate.js';

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
