// 记忆工具：让 LLM 能读写持久化记忆
import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { MemoryManager } from '../../memory/memory-manager.js';

export function createMemoryWriteTool(memory: MemoryManager): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'memory_write',
      description: 'Write a persistent memory (user preference, feedback, project fact, or reference). Survives across sessions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Memory name (becomes filename)' },
          type: { type: 'string', description: 'Type: user, feedback, project, reference' },
          description: { type: 'string', description: 'One-line summary' },
          body: { type: 'string', description: 'Full memory content' },
        },
        required: ['name', 'type', 'description', 'body'],
      },
    },
    executor: async (input) => {
      const type = input.type as string;
      if (!['user', 'feedback', 'project', 'reference'].includes(type)) {
        return 'Error: type must be one of: user, feedback, project, reference';
      }
      memory.write(input.name as string, type as 'user' | 'feedback' | 'project' | 'reference', input.description as string, input.body as string);
      return `Memory "${input.name}" saved.`;
    },
  };
}

export function createMemoryReadTool(memory: MemoryManager): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'memory_read',
      description: 'Read a specific memory by name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Memory name to read' },
        },
        required: ['name'],
      },
    },
    executor: async (input) => {
      const slug = (input.name as string).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
      const content = memory.read(slug);
      if (!content) return `Error: Memory "${input.name}" not found.`;
      return content;
    },
  };
}

export function createMemoryListTool(memory: MemoryManager): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'memory_list',
      description: 'List all persistent memories.',
      parameters: { type: 'object', properties: {} },
    },
    executor: async () => {
      const entries = memory.list();
      if (entries.length === 0) return 'No memories recorded yet.';
      return entries.map(e => `- ${e.name} (${e.type}): ${e.description}`).join('\n');
    },
  };
}
