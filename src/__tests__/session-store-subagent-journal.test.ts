// SessionStore 子代理工作日志 sidecar 测试
//
// 物理本质:验证"会话日志本旁边新增的子代理专用流水账"。
// 主日志 <id>.jsonl 只存 Provider 可见的消息;子代理流水账
// subagents/<parentSessionId>/<executionId>.jsonl 独立存放,
// 每行一条 Message 记录,append-only,供子代理失败时恢复已完成的工作。
//
// 关键不变量:
//   - 增量追加:同一 journal 多次 checkpoint 同样的快照,只追加新消息(不重复)
//   - 无损恢复:load() 返回完整子代理 transcript
//   - 损坏尾部容忍:最后一行写入不完整时,前面的记录仍可读
//   - 兄弟隔离:同一 parent 下不同 executionId 写不同文件

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../session/store.js';
import type { Message } from '../agent/types.js';

describe('SessionStore subagent journal', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('appends only new messages and reloads the lossless child transcript', async () => {
    const base = await mkdtemp(join(tmpdir(), 'micode-subagent-'));
    dirs.push(base);
    const store = new SessionStore(base);
    const journal = store.createSubagentJournal('parent-1', 'child-1');
    const prompt: Message = { role: 'user', content: 'inspect' };
    const use: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
    };
    const result: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'important result' }],
    };

    await journal.checkpoint([prompt, use, result]);
    await journal.checkpoint([prompt, use, result]);

    expect(await journal.load()).toEqual([prompt, use, result]);
    expect(journal.reference).toBe(
      join(base, 'subagents', 'parent-1', 'child-1.jsonl'),
    );
    expect((await readFile(journal.reference, 'utf8')).trim().split('\n')).toHaveLength(3);
  });

  it('skips a corrupt trailing line and retains earlier valid records', async () => {
    const base = await mkdtemp(join(tmpdir(), 'micode-subagent-'));
    dirs.push(base);
    const store = new SessionStore(base);
    const journal = store.createSubagentJournal('parent-1', 'child-1');
    const prompt: Message = { role: 'user', content: 'inspect' };
    const use: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
    };
    const result: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'important result' }],
    };

    await journal.checkpoint([prompt, use, result]);
    // 追加一行损坏 JSON(模拟崩溃时部分写入)
    await appendFile(journal.reference, '{broken\n', 'utf8');

    expect(await journal.load()).toEqual([prompt, use, result]);
  });

  it('skips a partial JSON write tail and retains earlier valid records', async () => {
    const base = await mkdtemp(join(tmpdir(), 'micode-subagent-'));
    dirs.push(base);
    const store = new SessionStore(base);
    const partial = store.createSubagentJournal('parent-1', 'child-partial');
    const prompt: Message = { role: 'user', content: 'inspect' };
    const use: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } }],
    };
    const result: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'important result' }],
    };

    await partial.checkpoint([prompt, use, result]);
    // 追加一行"看起来像真实部分写入"的 JSON
    await appendFile(partial.reference, '{"role":"user","con', 'utf8');

    expect(await partial.load()).toEqual([prompt, use, result]);
  });

  it('isolates sibling children under the same parent session', async () => {
    const base = await mkdtemp(join(tmpdir(), 'micode-subagent-'));
    dirs.push(base);
    const store = new SessionStore(base);
    const childA = store.createSubagentJournal('parent-1', 'child-a');
    const childB = store.createSubagentJournal('parent-1', 'child-b');

    await Promise.all([
      childA.checkpoint([{ role: 'user', content: 'A' }]),
      childB.checkpoint([{ role: 'user', content: 'B' }]),
    ]);

    // 兄弟子代理写不同的文件
    expect(childA.reference).not.toBe(childB.reference);
    expect(await childA.load()).toEqual([{ role: 'user', content: 'A' }]);
    expect(await childB.load()).toEqual([{ role: 'user', content: 'B' }]);
  });
});
