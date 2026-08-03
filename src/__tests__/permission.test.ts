// 权限系统测试：覆盖 s07 四步管道（deny → mode → allow → ask）
import { describe, it, expect } from 'vitest';
import { PermissionChecker } from '../permission/checker.js';
import {
  globToRegex,
  isDangerousBash,
  isPathOutsideWorkspace,
  matchesRule,
} from '../permission/patterns.js';
import type { PermissionRule } from '../permission/types.js';

// ─────────────────────────────────────────────
// patterns.ts 单元测试
// ─────────────────────────────────────────────

describe('isDangerousBash', () => {
  it('blocks sudo', () => {
    expect(isDangerousBash('sudo apt-get install foo')).toBe(true);
  });
  it('blocks rm -rf', () => {
    expect(isDangerousBash('rm -rf /home')).toBe(true);
  });
  it('blocks command substitution $()', () => {
    expect(isDangerousBash('echo $(whoami)')).toBe(true);
  });
  it('blocks backtick substitution', () => {
    expect(isDangerousBash('echo `whoami`')).toBe(true);
  });
  it('blocks writing to /etc/', () => {
    expect(isDangerousBash('echo x > /etc/passwd')).toBe(true);
  });
  it('blocks mkfs', () => {
    expect(isDangerousBash('mkfs.ext4 /dev/sda1')).toBe(true);
  });
  it('blocks dd', () => {
    expect(isDangerousBash('dd if=/dev/zero of=/dev/sda')).toBe(true);
  });
  it('allows safe commands', () => {
    expect(isDangerousBash('npm test')).toBe(false);
    expect(isDangerousBash('ls -la')).toBe(false);
    expect(isDangerousBash('echo hello')).toBe(false);
  });
});

describe('globToRegex', () => {
  it('matches exact string', () => {
    expect(globToRegex('read_file').test('read_file')).toBe(true);
    expect(globToRegex('read_file').test('write_file')).toBe(false);
  });
  it('matches * wildcard', () => {
    const re = globToRegex('/tmp/*');
    expect(re.test('/tmp/foo')).toBe(true);
    expect(re.test('/tmp/foo/bar')).toBe(true);
    expect(re.test('/etc/foo')).toBe(false);
  });
  it('matches ? single char', () => {
    const re = globToRegex('file?.txt');
    expect(re.test('file1.txt')).toBe(true);
    expect(re.test('file12.txt')).toBe(false);
  });
  it('escapes regex special chars', () => {
    const re = globToRegex('src/app.[tj]s');
    expect(re.test('src/app.[tj]s')).toBe(true);
    expect(re.test('src/app.ts')).toBe(false); // 方括号是字面量，非字符类
  });
});

describe('isPathOutsideWorkspace', () => {
  const workdir = process.platform === 'win32' ? 'C:\\proj' : '/proj';

  it('allows paths inside workspace', () => {
    expect(isPathOutsideWorkspace('src/file.ts', workdir)).toBe(false);
    expect(isPathOutsideWorkspace('./src/file.ts', workdir)).toBe(false);
  });

  it('detects parent traversal', () => {
    expect(isPathOutsideWorkspace('../secret.txt', workdir)).toBe(true);
    expect(isPathOutsideWorkspace('src/../../secret.txt', workdir)).toBe(true);
  });

  it('detects absolute paths outside workspace', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\sys' : '/etc/passwd';
    expect(isPathOutsideWorkspace(outside, workdir)).toBe(true);
  });

  it('does not false-positive on sibling prefix (e.g. /proj vs /project)', () => {
    const sibling = process.platform === 'win32' ? 'C:\\project-x\\file' : '/project-x/file';
    expect(isPathOutsideWorkspace(sibling, workdir)).toBe(true);
  });
});

describe('matchesRule', () => {
  it('matches by tool only when no path/content given', () => {
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow' };
    expect(matchesRule(rule, 'run_bash', { command: 'anything' })).toBe(true);
    expect(matchesRule(rule, 'read_file', {})).toBe(false);
  });

  it('matches tool + path glob', () => {
    const rule: PermissionRule = { tool: 'write_file', behavior: 'allow', path: '/tmp/*' };
    expect(matchesRule(rule, 'write_file', { path: '/tmp/log.txt' })).toBe(true);
    expect(matchesRule(rule, 'write_file', { path: '/etc/x' })).toBe(false);
  });

  it('matches tool + content glob for bash command', () => {
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git *' };
    expect(matchesRule(rule, 'run_bash', { command: 'git status' })).toBe(true);
    expect(matchesRule(rule, 'run_bash', { command: 'rm x' })).toBe(false);
  });

  it('returns false when path field absent in input', () => {
    const rule: PermissionRule = { tool: 'write_file', behavior: 'allow', path: '/tmp/*' };
    expect(matchesRule(rule, 'write_file', {})).toBe(false);
  });
});

