// 单测：session/store.ts —— 会话持久化（JSONL）
//
// 物理本质：会话日志本。每轮对话结束往本上 append 一条（user/assistant），
// resume 时翻开本子读出所有条目，把历史喂给模型继续对话。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../session/store.js';
import type { Message } from '../../agent/types.js';

describe('SessionStore', () => {
  let tempDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'micode-session-test-'));
    store = new SessionStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('append + load', () => {
    it('append 一条 user 消息后 load 能读回', async () => {
      const sid = 'test-session-1';
      const msg: Message = { role: 'user', content: '你好' };
      await store.append(sid, msg);
      const loaded = await store.load(sid);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.role).toBe('user');
      expect(loaded[0]!.content).toBe('你好');
    });

    it('append 多条消息按顺序读回', async () => {
      const sid = 'test-session-2';
      await store.append(sid, { role: 'user', content: '问题' });
      await store.append(sid, { role: 'assistant', content: '回答' });
      await store.append(sid, { role: 'user', content: '追问' });
      const loaded = await store.load(sid);
      expect(loaded).toHaveLength(3);
      expect(loaded[0]!.content).toBe('问题');
      expect(loaded[1]!.content).toBe('回答');
      expect(loaded[2]!.content).toBe('追问');
    });

    it('load 不存在的 session → 空数组', async () => {
      const loaded = await store.load('nonexistent');
      expect(loaded).toEqual([]);
    });

    it('assistant 带 ContentBlock[] 也能正确序列化/反序列化', async () => {
      const sid = 'test-session-3';
      const msg: Message = {
        role: 'assistant',
        content: [{ type: 'text', text: '结构化内容' }],
      };
      await store.append(sid, msg);
      const loaded = await store.load(sid);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.role).toBe('assistant');
      expect(Array.isArray(loaded[0]!.content)).toBe(true);
    });
  });

  describe('list', () => {
    it('列出所有会话（id + 首条用户输入 + 时间）', async () => {
      await store.append('s1', { role: 'user', content: '第一个问题' });
      await store.append('s2', { role: 'user', content: '第二个问题' });
      const list = await store.list();
      expect(list).toHaveLength(2);
      const ids = list.map(s => s.id);
      expect(ids).toContain('s1');
      expect(ids).toContain('s2');
      const s1 = list.find(s => s.id === 's1')!;
      expect(s1.firstUserInput).toBe('第一个问题');
    });

    it('空 store → 空列表', async () => {
      const list = await store.list();
      expect(list).toEqual([]);
    });

    it('list 按 mtime 降序（最近在前）', async () => {
      await store.append('old', { role: 'user', content: '旧的' });
      // 稍等确保 mtime 不同
      await new Promise(r => setTimeout(r, 50));
      await store.append('new', { role: 'user', content: '新的' });
      const list = await store.list();
      expect(list[0]!.id).toBe('new');
      expect(list[1]!.id).toBe('old');
    });
  });

  describe('session 文件路径', () => {
    it('文件路径为 <dir>/sessions/<id>.jsonl', async () => {
      const sid = 'path-test';
      await store.append(sid, { role: 'user', content: 'x' });
      const expectedPath = join(tempDir, 'sessions', `${sid}.jsonl`);
      expect(existsSync(expectedPath)).toBe(true);
    });
  });

  describe('getLastSessionId', () => {
    it('返回最近一个会话的 id', async () => {
      await store.append('first', { role: 'user', content: 'a' });
      await new Promise(r => setTimeout(r, 50));
      await store.append('second', { role: 'user', content: 'b' });
      const last = await store.getLastSessionId();
      expect(last).toBe('second');
    });

    it('无会话 → null', async () => {
      const last = await store.getLastSessionId();
      expect(last).toBeNull();
    });
  });
});
