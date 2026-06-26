// TaskBoard 工具测试：create_task_matrix + mark_task_done 工具层
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskBoard } from '../task-board/task-board.js';
import { createTaskMatrixTool, createMarkTaskDoneTool } from '../agent/tools/task-board-tool.js';

describe('create_task_matrix 工具', () => {
  let board: TaskBoard;
  let tool: ReturnType<typeof createTaskMatrixTool>;

  beforeEach(() => {
    board = new TaskBoard();
    tool = createTaskMatrixTool(board);
  });

  it('批量创建任务并返回看板视图', async () => {
    const result = await tool.executor({
      tasks: JSON.stringify([
        { id: 'T1', title: '建表', dependencies: [] },
        { id: 'T2', title: '写逻辑', dependencies: ['T1'] },
      ]),
    });

    expect(result).toContain('Task matrix approved');
    expect(result).toContain('[READY] T1: 建表');
    expect(result).toContain('[WAITING] T2: 写逻辑');
    expect(board.list()).toHaveLength(2);
  });

  it('拒绝环路依赖并返回错误', async () => {
    const result = await tool.executor({
      tasks: JSON.stringify([
        { id: 'T1', title: 'a', dependencies: ['T2'] },
        { id: 'T2', title: 'b', dependencies: ['T1'] },
      ]),
    });

    expect(result).toContain('Error');
    expect(result).toContain('cycle');
    // 整批拒绝，不应写入任何任务
    expect(board.list()).toHaveLength(0);
  });

  it('拒绝无效 JSON', async () => {
    const result = await tool.executor({ tasks: 'not-json' });
    expect(result).toContain('Error');
    expect(result).toContain('valid JSON');
  });

  it('拒绝空数组', async () => {
    const result = await tool.executor({ tasks: '[]' });
    expect(result).toContain('Error');
    expect(result).toContain('non-empty');
  });
});

describe('mark_task_done 工具', () => {
  let board: TaskBoard;
  let doneTool: ReturnType<typeof createMarkTaskDoneTool>;

  beforeEach(() => {
    board = new TaskBoard();
    board.addTasks([
      { id: 'T1', title: '建表', dependencies: [] },
      { id: 'T2', title: '写逻辑', dependencies: ['T1'] },
    ]);
    doneTool = createMarkTaskDoneTool(board);
  });

  it('标记完成并触发依赖级联', async () => {
    const result = await doneTool.executor({ id: 'T1', result_summary: '表已建好' });

    expect(result).toContain('T1 set to DONE');
    expect(result).toContain('Board updated');
    expect(board.getTask('T1')?.status).toBe('done');
    expect(board.getTask('T2')?.status).toBe('ready'); // 级联解锁
  });

  it('完成结果摘要写入任务', async () => {
    await doneTool.executor({ id: 'T1', result_summary: '创建了 users 表' });
    expect(board.getTask('T1')?.result).toBe('创建了 users 表');
  });

  it('未知任务 id 返回错误', async () => {
    const result = await doneTool.executor({ id: 'GHOST', result_summary: 'x' });
    expect(result).toContain('Error');
    expect(result).toContain('not found');
  });
});
