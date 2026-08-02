// src/__tests__/agent/model-message-sanitizer.test.ts
//
// sanitizeMessagesForModel:剔除 uiOnly text block,保留其余,空 message 删除。
// 唯一职责:把含 uiOnly 内部标记的 messages 转为 provider 可见的标准 messages。

import { describe, it, expect } from 'vitest';
import { sanitizeMessagesForModel } from '../../agent/model-message-sanitizer.js';
import type { Message } from '../../agent/types.js';

describe('sanitizeMessagesForModel', () => {

  it('mixed content:只删除 uiOnly block,保留其他,顺序不变', () => {
    const input: Message[] = [{
      role: 'assistant',
      content: [
        { type: 'text', text: '正文A' },
        { type: 'text', text: '状态块', uiOnly: true },
        { type: 'text', text: '正文B' },
      ],
    }];
    const out = sanitizeMessagesForModel(input);
    expect(out[0].content).toEqual([
      { type: 'text', text: '正文A' },
      { type: 'text', text: '正文B' },
    ]);
  });

  it('uiOnly-only assistant:整条 message 删除', () => {
    const input: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: '状态块', uiOnly: true }] },
      { role: 'user', content: 'bye' },
    ];
    const out = sanitizeMessagesForModel(input);
    expect(out).toHaveLength(2);
    expect(out.map(m => m.role)).toEqual(['user', 'user']);
  });

  it('tool_use + uiOnly:保留 tool_use,删除 uiOnly', () => {
    const input: Message[] = [{
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a' } },
        { type: 'text', text: '状态块', uiOnly: true },
      ],
    }];
    const out = sanitizeMessagesForModel(input);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'a' } },
    ]);
  });

  it('string content:原样保留', () => {
    const input: Message[] = [{ role: 'user', content: '纯文本消息' }];
    const out = sanitizeMessagesForModel(input);
    expect(out).toEqual(input);
  });

  it('输入对象不被 mutation', () => {
    const input: Message[] = [{
      role: 'assistant',
      content: [
        { type: 'text', text: '正文' },
        { type: 'text', text: '状态块', uiOnly: true },
      ],
    }];
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeMessagesForModel(input);
    expect(input).toEqual(snapshot); // 输入未被修改
  });

  it('sanitizer 输出不含 uiOnly metadata', () => {
    const input: Message[] = [{
      role: 'assistant',
      content: [
        { type: 'text', text: '正文' },
        { type: 'text', text: '状态块', uiOnly: true },
      ],
    }];
    const out = sanitizeMessagesForModel(input);
    const json = JSON.stringify(out);
    expect(json).not.toContain('uiOnly'); // 输出彻底无 uiOnly 字段
  });

  it('无 uiOnly 的 messages 原样通过(深拷贝)', () => {
    const input: Message[] = [{
      role: 'assistant',
      content: [{ type: 'text', text: '正常正文' }],
    }];
    const out = sanitizeMessagesForModel(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input); // 新对象(非同一引用)
  });

  it('tool_result 消息保留(user role 含 tool_result block)', () => {
    const input: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
    ];
    const out = sanitizeMessagesForModel(input);
    expect(out).toEqual(input);
  });
});
