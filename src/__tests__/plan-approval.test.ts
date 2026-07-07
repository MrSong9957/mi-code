// 阶段 3：plan 目录白名单 + PlanStore + write_plan_file / exit_plan_mode 工具
//
// 物理本质：
// - 白名单 = plan 模式下 write_file 写到 planDir 才放行（图纸只许进档案柜）
// - PlanStore = 档案柜本身（落盘、读、状态标记）
// - 工具 = AI 写图纸 + 提交审批
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PermissionChecker } from '../permission/checker.js';
import { PlanStore } from '../plan/plan-store.js';
import { createWritePlanTool, createExitPlanModeTool } from '../agent/tools/plan-tools.js';
import { AskUserManager } from '../agent/ask-user-manager.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'micode-plan-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('PermissionChecker planDir 白名单', () => {
  it('无 planDir：plan 模式下 write_file 一律 deny', () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: tempDir });
    const d = checker.check('write_file', { path: 'foo.txt', content: 'x' });
    expect(d.behavior).toBe('deny');
  });

  it('planDir 内：plan 模式下 write_file 放行', () => {
    const planDir = join(tempDir, 'plans');
    const checker = new PermissionChecker({ mode: 'plan', workdir: tempDir, planDir });
    // 路径在 planDir 内
    const inside = checker.check('write_file', { path: join(planDir, 'p.md'), content: 'x' });
    expect(inside.behavior).toBe('allow');
    expect(inside.reason).toMatch(/plan dir/i);
  });

  it('planDir 外：plan 模式下 write_file 仍 deny', () => {
    const planDir = join(tempDir, 'plans');
    const checker = new PermissionChecker({ mode: 'plan', workdir: tempDir, planDir });
    const outside = checker.check('write_file', { path: join(tempDir, 'elsewhere.md'), content: 'x' });
    expect(outside.behavior).toBe('deny');
  });

  it('setPlanDir / getPlanDir', () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: tempDir });
    expect(checker.getPlanDir()).toBeNull();
    const planDir = join(tempDir, 'plans');
    checker.setPlanDir(planDir);
    expect(checker.getPlanDir()).toBe(planDir);
    // 设置后白名单生效
    expect(checker.check('write_file', { path: join(planDir, 'x.md'), content: 'x' }).behavior).toBe('allow');
  });

  it('build 模式不受 planDir 影响（不进 plan 分支）', () => {
    const planDir = join(tempDir, 'plans');
    const checker = new PermissionChecker({ mode: 'build', workdir: tempDir, planDir });
    // build 模式下 write_file 走到闸门4 ask，不受 planDir 白名单影响
    const d = checker.check('write_file', { path: join(planDir, 'x.md'), content: 'x' });
    expect(d.behavior).not.toBe('deny');
  });

  it('plan 模式：edit_file 同样受 planDir 白名单保护', () => {
    const planDir = join(tempDir, 'plans');
    const checker = new PermissionChecker({ mode: 'plan', workdir: tempDir, planDir });
    expect(checker.check('edit_file', { path: join(planDir, 'p.md'), old_text: 'a', new_text: 'b' }).behavior).toBe('allow');
    expect(checker.check('edit_file', { path: join(tempDir, 'outside.md'), old_text: 'a', new_text: 'b' }).behavior).toBe('deny');
  });
});

describe('PlanStore', () => {
  it('构造时创建 plans 目录', () => {
    const baseDir = join(tempDir, 'micode');
    const store = new PlanStore(baseDir);
    expect(existsSync(store.getPlansDir())).toBe(true);
    expect(store.getPlansDir()).toBe(join(baseDir, 'plans'));
  });

  it('write 落盘 + 返回路径 + getCurrent 读出', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const filePath = store.write('sess-1', '# My Plan\n\nDo X');
    expect(existsSync(filePath)).toBe(true);
    const current = store.getCurrent();
    expect(current).not.toBeNull();
    expect(current!.filePath).toBe(filePath);
    expect(current!.content).toContain('# My Plan');
    expect(current!.content).toContain('session: sess-1');
    expect(current!.content).toContain('status: pending');
  });

  it('多次 write：currentPath 指向最新', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.write('sess-1', 'plan v1');
    store.write('sess-1', 'plan v2');
    const current = store.getCurrent()!;
    expect(current.content).toContain('plan v2');
    expect(current.content).not.toContain('plan v1');
  });

  it('getCurrent 无 plan 时返回 null', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    expect(store.getCurrent()).toBeNull();
  });

  it('setStatus 更新 frontmatter', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.write('sess-1', 'plan');
    store.setStatus('approved');
    const current = store.getCurrent()!;
    expect(current.content).toContain('status: approved');
  });
});

describe('write_plan_file 工具', () => {
  it('definition 字段正确', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { definition } = createWritePlanTool(store, () => 'sess-1');
    expect(definition.name).toBe('write_plan_file');
    expect(definition.parameters.required).toEqual(['content']);
  });

  it('executor 写盘成功', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { executor } = createWritePlanTool(store, () => 'sess-1');
    const result = await executor({ content: '# Plan\nDo X' });
    expect(result).toMatch(/Plan written/);
    expect(store.getCurrent()?.content).toContain('# Plan');
  });

  it('空 content 返回 Error', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { executor } = createWritePlanTool(store, () => 'sess-1');
    const result = await executor({ content: '' });
    expect(result).toMatch(/Error/i);
  });
});

describe('exit_plan_mode 工具', () => {
  function makeManager() {
    return new AskUserManager({
      printLine: () => {},
      setHint: () => {},
    });
  }

  it('definition 字段正确', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const mgr = makeManager();
    const { definition } = createExitPlanModeTool(mgr, store);
    expect(definition.name).toBe('exit_plan_mode');
  });

  it('无 plan 时返回 Error', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const mgr = makeManager();
    const { executor } = createExitPlanModeTool(mgr, store);
    const result = await executor({});
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/write_plan_file/);
  });

  it('approve：pending → resolve "approve" → 返回 approved 文案 + status=approved', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.write('sess-1', 'plan body');
    const mgr = makeManager();
    const { executor } = createExitPlanModeTool(mgr, store);

    const p = executor({ summary: 'Review my plan' });
    expect(mgr.hasPending()).toBe(true);
    mgr.resolve('approve');
    const result = await p;
    expect(result).toMatch(/approved/i);
    expect(store.getCurrent()!.content).toContain('status: approved');
  });

  it('reject：pending → resolve "reject" → 返回 rejected 文案 + status=rejected', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.write('sess-1', 'plan body');
    const mgr = makeManager();
    const { executor } = createExitPlanModeTool(mgr, store);

    const p = executor({});
    mgr.resolve('reject');
    const result = await p;
    expect(result).toMatch(/rejected/i);
    expect(store.getCurrent()!.content).toContain('status: rejected');
  });

  it('reject 带原因：原因出现在返回文案中', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.write('sess-1', 'plan body');
    const mgr = makeManager();
    const { executor } = createExitPlanModeTool(mgr, store);

    const p = executor({});
    mgr.resolve('考虑用 Redis');
    const result = await p;
    expect(result).toContain('考虑用 Redis');
  });
});
