// ask_user_question 工具：让 AI 能向用户提问并等待回答
//
// 物理本质：举手向用户提问。executor 一进来就把问题递给 AskUserManager
// （后者贴到消息区 + 页脚提示），然后 await 等用户回话。
// 用户回车提交时 handleInput 检测到 pending，把 input 喂给这个挂起的 Promise，
// executor 拿到答案返回 → 包成 tool_result → 下一轮 AI 看到答案继续。

import { randomUUID } from 'crypto';
import type { ToolDefinition, ToolExecutor } from '../types.js';
import type { AskUserManager } from '../ask-user-manager.js';

export function createAskUserTool(mgr: AskUserManager): { definition: ToolDefinition; executor: ToolExecutor } {
  return {
    definition: {
      name: 'ask_user_question',
      description: [
        'Ask the user a question and wait for their answer.',
        'Use this when you need clarification that code alone cannot provide',
        '(requirements, preferences, tradeoffs, edge case priorities).',
        'The user\'s answer is returned as the tool result text.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the user. Be specific and end with a question mark.',
          },
          header: {
            type: 'string',
            description: 'Short label for the question (max ~12 chars), shown in the status hint.',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional predefined choices. If provided, the user can pick by number or type freely.',
          },
        },
        required: ['question'],
      },
    },
    executor: async (input) => {
      const question = (input.question as string)?.trim();
      if (!question) {
        return 'Error: question is required';
      }
      const answer = await mgr.ask({
        id: randomUUID(),
        header: (input.header as string) || 'Question',
        question,
        options: Array.isArray(input.options) ? (input.options as string[]) : undefined,
      });
      return answer || '(no answer)';
    },
  };
}