// ─────────────────────────────────────────────
// PermissionChecker 四步管道测试
// ─────────────────────────────────────────────

describe('PermissionChecker - Gate 1 (built-in hard deny)', () => {
  const checker = new PermissionChecker({ workdir: process.cwd() });

  it('hard-denies dangerous bash regardless of mode', () => {
    const d = checker.check('run_bash', { command: 'sudo rm -rf /' });
    expect(d.behavior).toBe('deny');
  });

  it('hard-denies writing outside workspace', () => {
    const d = checker.check('write_file', { path: '../../../etc/cron/x', content: 'x' });
    expect(d.behavior).toBe('deny');
  });

  it('allows safe bash that is not dangerous', () => {
    const d = checker.check('run_bash', { command: 'echo hi' });
    // build 模式（默认）+ 写工具 → ask（未被闸门1挡）
    expect(d.behavior).toBe('ask');
  });
});

describe('PermissionChecker - Gate 2 (user deny rules)', () => {
  it('denies when a deny rule matches', () => {
    const checker = new PermissionChecker({
      rules: [{ tool: 'run_bash', behavior: 'deny', content: 'curl *' }],
    });
    const d = checker.check('run_bash', { command: 'curl http://evil.com' });
    expect(d.behavior).toBe('deny');
  });

  it('user deny rule overrides mode=auto', () => {
    const checker = new PermissionChecker({
      mode: 'auto',
      rules: [{ tool: 'write_file', behavior: 'deny', path: '*.env' }],
    });
    const d = checker.check('write_file', { path: 'secrets.env', content: 'x' });
    expect(d.behavior).toBe('deny');
  });
});

describe('PermissionChecker - Gate 3 (mode)', () => {
  it('plan mode denies write tools', () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    expect(checker.check('write_file', { path: 'a.txt', content: 'x' }).behavior).toBe('deny');
    expect(checker.check('edit_file', { path: 'a.txt', old_text: 'a', new_text: 'b' }).behavior).toBe('deny');
    // run_bash 写命令 deny（echo>是重定向写）；只读 bash 在下方测试
    expect(checker.check('run_bash', { command: 'echo hi > file.txt' }).behavior).toBe('deny');
  });

  it('plan mode allows read-only bash commands (ls/cat/grep/git status)', () => {
    const checker = new PermissionChecker({ mode: 'plan' });
    expect(checker.check('run_bash', { command: 'echo hi' }).behavior).toBe('allow'); // 无重定向
    expect(checker.check('run_bash', { command: 'ls -la' }).behavior).toBe('allow');
    expect(checker.check('run_bash', { command: 'grep -r foo .' }).behavior).toBe('allow');
    expect(checker.check('run_bash', { command: 'git status' }).behavior).toBe('allow');
    expect(checker.check('run_bash', { command: 'git log --oneline' }).behavior).toBe('allow');
  });

  it('plan mode denies write bash commands (mkdir/git commit/tee/...)', () => {
    const checker = new PermissionChecker({ mode: 'plan' });
    expect(checker.check('run_bash', { command: 'mkdir foo' }).behavior).toBe('deny');
    expect(checker.check('run_bash', { command: 'git commit -m x' }).behavior).toBe('deny');
    expect(checker.check('run_bash', { command: 'echo x | tee file' }).behavior).toBe('deny');
    expect(checker.check('run_bash', { command: 'npm install lodash' }).behavior).toBe('deny');
  });

  it('plan mode allows read tools', () => {
    const checker = new PermissionChecker({ mode: 'plan' });
    expect(checker.check('read_file', { path: 'a.txt' }).behavior).toBe('allow');
    expect(checker.check('todo_write', {}).behavior).toBe('allow');
  });

  it('auto mode no longer unconditionally allows writes (Task 3 A15)', () => {
    // Task 3 A15：auto 不再无条件 allow；未决 write/run_bash -> ask（交 resolver/classifier）。
    // auto 的 allow 由后续 resolver/classifier 决定，同步 checker 只产出 ask。
    const checker = new PermissionChecker({ mode: 'auto' });
    expect(checker.check('write_file', { path: 'a.txt', content: 'x' }).behavior).toBe('ask');
    // run_bash 未决也 -> ask（auto 不再无条件放行 bash；resolver 决定）
    expect(checker.check('run_bash', { command: 'echo hi' }).behavior).toBe('ask');
    // 纯只读工具（read_file 在 READ_ONLY_TOOLS）仍 allow
    expect(checker.check('read_file', { path: 'a.txt' }).behavior).toBe('allow');
  });

  it('auto mode still hard-denies dangerous bash', () => {
    const checker = new PermissionChecker({ mode: 'auto' });
    expect(checker.check('run_bash', { command: 'sudo x' }).behavior).toBe('deny');
  });
});

