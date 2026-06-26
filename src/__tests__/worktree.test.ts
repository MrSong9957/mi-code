// WorktreeManager 单元测试
//
// 物理本质：测试"快递中转站"能不能正确收发快递、记录台账、崩溃后恢复。
// 用 tmpdir 模拟 git 仓库，避免依赖真实项目目录。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorktreeManager } from '../worktree/worktree-manager.js';

function makeTmpGitRepo(): string {
  const dir = join(tmpdir(), `wt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('WorktreeManager', () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoDir = makeTmpGitRepo();
    manager = new WorktreeManager(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('create: 创建 worktree 并绑定任务', () => {
    const record = manager.create('auth-refactor', 'task-1');

    expect(record.name).toBe('auth-refactor');
    expect(record.branch).toBe('wt/auth-refactor');
    expect(record.taskId).toBe('task-1');
    expect(existsSync(record.path)).toBe(true);

    // 索引文件已写入
    const list = manager.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('auth-refactor');
  });

  it('create: 重复名称抛错', () => {
    manager.create('dup-task', 'task-1');
    expect(() => manager.create('dup-task', 'task-2')).toThrow('already exists');
  });

  it('list: 返回所有记录', () => {
    manager.create('a', 't1');
    manager.create('b', 't2');
    expect(manager.list()).toHaveLength(2);
  });

  it('getByTask: 按任务 ID 查 worktree', () => {
    manager.create('wt-a', 'task-10');
    manager.create('wt-b', 'task-20');

    const found = manager.getByTask('task-10');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('wt-a');

    expect(manager.getByTask('task-99')).toBeNull();
  });

  it('remove: 移除 worktree 并记录事件', () => {
    manager.create('to-remove', 'task-3');
    manager.remove('to-remove');

    expect(manager.list()).toHaveLength(0);
    expect(existsSync(join(repoDir, '.worktrees', 'to-remove'))).toBe(false);
  });

  it('remove: 不存在的名称抛错', () => {
    expect(() => manager.remove('ghost')).toThrow('not found');
  });

  it('keep: 标记保留', () => {
    manager.create('keep-me', 'task-4');
    manager.keep('keep-me');

    // keep 不删除目录，只写事件
    expect(manager.list()).toHaveLength(1);
    expect(existsSync(join(repoDir, '.worktrees', 'keep-me'))).toBe(true);
  });

  it('events: 事件流写入 events.jsonl', () => {
    manager.create('evt-test', 'task-5');
    manager.remove('evt-test');

    const eventsPath = join(repoDir, '.worktrees', 'events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);

    const lines = readFileSync(eventsPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3); // created + bound + removed

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe('created');
    expect(first.name).toBe('evt-test');
  });

  it('recover: 从磁盘重建状态', () => {
    manager.create('recover-me', 'task-6');

    // 模拟进程重启：新建 manager 实例
    const manager2 = new WorktreeManager(repoDir);
    const list = manager2.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('recover-me');
    expect(list[0].taskId).toBe('task-6');
  });
});
