import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { AskUserManager } from '../ask-user-manager.js';
import { serializeAskQuestionOutcome } from '../ask-user-serialization.js';
import { validateAskUserInput } from '../ask-user-validation.js';
import { askOutcomeStore } from '../ask-outcome-store.js';

export function createAskUserTool(
  mgr: AskUserManager,
): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'ask_user_question',
      description: [
        'Ask the user one to four questions and wait for their answers.',
        'Use this when you need clarification that code alone cannot provide.',
        'Use this only when an unresolved choice blocks the current task.',
        'Do not ask generic follow-up questions after completing the request.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'Questions to present to the user.',
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The full question text.',
                },
                header: {
                  type: 'string',
                  description: 'A short label for the question (up to 12 characters).',
                },
                options: {
                  type: 'array',
                  description: 'Two to four predefined choices.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Choice label.' },
                      description: { type: 'string', description: 'Choice explanation.' },
                    },
                    required: ['label', 'description'],
                  },
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Whether more than one option may be selected.',
                },
              },
              required: ['question', 'header', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
    executor: async (input, ctx) => {
      const validated = validateAskUserInput(input);
      if (!validated.ok) return `Error: ${validated.error}`;
      const outcome = await mgr.ask(validated.value);
      // AUTO-0025 Phase B (Task 9):meta 旁路生产端。
      // 拿到结构化 outcome 后,同时写两个通道:
      // - API 通道(return serialize 字符串,ToolResultBlock.content 不变)
      // - UI 通道(askOutcomeStore.set,供 streaming-query 阶段3 take 后结构化展示)
      // 两通道数据同源(outcome + request),互不污染。
      // ctx 由 Task 8 在所有 registry.execute 调用点透传;无 ctx 时不写 store(防御)。
      if (ctx) {
        askOutcomeStore.set(ctx.toolUseId, {
          version: 1,
          request: validated.value,
          outcome,
        });
      }
      return serializeAskQuestionOutcome(outcome);
    },
  };
}
