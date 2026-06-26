// LLM 客户端抽象：mock 实现，后续接入真实 API
import type { LLMClient, Message, ToolDefinition, ModelResponse, ContentBlock } from './types.js';

/** Mock LLM 客户端（用于开发和测试） */
export class MockLLMClient implements LLMClient {
  private responseIndex = 0;

  // 预设的响应序列（用于测试循环）
  private responses: ModelResponse[] = [];

  // 预设的异常序列（用于测试错误恢复）
  private errors: Error[] = [];
  private errorIndex = 0;

  /** 设置预设响应 */
  setResponses(responses: ModelResponse[]): void {
    this.responses = responses;
    this.responseIndex = 0;
  }

  /** 设置预设异常（模拟 API 错误） */
  setThrowOnCreate(errors: Error[]): void {
    this.errors = errors;
    this.errorIndex = 0;
  }

  async create(messages: Message[], _tools: ToolDefinition[]): Promise<ModelResponse> {
    // 如果有预设异常，按顺序抛出
    if (this.errorIndex < this.errors.length) {
      throw this.errors[this.errorIndex++]!;
    }

    // 如果有预设响应，按顺序返回
    if (this.responseIndex < this.responses.length) {
      return this.responses[this.responseIndex++]!;
    }

    // 默认：返回纯文本响应（结束循环）
    const lastMessage = messages[messages.length - 1];
    const content: ContentBlock[] = [{
      type: 'text',
      text: `Mock response to: ${this.extractText(lastMessage)}`,
    }];

    return {
      content,
      stop_reason: 'end_turn',
    };
  }

  private extractText(message: Message | undefined): string {
    if (!message) return 'empty';
    if (typeof message.content === 'string') return message.content;
    const textBlock = message.content.find(b => b.type === 'text');
    return textBlock && 'text' in textBlock ? textBlock.text : 'complex content';
  }
}

/** 创建 mock 客户端 */
export function createMockClient(): LLMClient {
  return new MockLLMClient();
}
