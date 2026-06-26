// TaskBoard 测试：四态状态机 + 依赖级联 + 拓扑死锁检测 + 持久化
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskBoard } from '../task-board/task-board.js';

describe('TaskBoard - 状态初始化', () => {
  it('无依赖任务初始化为 ready', () => {
    const board = new TaskBoard();
    board.addTask('T1', '写路由', []);
    expect(board.getTask('T1')?.status).toBe('ready');
  });

  it('有依赖任务初始化为 waiting', () => {
    const board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: '建表', dependencies: [] },
      { id: 'T2', title: '写逻辑', dependencies: ['T1'] },
    ]);
    expect(board.getTask('T1')?.status).toBe('ready');
    expect(board.getTask('T2')?.status).toBe('waiting');
  });

  it('重复 id 抛错', () => {
    const board = new TaskBoard();
    board.addTask('T1', 'a', []);
    expect(() => board.addTask('T1', 'b', [])).toThrow('already exists');
  });
});

describe('TaskBoard - 依赖级联解锁', () => {
  it('T1 done 后 T2(依赖T1) 自动从 waiting 变 ready', () => {
    const board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: '建表', dependencies: [] },
      { id: 'T2', title: '写逻辑', dependencies: ['T1'] },
    ]);
    expect(board.getTask('T2')?.status).toBe('waiting');

    board.markDone('T1', '表已建好');
    expect(board.getTask('T1')?.status).toBe('done');
    expect(board.getTask('T1')?.result).toBe('表已建好');
    expect(board.getTask('T2')?.status).toBe('ready');
  });

  it('多依赖：全部 done 才 ready', () => {
    const board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: 'a', dependencies: [] },
      { id: 'T2', title: 'b', dependencies: [] },
      { id: 'T3', title: 'c', dependencies: ['T1', 'T2'] },
    ]);
    expect(board.getTask('T3')?.status).toBe('waiting');

    board.markDone('T1');
    expect(board.getTask('T3')?.status).toBe('waiting'); // T2 还没 done

    board.markDone('T2');
    expect(board.getTask('T3')?.status).toBe('ready'); // 依赖全部满足
  });

  it('链式级联：T1→T2→T3 依次解锁', () => {
    const board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: 'a', dependencies: [] },
      { id: 'T2', title: 'b', dependencies: ['T1'] },
      { id: 'T3', title: 'c', dependencies: ['T2'] },
    ]);
    expect(board.getTask('T3')?.status).toBe('waiting');

    board.markDone('T1');
    expect(board.getTask('T2')?.status).toBe('ready');
    expect(board.getTask('T3')?.status).toBe('waiting');

    board.markDone('T2');
    expect(board.getTask('T3')?.status).toBe('ready');
  });

  it('markActive 切换到执行中', () => {
    const board = new TaskBoard();
    board.addTask('T1', 'a', []);
    board.markActive('T1');
    expect(board.getTask('T1')?.status).toBe('active');
  });
});

describe('TaskBoard - 拓扑死锁检测', () => {
  it('正常 DAG 无环', () => {
    const board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: 'a', dependencies: [] },
      { id: 'T2', title: 'b', dependencies: ['T1'] },
      { id: 'T3', title: 'c', dependencies: ['T1', 'T2'] },
    ]);
    expect(board.hasCycle()).toBe(false);
  });

  it('环路依赖被检测为有环', () => {
    const board = new TaskBoard();
    expect(() =>
      board.addTasks([
        { id: 'T1', title: 'a', dependencies: ['T2'] },
        { id: 'T2', title: 'b', dependencies: ['T1'] },
      ]),
    ).toThrow('cycle');
  });

  it('自环被检测为有环', () => {
    const board = new TaskBoard();
    expect(() =>
      board.addTasks([{ id: 'T1', title: 'a', dependencies: ['T1'] }]),
    ).toThrow('cycle');
  });

  it('addTasks 拒绝带环批次时不写入任何任务', () => {
    const board = new TaskBoard();
    expect(() =>
      board.addTasks([
        { id: 'T1', title: 'a', dependencies: ['T2'] },
        { id: 'T2', title: 'b', dependencies: ['T1'] },
      ]),
    ).toThrow();
    expect(board.list()).toHaveLength(0);
  });

  it('三角环 T1→T2→T3→T1 被拒绝', () => {
    const board = new TaskBoard();
    expect(() =>
      board.addTasks([
        { id: 'T1', title: 'a', dependencies: ['T3'] },
        { id: 'T2', title: 'b', dependencies: ['T1'] },
        { id: 'T3', title: 'c', dependencies: ['T2'] },
      ]),
    ).toThrow('cycle');
  });
});

