import type { ToolExecutionCallbacks, ToolExecutionRuntime } from '../../agent/tool-execution.js';
import { PermissionChecker } from '../../permission/checker.js';
import {
  RuntimeSecurityGate,
  type PendingDecisionStore,
  type PendingSecurityDecision,
  type UserDecisionChannel,
} from '../../permission/runtime-gate.js';
import type { PermissionMode, PermissionRule } from '../../permission/types.js';

class InMemoryPendingDecisionStore implements PendingDecisionStore {
  private readonly decisions: PendingSecurityDecision[] = [];

  async save(pending: PendingSecurityDecision): Promise<void> {
    this.decisions.push({ ...pending });
  }

  async load(sessionId: string): Promise<readonly PendingSecurityDecision[]> {
    return this.decisions.filter((decision) => decision.session_id === sessionId);
  }

  async update(
    decisionId: string,
    update: Partial<PendingSecurityDecision>,
  ): Promise<void> {
    const decision = this.decisions.find((item) => item.decision_id === decisionId);
    if (decision) Object.assign(decision, update);
  }
}

export function createToolExecutionRuntime(
  options: {
    mode?: PermissionMode;
    channel?: UserDecisionChannel | null;
    callbacks?: ToolExecutionCallbacks;
    rules?: PermissionRule[];
  } = {},
): ToolExecutionRuntime {
  return {
    permissionChecker: new PermissionChecker({
      mode: options.mode ?? 'auto',
      workdir: process.cwd(),
      ...(options.rules ? { rules: options.rules } : {}),
    }),
    runtimeGate: new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingDecisionStore(),
      channel: options.channel ?? null,
      sessionId: 'tool-execution-test',
    }),
    callbacks: options.callbacks,
  };
}
