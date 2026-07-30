import { describe, expect, it } from 'vitest';
import { MessageQueue } from '../output/message-queue.js';
import { MessagePriority } from '../output/types.js';

describe('tool message priority', () => {
  it('keeps tool call and result at the same priority in FIFO order', () => {
    expect(MessagePriority.TOOL_CALL).toBe(3);
    expect(MessagePriority.TOOL_RESULT).toBe(MessagePriority.TOOL_CALL);

    const queue = new MessageQueue();
    queue.enqueue({
      type: 'tool_call',
      content: 'call',
      priority: MessagePriority.TOOL_CALL,
    });
    queue.enqueue({
      type: 'tool_result',
      content: 'result',
      priority: MessagePriority.TOOL_RESULT,
    });

    expect(queue.dequeue()?.type).toBe('tool_call');
    expect(queue.dequeue()?.type).toBe('tool_result');
  });
});
