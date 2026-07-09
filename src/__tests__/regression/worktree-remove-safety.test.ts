// 回归测试：worktree 删除时未提交改动保护（worktree-tool.ts）
//
// 物理本质：销毁仓库货架前要"清点有没有遗落的快递"。
//   safeRemove：清点了——发现有未提交改动就拒绝删除（除非显式 discardChanges=true）。正确。
//   remove：没清点——直接 git worktree remove，未提交改动可能丢失。危险。
//
// 风险等级：🔴 数据（丢未提交代码）
// 出错后果：worktree-tool.ts:82-86 的 remove action 在 discardChanges 未传时走 remove()，
//   用户/AI 误删带未提交改动的 worktree，代码丢失且不可逆。
//
// 测试策略：
//   - 正向基线：safeRemove(discardChanges=false) 拒绝删脏 worktree（必须常绿）
//   - 正向基线：safeRemove(discardChanges=true) 强制删除
//   - 缺口锁定：worktree-tool remove action 不传 discardChanges 时应走 safeRemove 保护，
//     但当前走 remove()——用 it.fails 锁定"应被保护但没保护"

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorktreeManager } from '../../../src/worktree/worktree-manager.js';
import { createWorktreeTool } from '../../../src/agent/tools/worktree-tool.js';

function makeTmpGitRepo(): string {
  const dir = join(tmpdir(), `wt-rmsafety-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  // 必须有至少一个 commit，否则 worktree add 会失败
  execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('worktree 删除安全性回归', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = makeTmpGitRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  // ── 正向基线：safeRemove 保护脏 worktree ──

  it('safeRemove(false)：脏 worktree 拒绝删除，返回 Refused', () => {
    const manager = new WorktreeManager(repoDir);
    const record = manager.create('dirty-wt', 'task-1');

    // 在 worktree 内制造未提交改动
    const uncommittedFile = join(record.path, 'uncommitted.txt');
    writeFileSync(uncommittedFile, 'important code');

    const result = manager.safeRemove('dirty-wt', false);
    expect(result).toContain('Refused');
    // worktree 目录仍在，文件保住
    expect(existsSync(uncommittedFile)).toBe(true);
  });

  it('safeRemove(true)：脏 worktree 强制删除', () => {
    const manager = new WorktreeManager(repoDir);
    const record = manager.create('force-wt', 'task-2');
    writeFileSync(join(record.path, 'tmp.txt'), 'x');

    const result = manager.safeRemove('force-wt', true);
    expect(result).toContain('removed');
  });

  it('safeRemove(false)：干净 worktree 正常删除', () => {
    const manager = new WorktreeManager(repoDir);
    manager.create('clean-wt', 'task-3');
    const result = manager.safeRemove('clean-wt', false);
    expect(result).toContain('removed');
  });

  // ── 缺口锁定：worktree-tool remove action ──
  //
  // worktree-tool.ts:82-86：discardChanges === undefined 时走 remove()（非 safe 版本）。
  // 理想行为：未传 discardChanges 应走 safeRemove，返回清晰的 "Refused" 提示。
  // 当前：走 remove() → git worktree remove 遇脏 worktree 抛错 →
  //   工具捕获返回 "Error: Command failed: git worktree remove..."。
  //   虽然文件因 git 自身保护没丢，但错误信息对用户/AI 极不友好（缺口本质）。
  // it.fails 锁定"应返回 Refused"——修复后（统一走 safeRemove）删 .fails。
  it.fails('worktree-tool remove（不传 discardChanges）应返回友好 Refused [已知缺口：当前抛 git 错误]', async () => {
    const manager = new WorktreeManager(repoDir);
    const tool = createWorktreeTool(manager);
    const record = manager.create('tool-dirty', 'task-4');

    const uncommittedFile = join(record.path, 'uncommitted.txt');
    writeFileSync(uncommittedFile, 'critical');

    // 理想：未传 discardChanges 等价于 safeRemove(false)，返回 Refused
    const result = await tool.executor({ action: 'remove', name: 'tool-dirty' });
    expect(result).toContain('Refused');
    expect(existsSync(uncommittedFile)).toBe(true);
  });

  // 现状锁定（非 fails）：确认当前走 remove() 路径——git 抛错，返回 Error 文本
  it('worktree-tool remove 现状：不传 discardChanges 时走 remove()，返回 git 错误而非 Refused', async () => {
    const manager = new WorktreeManager(repoDir);
    const tool = createWorktreeTool(manager);
    const record = manager.create('tool-dirty2', 'task-5');

    const uncommittedFile = join(record.path, 'uncommitted.txt');
    writeFileSync(uncommittedFile, 'critical');

    const result = await tool.executor({ action: 'remove', name: 'tool-dirty2' });
    // 现状：git worktree remove 遇脏 worktree 失败，工具捕获返回 Error
    expect(result).toContain('Error');
    // git 自身保护：文件实际没丢（但错误信息不友好，这是缺口）
    expect(existsSync(uncommittedFile)).toBe(true);
  });

  it('worktree-tool remove（传 discardChanges=false）：走 safeRemove 保护', async () => {
    const manager = new WorktreeManager(repoDir);
    const tool = createWorktreeTool(manager);
    const record = manager.create('tool-safe', 'task-6');
    const uncommittedFile = join(record.path, 'u.txt');
    writeFileSync(uncommittedFile, 'x');

    const result = await tool.executor({
      action: 'remove',
      name: 'tool-safe',
      discardChanges: false,
    });
    expect(result).toContain('Refused');
    expect(existsSync(uncommittedFile)).toBe(true);
  });
});
