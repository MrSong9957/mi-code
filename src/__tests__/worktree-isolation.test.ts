// Worktree 隔离测试（s18）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorktreeManager } from '../worktree/worktree-manager.js';

function makeTmpGitRepo(): string {
  const dir = join(tmpdir(), `wt-iso-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('WorktreeManager - s18 隔离扩展', () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoDir = makeTmpGitRepo();
    manager = new WorktreeManager(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('bind: 绑定已有 worktree 到任务', () => {
    manager.create('wt-a', 'task-1');
    const bound = manager.bind('wt-a', 'task-2');
    expect(bound.taskId).toBe('task-2');
    expect(manager.getByTask('task-2')?.name).toBe('wt-a');
  });

  it('bind: 不存在的 worktree 抛错', () => {
    expect(() => manager.bind('ghost', 'task-1')).toThrow('not found');
  });

  it('getByName: 按名称查找', () => {
    manager.create('find-me', 'task-1');
    expect(manager.getByName('find-me')?.name).toBe('find-me');
  });

  it('getByName: 不存在返回 null', () => {
    expect(manager.getByName('nope')).toBeNull();
  });

  it('safeRemove: 有未提交改动时拒绝删除', () => {
    const record = manager.create('dirty-wt', 'task-1');
    writeFileSync(join(record.path, 'dirty.txt'), 'uncommitted');

    const result = manager.safeRemove('dirty-wt', false);
    expect(result).toContain('Refused');
    expect(manager.list()).toHaveLength(1);
  });

  it('safeRemove: discard_changes=true 强制删除', () => {
    const record = manager.create('force-wt', 'task-1');
    writeFileSync(join(record.path, 'dirty.txt'), 'uncommitted');

    const result = manager.safeRemove('force-wt', true);
    expect(result).toContain('removed');
    expect(manager.list()).toHaveLength(0);
  });

  it('safeRemove: 无改动时正常删除', () => {
    manager.create('clean-wt', 'task-1');
    const result = manager.safeRemove('clean-wt', false);
    expect(result).toContain('removed');
    expect(manager.list()).toHaveLength(0);
  });

  it('closeout: keep 记录 closeout', () => {
    manager.create('keep-wt', 'task-1');
    manager.closeout('keep-wt', 'keep', 'Need review');

    const record = manager.getByName('keep-wt');
    expect(record?.closeout?.action).toBe('keep');
    expect(record?.closeout?.reason).toBe('Need review');
  });

  it('closeout: remove 删除 worktree', () => {
    manager.create('rm-wt', 'task-1');
    manager.closeout('rm-wt', 'remove', 'Done');
    expect(manager.list()).toHaveLength(0);
  });

  it('runCommand: 在 worktree 目录执行命令', () => {
    manager.create('run-wt', 'task-1');
    const output = manager.runCommand('run-wt', 'echo hello-from-wt');
    expect(output).toContain('hello-from-wt');
    expect(manager.getByName('run-wt')?.lastCommandPreview).toBe('echo hello-from-wt');
  });

  it('enter: 记录进入时间', () => {
    manager.create('enter-wt', 'task-1');
    manager.enter('enter-wt');
    expect(manager.getByName('enter-wt')?.lastEnteredAt).toBeTruthy();
  });
});
