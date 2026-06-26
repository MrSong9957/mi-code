// Worktree 工具层集成测试 + task 工具的 worktree 隔离
//
// 验证 s12 接线后的行为：LLM 通过 worktree 工具能创建/列出/收尾隔离目录，
// task 工具能在指定 worktree 内执行子代理。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorktreeManager } from '../worktree/worktree-manager.js';
import { createWorktreeTool } from '../agent/tools/worktree-tool.js';
import { createTaskTool } from '../agent/tools/task-tool.js';
import { createDefaultRegistry } from '../agent/tool-registry.js';
import { TodoManager } from '../agent/todo.js';
import { TaskBoard } from '../task-board/task-board.js';

function makeTmpGitRepo(): string {
  const dir = join(tmpdir(), `wt-integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('worktree 工具层（LLM 调用路径）', () => {
  let repoDir: string;
  let manager: WorktreeManager;
  let tool: ReturnType<typeof createWorktreeTool>;

  beforeEach(() => {
    repoDir = makeTmpGitRepo();
    process.chdir(repoDir);
    manager = new WorktreeManager(repoDir);
    tool = createWorktreeTool(manager);
  });

  afterEach(() => {
    // Windows 上 git worktree 目录含只读/链接文件，rmSync 可能 EPERM；
    // 先尝试 git 层清理，再删除（失败则忽略——目录在 tmpdir 不影响正确性）
    try { execSync('git worktree prune', { cwd: repoDir, stdio: 'ignore' }); } catch { /* ignore */ }
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('create 子命令经工具层创建 worktree', async () => {
    const result = await tool.executor({
      action: 'create',
      name: 'auth-refactor',
      taskId: 'T1',
    });

    expect(result).toContain('Created worktree');
    expect(result).toContain('auth-refactor');
    expect(result).toContain('wt/auth-refactor');
    expect(manager.list()).toHaveLength(1);
  });

  it('create 缺参数返回错误', async () => {
    const result = await tool.executor({ action: 'create', name: 'x' });
    expect(result).toContain('Error');
    expect(result).toContain('name and taskId');
  });

  it('list 子命令列出 worktree', async () => {
    await tool.executor({ action: 'create', name: 'a', taskId: 'T1' });
    await tool.executor({ action: 'create', name: 'b', taskId: 'T2' });

    const result = await tool.executor({ action: 'list' });
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('T1');
  });

  it('list 空时返回提示', async () => {
    const result = await tool.executor({ action: 'list' });
    expect(result).toBe('No worktrees.');
  });

  it('status 子命令按名称查找', async () => {
    await tool.executor({ action: 'create', name: 'find-me', taskId: 'T9' });
    const result = await tool.executor({ action: 'status', name: 'find-me' });
    expect(result).toContain('find-me');
    expect(result).toContain('T9');
  });

  it('closeout remove 经工具层删除 worktree', async () => {
    await tool.executor({ action: 'create', name: 'temp-wt', taskId: 'T1' });
    const result = await tool.executor({
      action: 'closeout',
      name: 'temp-wt',
      closeoutAction: 'remove',
      reason: 'done',
    });

    expect(result).toContain('closeout');
    expect(manager.list()).toHaveLength(0);
  });

  it('未知 action 返回错误', async () => {
    const result = await tool.executor({ action: 'bogus' });
    expect(result).toContain('Error');
    expect(result).toContain('Unknown action');
  });
});

describe('task 工具的 worktree 隔离', () => {
  let repoDir: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    repoDir = makeTmpGitRepo();
    process.chdir(repoDir);
    manager = new WorktreeManager(repoDir);
  });

  afterEach(() => {
    try { execSync('git worktree prune', { cwd: repoDir, stdio: 'ignore' }); } catch { /* ignore */ }
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('指定不存在的 worktree 返回错误', async () => {
    const todoManager = new TodoManager();
    const childRegistry = createDefaultRegistry(todoManager);
    const taskTool = createTaskTool(childRegistry, manager);

    const result = await taskTool.executor({ prompt: 'do something', worktree: 'ghost-wt' });
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });

  it('createDefaultRegistry 注册了 worktree 和 task-board 工具', () => {
    const todoManager = new TodoManager();
    const board = new TaskBoard();
    const registry = createDefaultRegistry(todoManager, undefined, undefined, undefined, board, manager);

    const toolNames = Array.from(registry.tools.keys());
    expect(toolNames).toContain('worktree');
    expect(toolNames).toContain('create_task_matrix');
    expect(toolNames).toContain('mark_task_done');
  });

  it('未配置 worktreeManager 时 task 工具退化为普通子代理', async () => {
    const todoManager = new TodoManager();
    const childRegistry = createDefaultRegistry(todoManager);
    const taskTool = createTaskTool(childRegistry); // 无 worktreeManager

    // 仅验证不因 worktree 参数报错（实际 LLM 调用会因无 API key 失败，这里只测参数校验逻辑）
    // 不传 worktree 时正常构造
    expect(taskTool.definition.name).toBe('task');
  });
});
