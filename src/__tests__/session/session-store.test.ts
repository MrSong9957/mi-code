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

  // ═══════════════════════════════════════════
  // Wave B Task 13 (M-066): pending-decision sidecar 持久化
  // ═══════════════════════════════════════════
  // 物理本质:会话日志本旁边的"待审单据夹"。
  // 主会话日志 <id>.jsonl 只存 Provider 可见的消息;
  // 待审决策单 <id>.pending-decisions.jsonl 单独存放,绝不相混。
  // resume 时读出 awaiting_user 状态的单据(本次 Wave B 仅记录,不重放——见 index.ts)。
  describe('pending decisions sidecar', () => {
    it('appendPendingDecision 写入 <id>.pending-decisions.jsonl,与主日志隔离', async () => {
      const sid = 'sess-pending-1';
      // 同时写主日志与 sidecar
      await store.append(sid, { role: 'user', content: 'hello' });
      await store.appendPendingDecision(sid, {
        decision_id: 'd1',
        action_snapshot_id: 'snap1',
        session_id: sid,
        status: 'awaiting_user',
        created_at: '2026-07-26T00:00:00Z',
        resolved_at: null,
        user_decision_ref: null,
      });

      // 主日志读不出 pending(隔离)
      const messages = await store.load(sid);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.content).toBe('hello');

      // sidecar 文件存在且独立
      const sidecarPath = join(tempDir, 'sessions', `${sid}.pending-decisions.jsonl`);
      expect(existsSync(sidecarPath)).toBe(true);
    });

    it('loadPendingDecisions 读回所有 pending 记录', async () => {
      const sid = 'sess-pending-2';
      await store.appendPendingDecision(sid, {
        decision_id: 'd1', action_snapshot_id: 's1', session_id: sid,
        status: 'awaiting_user', created_at: 't1', resolved_at: null, user_decision_ref: null,
      });
      await store.appendPendingDecision(sid, {
        decision_id: 'd2', action_snapshot_id: 's2', session_id: sid,
        status: 'approved_once', created_at: 't2', resolved_at: 't3', user_decision_ref: 'ud2',
      });

      const pendings = await store.loadPendingDecisions(sid);
      expect(pendings).toHaveLength(2);
      expect(pendings[0]!.decision_id).toBe('d1');
      expect(pendings[0]!.status).toBe('awaiting_user');
      expect(pendings[1]!.decision_id).toBe('d2');
      expect(pendings[1]!.status).toBe('approved_once');
    });

    it('loadPendingDecisions 不存在 → 空数组', async () => {
      const pendings = await store.loadPendingDecisions('nonexistent');
      expect(pendings).toEqual([]);
    });

    it('主日志 load() 绝不读 sidecar 文件', async () => {
      const sid = 'sess-isolation';
      // 不写任何主日志,只写 sidecar
      await store.appendPendingDecision(sid, {
        decision_id: 'd1', action_snapshot_id: 's1', session_id: sid,
        status: 'awaiting_user', created_at: 't1', resolved_at: null, user_decision_ref: null,
      });
      // 主日志 load 应返回空(sidecar 不污染主日志)
      const messages = await store.load(sid);
      expect(messages).toEqual([]);
    });

    it('list() 只统计 .jsonl 主日志,不统计 .pending-decisions.jsonl', async () => {
      const sid = 'sess-list-filter';
      await store.appendPendingDecision(sid, {
        decision_id: 'd1', action_snapshot_id: 's1', session_id: sid,
        status: 'awaiting_user', created_at: 't1', resolved_at: null, user_decision_ref: null,
      });
      const list = await store.list();
      // 只有 sidecar 文件,没有主日志 → 不应被当作会话列出
      expect(list.find(s => s.id === sid)).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════
  // Wave G Task 2 (GRC-1 §7.21~§7.23): reconstruction sidecar 隔离不变量
  // ═══════════════════════════════════════════
  // 物理本质:重建账本 <id>.reconstruction.jsonl 必须与主日志严格隔离 ——
  // list() / load() / loadSync() / getLastSessionId / getLastSessionIdSync()
  // 绝不读 reconstruction.jsonl,否则会把"重建尝试"误算成会话或消息。
  describe('reconstruction sidecar isolation', () => {
    it('list() 只统计 .jsonl 主日志,不统计 .reconstruction.jsonl', async () => {
      const sid = 'sess-recon-list';
      // 只写 reconstruction sidecar,不写主日志
      await store.savePreCompactSnapshot(
        {
          precompact_protocol_version: 'mi.precompact/1',
          precompact_snapshot_id: 'precompact-1',
          session_id: sid,
          session_snapshot_id: 'ctx-1',
          pinned_working_set_refs: ['ws-1'],
          eviction_frontier_ref: 'ef-1',
          captured_at: '2026-07-26T00:00:00Z',
        },
        sid,
      );
      const list = await store.list();
      expect(list.find(s => s.id === sid)).toBeUndefined();
    });

    it('主日志 load() 绝不读 reconstruction sidecar', async () => {
      const sid = 'sess-recon-load-iso';
      await store.savePreCompactSnapshot(
        {
          precompact_protocol_version: 'mi.precompact/1',
          precompact_snapshot_id: 'precompact-1',
          session_id: sid,
          session_snapshot_id: 'ctx-1',
          pinned_working_set_refs: ['ws-1'],
          eviction_frontier_ref: 'ef-1',
          captured_at: '2026-07-26T00:00:00Z',
        },
        sid,
      );
      const messages = await store.load(sid);
      expect(messages).toEqual([]);
    });

    it('reconstruction sidecar 文件落在 <dir>/sessions/<id>.reconstruction.jsonl', async () => {
      const sid = 'sess-recon-path';
      await store.savePreCompactSnapshot(
        {
          precompact_protocol_version: 'mi.precompact/1',
          precompact_snapshot_id: 'precompact-1',
          session_id: sid,
          session_snapshot_id: 'ctx-1',
          pinned_working_set_refs: ['ws-1'],
          eviction_frontier_ref: 'ef-1',
          captured_at: '2026-07-26T00:00:00Z',
        },
        sid,
      );
      const sidecarPath = join(tempDir, 'sessions', `${sid}.reconstruction.jsonl`);
      expect(existsSync(sidecarPath)).toBe(true);
    });
  });
});