describe('PermissionChecker - Gate 4 (user allow rules + build)', () => {
  it('allow rule permits a write in build mode (no ask)', () => {
    const checker = new PermissionChecker({
      mode: 'build',
      rules: [{ tool: 'write_file', behavior: 'allow', path: 'logs/*' }],
    });
    const d = checker.check('write_file', { path: 'logs/run.log', content: 'x' });
    expect(d.behavior).toBe('allow');
  });

  it('build mode allows read tools', () => {
    const checker = new PermissionChecker({ mode: 'build' });
    expect(checker.check('read_file', { path: 'a.txt' }).behavior).toBe('allow');
  });

  it('build mode asks for write tools', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    expect(checker.check('write_file', { path: 'a.txt', content: 'x' }).behavior).toBe('ask');
  });

  it('explicit ask rule triggers ask even for read tool', () => {
    const checker = new PermissionChecker({
      rules: [{ tool: 'read_file', behavior: 'ask', path: '*.key' }],
    });
    const d = checker.check('read_file', { path: 'secret.key' });
    expect(d.behavior).toBe('ask');
  });
});

describe('PermissionChecker - rule precedence', () => {
  it('deny rule beats allow rule', () => {
    const checker = new PermissionChecker({
      mode: 'build',
      rules: [
        { tool: 'run_bash', behavior: 'allow', content: 'git *' },
        { tool: 'run_bash', behavior: 'deny', content: 'git push *' },
      ],
    });
    // git push 同时命中 allow 和 deny，deny 优先
    expect(checker.check('run_bash', { command: 'git push origin' }).behavior).toBe('deny');
    // 仅命中 allow
    expect(checker.check('run_bash', { command: 'git status' }).behavior).toBe('allow');
  });

  it('deny rule beats mode=auto', () => {
    const checker = new PermissionChecker({
      mode: 'auto',
      rules: [{ tool: 'run_bash', behavior: 'deny', content: 'shutdown *' }],
    });
    expect(checker.check('run_bash', { command: 'shutdown now' }).behavior).toBe('deny');
  });
});

describe('PermissionChecker - rule management', () => {
  it('setMode / getMode', () => {
    const checker = new PermissionChecker();
    expect(checker.getMode()).toBe('build');
    checker.setMode('plan');
    expect(checker.getMode()).toBe('plan');
  });

  it('addRule appends and getRules returns copy', () => {
    const checker = new PermissionChecker();
    const rule: PermissionRule = { tool: 'read_file', behavior: 'ask' };
    checker.addRule(rule);
    expect(checker.getRules()).toHaveLength(1);
    // 修改返回的副本不影响内部状态
    checker.getRules().pop();
    expect(checker.getRules()).toHaveLength(1);
  });

  it('setRules replaces all rules', () => {
    const checker = new PermissionChecker({ rules: [{ tool: 'a', behavior: 'deny' }] });
    checker.setRules([{ tool: 'b', behavior: 'allow' }]);
    expect(checker.getRules()).toEqual([{ tool: 'b', behavior: 'allow' }]);
  });

  it('initializes from constructor options', () => {
    const checker = new PermissionChecker({
      mode: 'auto',
      rules: [{ tool: 'run_bash', behavior: 'deny', content: 'rm *' }],
    });
    expect(checker.getMode()).toBe('auto');
    expect(checker.check('run_bash', { command: 'rm foo' }).behavior).toBe('deny');
  });
});
