import { describe, expect, it, vi } from 'vitest';
import { createSpawnAgentTool } from '../../../src/agent/tools/spawn-agent-tool.js';
import { createTaskTool } from '../../../src/agent/tools/task-tool.js';
import { createSpawnSelfOrganizingTool } from '../../../src/agent/tools/spawn-self-organizing-tool.js';
import { ToolRegistry } from '../../../src/agent/tool-registry.js';
import { TodoManager } from '../../../src/agent/todo.js';
import { InboxManager } from '../../../src/agent/inbox.js';
import { runSubagent, type SubagentOptions, type SubagentResult } from '../../../src/agent/subagent.js';
import type { SelfOrganizingOptions } from '../../../src/agent/self-organizing.js';
import { createToolExecutionRuntime } from '../helpers/tool-execution-runtime.js';
import type {
  AssistantMessage,
  ContentBlock,
  Message,
  StreamEvent,
  StreamingLLMClient,
  StreamOptions,
  ToolDefinition,
} from '../../../src/agent/types.js';
import type {
  SecurityDecision,
  UserDecision,
  UserDecisionChannel,
} from '../../../src/permission/runtime-gate.js';

const childTools = new ToolRegistry();

function completedResult(): SubagentResult {
  return {
    text: 'done',
    isBackground: false,
    status: 'completed',
    terminationReason: 'end_turn',
    evidence: { toolCallCount: 1, successfulToolResultCount: 1 },
  };
}

class ChildScriptClient implements StreamingLLMClient {
  private turn = 0;

  async *stream(
    _messages: Message[],
    _tools: ToolDefinition[],
    _options: StreamOptions,
  ): AsyncGenerator<StreamEvent | AssistantMessage> {
    const content: ContentBlock[] = this.turn++ === 0
      ? [{
          type: 'tool_use',
          id: 'child-write-1',
          name: 'write_file',
          input: { path: 'inside.txt', content: 'x' },
        }]
      : [{ type: 'text', text: 'child done' }];
    yield {
      type: 'assistant',
      content,
      usage: { input_tokens: 1, output_tokens: 1 },
      stopReason: content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn',
      uuid: `child-${this.turn}`,
      timestamp: new Date().toISOString(),
    };
  }
}

class DeferredDecisionChannel implements UserDecisionChannel {
  private decision?: SecurityDecision;
  private requestedResolve!: () => void;
  private responseResolve!: (decision: UserDecision) => void;
  readonly requested = new Promise<void>((resolve) => { this.requestedResolve = resolve; });
  private readonly response = new Promise<UserDecision>((resolve) => { this.responseResolve = resolve; });

  request(decision: SecurityDecision): Promise<UserDecision> {
    this.decision = decision;
    this.requestedResolve();
    return this.response;
  }

  resolve(response: UserDecision['response']): void {
    if (!this.decision) throw new Error('decision has not been requested');
    this.responseResolve({
      protocol_version: '1',
      decision_id: this.decision.decision_id,
      response,
      decided_at: new Date().toISOString(),
    });
  }
}

function childRegistry(executor: () => Promise<string>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'write_file',
    description: 'write',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  }, executor);
  return registry;
}

describe('child execution runtime propagation', () => {
  it('spawn_agent passes the same runtime object to its runner', async () => {
    const runtime = createToolExecutionRuntime();
    let captured: SubagentOptions | undefined;
    const runner = vi.fn(async (
      _prompt: string,
      _tools: ToolRegistry,
      options: SubagentOptions,
    ) => {
      captured = options;
      return completedResult();
    });
    const tool = createSpawnAgentTool(
      childTools,
      undefined,
      runtime,
      runner,
    );

    await tool.executor({ role: 'general', prompt: 'inspect' });

    expect(captured?.executionRuntime).toBe(runtime);
  });

  it('task passes the same runtime object to its runner', async () => {
    const runtime = createToolExecutionRuntime();
    let captured: SubagentOptions | undefined;
    const runner = vi.fn(async (
      _prompt: string,
      _tools: ToolRegistry,
      options: SubagentOptions,
    ) => {
      captured = options;
      return completedResult();
    });
    const tool = createTaskTool(childTools, runtime, undefined, undefined, runner);

    await tool.executor({ prompt: 'inspect' });

    expect(captured?.executionRuntime).toBe(runtime);
  });

  it('spawn_self_organizing passes the same runtime object to its runner', async () => {
    const runtime = createToolExecutionRuntime();
    const captured: SelfOrganizingOptions[] = [];
    const runner = vi.fn(async (
      _name: string,
      _role: string,
      _identity: string,
      _tools: ToolRegistry,
      _todo: TodoManager,
      _inbox: InboxManager,
      options: SelfOrganizingOptions,
    ) => {
      captured.push(options);
      return 'done';
    });
    const tool = createSpawnSelfOrganizingTool(
      childTools,
      new TodoManager(),
      new InboxManager(),
      { runFn: runner, executionRuntime: runtime },
    );

    await tool.executor({ name: 'worker', role: 'coder', identity: 'i', prompt: 'inspect' });

    expect(captured[0]?.executionRuntime).toBe(runtime);
  });

  it('keeps a child ask blocked until the shared gate approves once', async () => {
    const channel = new DeferredDecisionChannel();
    let calls = 0;
    const runtime = createToolExecutionRuntime({ mode: 'build', channel });
    const running = runSubagent('write a file', childRegistry(async () => {
      calls++;
      return 'written';
    }), {
      role: 'general',
      client: new ChildScriptClient(),
      maxSteps: 3,
      executionRuntime: runtime,
    });

    await channel.requested;
    expect(calls).toBe(0);
    channel.resolve('approved_once');
    await running;
    expect(calls).toBe(1);
  });

  it('reports permission_denied to the child when the shared gate rejects', async () => {
    const failures: string[] = [];
    const channel: UserDecisionChannel = {
      request: async (decision) => ({
        protocol_version: '1',
        decision_id: decision.decision_id,
        response: 'rejected',
        decided_at: new Date().toISOString(),
      }),
    };
    let calls = 0;
    const runtime = createToolExecutionRuntime({
      mode: 'build',
      channel,
      callbacks: {
        onFailure: ({ failure }) => { failures.push(failure.kind); },
      },
    });

    await runSubagent('write a file', childRegistry(async () => {
      calls++;
      return 'written';
    }), {
      role: 'general',
      client: new ChildScriptClient(),
      maxSteps: 3,
      executionRuntime: runtime,
    });

    expect(calls).toBe(0);
    expect(failures).toContain('permission_denied');
  });
});