describe('TaskBoard - 渲染', () => {
  it('空看板渲染', () => {
    const board = new TaskBoard();
    expect(board.render()).toContain('TASK BOARD');
    expect(board.render()).toContain('no tasks');
  });

  it('渲染包含状态和依赖', () => {
    const board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: '建表', dependencies: [] },
      { id: 'T2', title: '写逻辑', dependencies: ['T1'] },
    ]);
    const rendered = board.render();
    expect(rendered).toContain('[READY] T1: 建表');
    expect(rendered).toContain('[WAITING] T2: 写逻辑');
    expect(rendered).toContain('waits for T1');
  });
});

describe('TaskBoard - 持久化（断点恢复）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'task-board-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('save 写入 .tasks.json，load 恢复一致状态', () => {
    const board1 = new TaskBoard();
    board1.setPersistence(tempDir);
    board1.addTasks([
      { id: 'T1', title: '建表', dependencies: [] },
      { id: 'T2', title: '写逻辑', dependencies: ['T1'] },
    ]);
    board1.markActive('T1');
    board1.save();

    // 文件存在
    expect(existsSync(join(tempDir, '.tasks.json'))).toBe(true);

    // 新实例从磁盘恢复
    const board2 = new TaskBoard();
    board2.load(tempDir);
    expect(board2.getTask('T1')?.status).toBe('active');
    expect(board2.getTask('T2')?.status).toBe('waiting');
    expect(board2.list()).toHaveLength(2);
  });

  it('done 状态在 load 后保持', () => {
    const board1 = new TaskBoard();
    board1.setPersistence(tempDir);
    board1.addTasks([
      { id: 'T1', title: 'a', dependencies: [] },
      { id: 'T2', title: 'b', dependencies: ['T1'] },
    ]);
    board1.markDone('T1', '完成');
    board1.save();

    const board2 = new TaskBoard();
    board2.load(tempDir);
    expect(board2.getTask('T1')?.status).toBe('done');
    expect(board2.getTask('T1')?.result).toBe('完成');
    // 注意：load 不触发 refreshBoard（恢复快照原样），T2 保持恢复时的状态
  });

  it('无文件时 load 不报错', () => {
    const board = new TaskBoard();
    expect(() => board.load(tempDir)).not.toThrow();
    expect(board.list()).toHaveLength(0);
  });
});

describe('TaskBoard - 辅助查询', () => {
  it('getReadyTasks 返回所有 ready', () => {
    const board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: 'a', dependencies: [] },
      { id: 'T2', title: 'b', dependencies: [] },
      { id: 'T3', title: 'c', dependencies: ['T1'] },
    ]);
    const ready = board.getReadyTasks();
    expect(ready.map((t) => t.id).sort()).toEqual(['T1', 'T2']);
  });

  it('allDone: 全部完成返回 true', () => {
    const board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: 'a', dependencies: [] },
      { id: 'T2', title: 'b', dependencies: ['T1'] },
    ]);
    expect(board.allDone()).toBe(false);
    board.markDone('T1');
    board.markDone('T2');
    expect(board.allDone()).toBe(true);
  });

  it('allDone: 空看板返回 false', () => {
    const board = new TaskBoard();
    expect(board.allDone()).toBe(false);
  });
});
