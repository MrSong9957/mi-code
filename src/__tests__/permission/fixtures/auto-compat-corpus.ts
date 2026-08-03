// Task 14: Compatibility Corpus（A83）
//
// 覆盖计划规定的 legacy 行为基线：build read/write、plan read/write、
// 危险 Bash、工作区外路径、read-only bash、unknown tool。
// 不为让测试通过而改写基线语义——这些期望直接来自现有 PermissionChecker 行为。

import type { PermissionMode } from '../../../permission/types.js';

export interface CompatSample {
  readonly id: string;
  readonly mode: PermissionMode;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly expectedBehavior: 'allow' | 'deny' | 'ask';
}

export const AUTO_COMPAT_CORPUS: readonly CompatSample[] = [
  // ── build 模式基线 ──
  { id: 'build-read-file', mode: 'build', tool: 'read_file', input: { path: 'src/a.ts' }, expectedBehavior: 'allow' },
  { id: 'build-grep', mode: 'build', tool: 'grep', input: { pattern: 'x' }, expectedBehavior: 'allow' },
  { id: 'build-glob', mode: 'build', tool: 'glob', input: { pattern: '*.ts' }, expectedBehavior: 'allow' },
  { id: 'build-write-file', mode: 'build', tool: 'write_file', input: { path: 'src/a.ts', content: 'x' }, expectedBehavior: 'ask' },
  { id: 'build-edit-file', mode: 'build', tool: 'edit_file', input: { path: 'src/a.ts', old_text: 'a', new_text: 'b' }, expectedBehavior: 'ask' },
  // build 模式下 run_bash 非只读集合成员：默认 ask（除非有 user allow rule）
  { id: 'build-run-bash-safe', mode: 'build', tool: 'run_bash', input: { command: 'git status' }, expectedBehavior: 'ask' },
  { id: 'build-run-bash-dangerous', mode: 'build', tool: 'run_bash', input: { command: 'rm -rf /' }, expectedBehavior: 'deny' },
  { id: 'build-unknown-tool', mode: 'build', tool: 'foobar', input: {}, expectedBehavior: 'ask' },

  // ── plan 模式基线 ──
  { id: 'plan-read-file', mode: 'plan', tool: 'read_file', input: { path: 'src/a.ts' }, expectedBehavior: 'allow' },
  // plan 模式下 write_file 属于 WRITE_TOOLS → deny（plan 阻止写操作）
  { id: 'plan-write-file', mode: 'plan', tool: 'write_file', input: { path: 'src/a.ts', content: 'x' }, expectedBehavior: 'deny' },

  // ── auto 模式基线（Task 3 后：不再无条件 allow write） ──
  { id: 'auto-read-file', mode: 'auto', tool: 'read_file', input: { path: 'src/a.ts' }, expectedBehavior: 'allow' },
  { id: 'auto-write-file', mode: 'auto', tool: 'write_file', input: { path: 'src/a.ts', content: 'x' }, expectedBehavior: 'ask' },
  // auto 模式下 run_bash 非只读集合成员：默认 ask（Task 3 移除了无条件 allow）
  { id: 'auto-run-bash-safe', mode: 'auto', tool: 'run_bash', input: { command: 'git status' }, expectedBehavior: 'ask' },
  { id: 'auto-run-bash-dangerous', mode: 'auto', tool: 'run_bash', input: { command: 'rm -rf /' }, expectedBehavior: 'deny' },

  // ── 安全约束（跨 mode） ──
  { id: 'build-protected-settings', mode: 'build', tool: 'write_file', input: { path: '.micode/config.json', content: 'x' }, expectedBehavior: 'ask' },
  { id: 'build-git-config', mode: 'build', tool: 'write_file', input: { path: '.git/config', content: 'x' }, expectedBehavior: 'ask' },

  // ── 动态注入危险命令 ──
  { id: 'build-dynamic-injection', mode: 'build', tool: 'run_bash', input: { command: 'echo $(whoami)' }, expectedBehavior: 'deny' },
  { id: 'build-fork-bomb', mode: 'build', tool: 'run_bash', input: { command: ':(){ :|:& };:' }, expectedBehavior: 'deny' },
] as const;
