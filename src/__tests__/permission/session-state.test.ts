// src/__tests__/permission/session-state.test.ts
//
// 阻断 B 结构防护:SessionState 是唯一的 session mutation boundary。
// 调用方不能直接赋值 sessionId 绕过 transition;任何切换都必须经 transitionTo,
// 由它统一负责 id 更新 + session 级状态清空。

import { describe, it, expect } from 'vitest';
import { SessionState } from '../../permission/session-state.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';

describe('SessionState(唯一 session mutation boundary)', () => {
  const input = { path: 'x.txt', content: 'y' };

  it('构造时 currentId = 初始 id', () => {
    const al = new SessionAllowlist();
    const s = new SessionState(al, 'init-1');
    expect(s.currentId).toBe('init-1');
  });

  it('transitionTo(不同 id)→ currentId 更新 + allowlist clear', () => {
    const al = new SessionAllowlist();
    al.add('write_file', input);
    expect(al.has('write_file', input)).toBe(true);

    const s = new SessionState(al, 'old');
    s.transitionTo('new');

    expect(s.currentId).toBe('new'); // ★ id 更新
    expect(al.has('write_file', input)).toBe(false); // ★ clear
  });

  it('transitionTo(相同 id)→ currentId 不变 + allowlist 保留', () => {
    const al = new SessionAllowlist();
    al.add('write_file', input);
    const s = new SessionState(al, 'same');
    s.transitionTo('same');

    expect(s.currentId).toBe('same');
    expect(al.has('write_file', input)).toBe(true); // ★ 保留(同 session)
  });

  it('多次 transition:每次 id 变化都 clear', () => {
    const al = new SessionAllowlist();
    const s = new SessionState(al, 'a');
    al.add('write_file', { path: '1' });
    s.transitionTo('b'); // a→b clear
    expect(al.has('write_file', { path: '1' })).toBe(false);

    al.add('write_file', { path: '2' });
    s.transitionTo('b'); // b→b 不 clear
    expect(al.has('write_file', { path: '2' })).toBe(true);

    s.transitionTo('c'); // b→c clear
    expect(al.has('write_file', { path: '2' })).toBe(false);
    expect(s.currentId).toBe('c');
  });

  it('currentId 是只读 getter(无 setter,结构上禁止直接赋值)', () => {
    const al = new SessionAllowlist();
    const s = new SessionState(al, 'x');
    // currentId 只有 getter,TypeScript 层面禁止 s.currentId = 'y'
    // 此测试锁定 getter 存在;真正的禁止由 TypeScript 编译期保障(无 setter)
    expect(s.currentId).toBe('x');
    expect(typeof s.transitionTo).toBe('function');
  });
});
