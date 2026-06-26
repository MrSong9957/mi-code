// TaskBoard：任务看板（四态状态机 + 依赖图级联 + 拓扑死锁检测）
//
// 物理本质：项目看板墙。
// 每张卡片（Task）贴在四个桶之一：waiting（等依赖）/ ready（可开工）/ active（执行中）/ done（完成）。
// 当一张卡片移到 done，墙自动检查：有没有别的 waiting 卡片因此解除阻塞 → 移到 ready。
// 提交一批新卡片时，先跑拓扑排序：如果拆出了环路依赖（A等B、B又等A），整批拒绝，防止死锁。
//
// 对应文档 s12 新版 Task System。

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Task, TaskStatus, TaskGraphSnapshot } from './types.js';

export class TaskBoard {
  private tasks = new Map<string, Task>();
  /** 持久化文件路径（load/save 时设置） */
  private filePath: string | null = null;

  /** 设置持久化路径（不立即读写） */
  setPersistence(repoRoot: string): void {
    this.filePath = join(repoRoot, '.tasks.json');
  }

  /** 从磁盘加载看板快照（断点恢复） */
  load(repoRoot?: string): void {
    const path = repoRoot ? join(repoRoot, '.tasks.json') : this.filePath;
    if (!path || !existsSync(path)) return;
    try {
      const snapshot = JSON.parse(readFileSync(path, 'utf8')) as TaskGraphSnapshot;
      this.filePath = path;
      this.tasks = new Map(snapshot.tasks.map((t) => [t.id, t]));
    } catch {
      // 损坏的快照，保持空看板
    }
  }

  /** 持久化看板快照到磁盘 */
  save(): void {
    if (!this.filePath) return;
    const snapshot: TaskGraphSnapshot = { tasks: this.list() };
    writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  /** 添加单个任务：无依赖→ready，有依赖→waiting */
  addTask(id: string, title: string, dependencies: string[] = []): Task {
    if (this.tasks.has(id)) {
      throw new Error(`Task "${id}" already exists`);
    }
    const status: TaskStatus = dependencies.length === 0 ? 'ready' : 'waiting';
    const task: Task = { id, title, dependencies, status, result: '' };
    this.tasks.set(id, task);
    return task;
  }

  /**
   * 批量添加任务（create_task_matrix 用）
   *
   * 先跑拓扑排序校验有无环路依赖；有环则整批拒绝（不写入任何任务）。
   * 返回新增任务数组。
   */
  addTasks(items: Array<{ id: string; title: string; dependencies: string[] }>): Task[] {
    if (this.hasCycleAmong(items)) {
      throw new Error('Dependency cycle detected: task graph must be a DAG (no circular dependencies)');
    }
    const added: Task[] = [];
    for (const item of items) {
      added.push(this.addTask(item.id, item.title, item.dependencies));
    }
    // 批量添加后重新评估初始就绪状态（依赖已存在于本批内的情况）
    this.refreshBoard();
    return added;
  }

  /** 标记任务为执行中 */
  markActive(id: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    task.status = 'active';
  }

  /** 标记任务完成，写入结果摘要，并触发看板级联刷新 */
  markDone(id: string, result = ''): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task "${id}" not found`);
    task.status = 'done';
    if (result) task.result = result;
    this.refreshBoard();
  }

  /**
   * 刷新看板：waiting 中所有依赖均已 done 的 → ready
   *
   * 这是级联解锁的核心：done 一个任务可能释放多个下游任务。
   */
  private refreshBoard(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'waiting') continue;
      if (this.allDepsDone(task)) {
        task.status = 'ready';
      }
    }
  }

  /** 检查任务的所有依赖是否都已 done（未知依赖视为未完成） */
  private allDepsDone(task: Task): boolean {
    return task.dependencies.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep?.status === 'done';
    });
  }

  /** 获取第一个 ready 任务（供调度器认领） */
  getReadyTasks(): Task[] {
    return this.list().filter((t) => t.status === 'ready');
  }

  /** 获取单个任务 */
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** 列出所有任务（按插入顺序） */
  list(): Task[] {
    return [...this.tasks.values()];
  }

  /** 是否所有任务都已 done */
  allDone(): boolean {
    return this.tasks.size > 0 && this.list().every((t) => t.status === 'done');
  }

  /**
   * 检测整张看板是否存在依赖环路（Kahn 拓扑排序）
   *
   * 若无法完成对所有节点的拓扑排序（即存在剩余入度>0的节点），说明有环。
   */
  hasCycle(): boolean {
    return this.detectCycle(this.list());
  }

  /**
   * 检测给定任务集合（连同已有任务一起）是否引入环路
   *
   * 用于 addTasks 提交前的校验：把候选任务与现有任务合并后跑一次拓扑排序。
   */
  private hasCycleAmong(candidates: Array<{ id: string; dependencies: string[] }>): boolean {
    // 合并现有任务 + 候选任务（候选优先），构建待检测的节点集
    const merged: Task[] = [];
    for (const existing of this.tasks.values()) {
      const overridden = candidates.find((c) => c.id === existing.id);
      if (overridden) continue; // 候选会覆盖，用候选版本
      merged.push(existing);
    }
    for (const c of candidates) {
      merged.push({ id: c.id, title: '', dependencies: c.dependencies, status: 'waiting', result: '' });
    }
    return this.detectCycle(merged);
  }

  /** Kahn 拓扑排序实现：能排序完所有节点则无环，否则有环 */
  private detectCycle(nodes: Task[]): boolean {
    const ids = new Set(nodes.map((n) => n.id));
    // 入度表（只计节点集合内存在的依赖）
    const indegree = new Map<string, number>();
    for (const n of nodes) indegree.set(n.id, 0);
    for (const n of nodes) {
      for (const dep of n.dependencies) {
        if (ids.has(dep) && ids.has(n.id)) {
          indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
        }
      }
    }
    // 入度为 0 的节点入队
    const queue: string[] = [];
    for (const [id, deg] of indegree) {
      if (deg === 0) queue.push(id);
    }
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited++;
      const node = nodes.find((n) => n.id === id);
      if (!node) continue;
      // 对所有以本节点为依赖的节点，入度减一
      for (const other of nodes) {
        if (other.dependencies.includes(id)) {
          const newDeg = (indegree.get(other.id) ?? 0) - 1;
          indegree.set(other.id, newDeg);
          if (newDeg === 0) queue.push(other.id);
        }
      }
    }
    // 未访问的节点 = 环内节点
    return visited !== nodes.length;
  }

  /**
   * 渲染看板为可读文本（注入 system prompt 用）
   *
   * 格式遵循文档：[=== TASK BOARD ===] + 每张卡片一行
   */
  render(): string {
    if (this.tasks.size === 0) return '[=== TASK BOARD ===]\n(no tasks)';
    const lines = ['[=== TASK BOARD ===]'];
    for (const t of this.list()) {
      const depStr = t.dependencies.length > 0 ? ` (waits for ${t.dependencies.join(', ')})` : '';
      lines.push(`- [${t.status.toUpperCase()}] ${t.id}: ${t.title}${depStr}`);
    }
    return lines.join('\n');
  }
}
