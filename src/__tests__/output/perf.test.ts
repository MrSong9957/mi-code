import { describe, it, expect } from 'vitest';
import { OutputGate } from '../../output/output-gate.js';
import { MessageQueue } from '../../output/message-queue.js';
import { StylePool } from '../../output/style-pool.js';
import { Encoder } from '../../output/encoder.js';

describe('OutputGate Performance', () => {
  describe('MessageQueue throughput', () => {
    it('should enqueue 10000 messages quickly', () => {
      const queue = new MessageQueue();
      const start = performance.now();

      for (let i = 0; i < 10000; i++) {
        queue.enqueue({
          type: 'system',
          content: `message ${i}`,
          priority: 0,
        });
      }

      const elapsed = performance.now() - start;
      console.log(`Enqueue 10000 messages: ${elapsed.toFixed(2)}ms`);
      expect(queue.size).toBe(10000);
      expect(elapsed).toBeLessThan(1000); // 应该在 1 秒内完成
    });

    it('should dequeue 10000 messages quickly', () => {
      const queue = new MessageQueue();
      for (let i = 0; i < 10000; i++) {
        queue.enqueue({
          type: 'system',
          content: `message ${i}`,
          priority: 0,
        });
      }

      const start = performance.now();
      while (!queue.isEmpty) {
        queue.dequeue();
      }
      const elapsed = performance.now() - start;

      console.log(`Dequeue 10000 messages: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('StylePool cache', () => {
    it('should cache styles efficiently', () => {
      const pool = new StylePool();
      const style = { fg: 'red', bold: true };

      // 第一次获取
      const start1 = performance.now();
      for (let i = 0; i < 10000; i++) {
        pool.get(style);
      }
      const elapsed1 = performance.now() - start1;

      console.log(`StylePool.get 10000 times (cached): ${elapsed1.toFixed(2)}ms`);
      expect(elapsed1).toBeLessThan(100);
    });

    it('should handle many unique styles', () => {
      const pool = new StylePool();
      const start = performance.now();

      for (let i = 0; i < 1000; i++) {
        pool.get({ fg: `color${i}` });
      }

      const elapsed = performance.now() - start;
      console.log(`StylePool.get 1000 unique styles: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('Encoder.normalize', () => {
    it('should normalize 10000 strings quickly', () => {
      const start = performance.now();

      for (let i = 0; i < 10000; i++) {
        Encoder.normalize(`Hello\x00World ${i}`);
      }

      const elapsed = performance.now() - start;
      console.log(`Encoder.normalize 10000 strings: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('OutputGate.flush throughput', () => {
    it('should flush 1000 messages quickly', () => {
      const writer = () => {}; // 空 writer
      const gate = new OutputGate({ rows: 24, cols: 80, writer });

      for (let i = 0; i < 1000; i++) {
        gate.send('system', `message ${i}`);
      }

      const start = performance.now();
      gate.flush();
      const elapsed = performance.now() - start;

      console.log(`OutputGate.flush 1000 messages: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(100);
    });
  });
});
