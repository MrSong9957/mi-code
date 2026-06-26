// 团队工具：send_message、read_inbox、spawn_teammate
import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { TeammateManager } from './teammate-manager.js';

export function createSpawnTeammateTool(manager: TeammateManager): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'spawn_teammate',
      description: 'Spawn a long-running teammate with a role and initial task',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Teammate name (e.g. alice, bob)' },
          role: { type: 'string', description: 'Teammate role (e.g. coder, tester)' },
          prompt: { type: 'string', description: 'Initial task description for the teammate' },
        },
        required: ['name', 'role', 'prompt'],
      },
    },
    executor: async (input) => {
      const name = input.name as string;
      const role = input.role as string;
      const prompt = input.prompt as string;
      try {
        manager.spawn(name, role, prompt);
        return `Spawned teammate "${name}" (${role}) with task: ${prompt}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    },
  };
}

export function createSendMessageTool(manager: TeammateManager): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'send_message',
      description: 'Send a message to a teammate',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Teammate name' },
          content: { type: 'string', description: 'Message content' },
        },
        required: ['to', 'content'],
      },
    },
    executor: async (input) => {
      manager.messageBus.send('lead', input.to as string, input.content as string);
      return `Message sent to ${input.to}`;
    },
  };
}

export function createReadInboxTool(manager: TeammateManager): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'read_inbox',
      description: 'Read your inbox messages',
      parameters: { type: 'object', properties: {} },
    },
    executor: async () => {
      const messages = manager.messageBus.readInbox('lead');
      if (messages.length === 0) return 'No messages.';
      return messages.map(m => `[${m.from}]: ${m.content}`).join('\n');
    },
  };
}
