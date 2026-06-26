// load_skill 工具：让 LLM 能按需加载技能完整内容
import type { ToolDefinition, ToolExecutor } from '../../agent/types.js';
import type { SkillRegistry } from '../registry.js';

export function createLoadSkillTool(registry: SkillRegistry): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'load_skill',
      description: 'Load a skill document by name. Use this when you need detailed instructions for a specific task.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The skill name to load',
          },
        },
        required: ['name'],
      },
    },
    executor: async (input) => {
      const name = input.name as string;
      return registry.loadFullText(name);
    },
  };
}
