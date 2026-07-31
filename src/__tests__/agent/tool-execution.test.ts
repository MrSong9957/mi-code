import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type {
  ToolDefinition,
  ToolExecutor,
} from '../../agent/types.js';

describe('ToolRegistry.get', () => {
  it('returns the complete registered tool without replacing its executor', () => {
    const registry = new ToolRegistry();
    const definition: ToolDefinition = {
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object' },
    };
    const executor: ToolExecutor = async () => 'ok';

    registry.register(definition, executor);

    expect(registry.get('echo')).toEqual({ definition, executor });
    expect(registry.get('echo')?.executor).toBe(executor);
    expect(registry.get('missing')).toBeUndefined();
  });
});
