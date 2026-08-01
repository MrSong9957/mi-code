import { describe, it, expect } from 'vitest';
import { SessionAllowlist } from '../../permission/session-allowlist.js';

describe('SessionAllowlist', () => {
  it('exact match 命中', () => {
    const al = new SessionAllowlist();
    al.add('run_bash', { command: 'npm test' });
    expect(al.has('run_bash', { command: 'npm test' })).toBe(true);
  });

  it('不同 input 不命中(空格差异)', () => {
    const al = new SessionAllowlist();
    al.add('run_bash', { command: 'npm  test' });
    expect(al.has('run_bash', { command: 'npm test' })).toBe(false);
  });

  it('不同 toolName 不命中', () => {
    const al = new SessionAllowlist();
    al.add('write_file', { path: 'a.txt', content: 'x' });
    expect(al.has('edit_file', { path: 'a.txt', content: 'x' })).toBe(false);
  });

  it('clear 后清空', () => {
    const al = new SessionAllowlist();
    al.add('run_bash', { command: 'npm test' });
    al.clear();
    expect(al.has('run_bash', { command: 'npm test' })).toBe(false);
  });

  it('新实例为空(跨会话不持久)', () => {
    const al1 = new SessionAllowlist();
    al1.add('run_bash', { command: 'npm test' });
    expect(new SessionAllowlist().has('run_bash', { command: 'npm test' })).toBe(false);
  });

  it('NUL 分隔:toolName 与 input 拼接无歧义', () => {
    const al = new SessionAllowlist();
    al.add('a', { x: '\u0000b' });
    expect(al.has('a', { x: '\u0000b' })).toBe(true);
    expect(al.has('a\u0000b', {})).toBe(false);
  });
});
