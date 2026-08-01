// src/__tests__/permission/session-lifecycle.test.ts
//
// 阻断 B wiring 契约:sessionId 真正变化时必须 clear allowlist。
//
// 旧测试只测 SessionAllowlist.clear() 行为,无法防"生产路径删掉 clear() 调用"的回归。
// 本测试锁定真实 lifecycle helper:transitionSessionId(oldId, newId, allowlist) ——
// sessionId 变化才 clear,不变则保留。

import { describe, it, expect } from 'vitest';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { transitionSessionId } from '../../permission/session-lifecycle.js';

describe('transitionSessionId(session lifecycle helper)', () => {
  const input = { path: 'x.txt', content: 'y' };

  it('sessionId 变化(不同)→ allowlist clear,返回 newId', () => {
    const al = new SessionAllowlist();
    al.add('write_file', input);
    expect(al.has('write_file', input)).toBe(true);

    const result = transitionSessionId('session-old', 'session-new', al);
    expect(result).toBe('session-new'); // 返回 newId(供调用方赋值)
    expect(al.has('write_file', input)).toBe(false); // ★ 清空了
  });

  it('sessionId 不变(相同)→ allowlist 保留,返回原 id', () => {
    const al = new SessionAllowlist();
    al.add('write_file', input);
    expect(al.has('write_file', input)).toBe(true);

    const result = transitionSessionId('session-same', 'session-same', al);
    expect(result).toBe('session-same');
    expect(al.has('write_file', input)).toBe(true); // ★ 保留(同 session)
  });

  it('空 allowlist 时 transition 不报错', () => {
    const al = new SessionAllowlist();
    const result = transitionSessionId('a', 'b', al);
    expect(result).toBe('b');
    expect(al.has('write_file', input)).toBe(false);
  });
});
