import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from '../../output/message-queue.js';
import { MessagePriority } from '../../output/types.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  describe('enqueue', () => {
    it('should add message to queue', () => {
      queue.enqueue({
        type: 'system',
        content: 'test',
        priority: MessagePriority.SYSTEM,
      });
      expect(queue.size).toBe(1);
    });

    it('should generate unique id', () => {
      const msg1 = queue.enqueue({ type: 'system', content: 'a', priority: MessagePriority.SYSTEM });
      const msg2 = queue.enqueue({ type: 'system', content: 'b', priority: MessagePriority.SYSTEM });
      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('dequeue', () => {
    it('should return messages in priority order', () => {
      queue.enqueue({ type: 'system', content: 'low', priority: MessagePriority.SYSTEM });
      queue.enqueue({ type: 'error', content: 'high', priority: MessagePriority.ERROR });
      queue.enqueue({ type: 'assistant', content: 'mid', priority: MessagePriority.ASSISTANT });

      expect(queue.dequeue()?.content).toBe('high');
      expect(queue.dequeue()?.content).toBe('mid');
      expect(queue.dequeue()?.content).toBe('low');
    });

    it('should return undefined when empty', () => {
      expect(queue.dequeue()).toBeUndefined();
    });
  });

  describe('peek', () => {
    it('should return next message without removing', () => {
      queue.enqueue({ type: 'system', content: 'test', priority: MessagePriority.SYSTEM });
      expect(queue.peek()?.content).toBe('test');
      expect(queue.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all messages', () => {
      queue.enqueue({ type: 'system', content: 'a', priority: MessagePriority.SYSTEM });
      queue.enqueue({ type: 'system', content: 'b', priority: MessagePriority.SYSTEM });
      queue.clear();
      expect(queue.size).toBe(0);
    });
  });

  describe('isEmpty', () => {
    it('should return true when empty', () => {
      expect(queue.isEmpty).toBe(true);
    });

    it('should return false when has messages', () => {
      queue.enqueue({ type: 'system', content: 'test', priority: MessagePriority.SYSTEM });
      expect(queue.isEmpty).toBe(false);
    });
  });
});
