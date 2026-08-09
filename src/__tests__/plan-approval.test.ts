// 阶段 3：plan 目录白名单 + PlanStore + write_plan_file / exit_plan_mode 工具
//
// 物理本质：
// - 白名单 = plan 模式下 write_file 写到 planDir 才放行（图纸只许进档案柜）
// - PlanStore = 档案柜本身（落盘、读、状态标记）
// - 工具 = AI 写图纸 + 提交审批
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PermissionChecker } from '../permission/checker.js';
import { PlanStore } from '../plan/plan-store.js';
import { createWritePlanTool, createExitPlanModeTool, createReadPlanTool, PLAN_APPROVAL_OPTION_VALUES } from '../agent/tools/plan-tools.js';
import { AskUserManager } from '../agent/ask-user-manager.js';
import { createLanguageStore } from '../locale/language-store.js';
import { createTranslator } from '../locale/translator.js';
import type { AskQuestionOutcome, AskQuestionOutcomeCallback, AskQuestionRequest } from '../agent/ask-user-types.js';

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
  const oldContext = { sessionId: 'sess-1', turnId: 'turn-old' };
  const currentContext = { sessionId: 'sess-1', turnId: 'turn-current' };

  it('构造时创建 plans 目录', () => {
    const baseDir = join(tempDir, 'micode');
    const store = new PlanStore(baseDir);
    expect(existsSync(store.getPlansDir())).toBe(true);
    expect(store.getPlansDir()).toBe(join(baseDir, 'plans'));
  });

  it('writes a pending plan for the begun current turn', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.beginTurn(currentContext);
    const filePath = store.write(currentContext, '# My Plan\n\nDo X');
    expect(existsSync(filePath)).toBe(true);
    const current = store.getActive(currentContext);
    expect(current).not.toBeNull();
    expect(current!.filePath).toBe(filePath);
    expect(current!.content).toContain('# My Plan');
    expect(current!.content).toContain('session: sess-1');
    expect(current!.content).toContain('turn: turn-current');
    expect(current!.content).toContain('status: pending');
  });

  it('invalidates the prior active plan when a new turn begins', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.beginTurn(oldContext);
    store.write(oldContext, 'old plan');
    store.beginTurn(currentContext);

    expect(store.getActive(currentContext)).toBeNull();
    expect(store.getActive(oldContext)).toBeNull();
  });

  it('rejects writes for a context that is no longer current', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.beginTurn(oldContext);
    store.beginTurn(currentContext);

    expect(() => store.write(oldContext, 'stale plan')).toThrow(/current turn/i);
  });

  it('marks only the matching active plan and clears its approval capability', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.beginTurn(currentContext);
    const filePath = store.write(currentContext, 'plan');

    expect(store.setStatus(oldContext, 'approved')).toBe(false);
    expect(store.setStatus(currentContext, 'approved')).toBe(true);
    expect(store.getActive(currentContext)).toBeNull();
    expect(store.recoverLatestForSession('sess-1')!.filePath).toBe(filePath);
    expect(store.recoverLatestForSession('sess-1')!.content).toContain('status: approved');
  });

  it('write 用 slug 命名：<sessionId>-<6hex>.md', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.beginTurn(currentContext);
    const filePath = store.write(currentContext, 'plan body');
    expect(filePath).toMatch(/sess-1-[a-f0-9]{6}\.md$/);
  });

  it('清理机制：write 时删除超过 30 天的 plan 文件', () => {
    const baseDir = join(tempDir, 'micode');
    const store = new PlanStore(baseDir);
    const plansDir = store.getPlansDir();
    // 放一个 31 天前 mtime 的旧文件
    const oldFile = join(plansDir, 'old-sess-deadbeef.md');
    writeFileSync(oldFile, '---\ncreated: x\n---\nold\n', 'utf8');
    const oldTime = (Date.now() / 1000) - (31 * 24 * 60 * 60);
    utimesSync(oldFile, oldTime, oldTime);
    expect(existsSync(oldFile)).toBe(true);
    // 触发惰性清理
    store.beginTurn(currentContext);
    store.write(currentContext, 'new plan');
    expect(existsSync(oldFile)).toBe(false);
  });

  it('recovers only the latest plan for the requested session without activating it', () => {
    const baseDir = join(tempDir, 'micode');
    const store1 = new PlanStore(baseDir);
    const s1 = { sessionId: 's1', turnId: 's1-turn' };
    const s2 = { sessionId: 's2', turnId: 's2-turn' };
    store1.beginTurn(s1);
    const filePath = store1.write(s1, 's1 recovery plan');
    store1.beginTurn(s2);
    store1.write(s2, 'newer s2 plan');
    const store2 = new PlanStore(baseDir);

    const recovered = store2.recoverLatestForSession('s1');
    expect(recovered).not.toBeNull();
    expect(recovered.filePath).toBe(filePath);
    expect(recovered.content).toContain('s1 recovery plan');
    store2.beginTurn({ sessionId: 's1', turnId: 'new-turn' });
    expect(store2.getActive({ sessionId: 's1', turnId: 'new-turn' })).toBeNull();
  });

  it('recovers a legacy plan only as historical data, never as an active current-turn plan', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const legacyPath = join(store.getPlansDir(), 'legacy-plan.md');
    writeFileSync(
      legacyPath,
      '---\nsession: sess-1\ncreated: 2026-07-22T00:00:00.000Z\nstatus: pending\n---\n\nlegacy plan body\n',
      'utf8',
    );

    const recovered = store.recoverLatestForSession(currentContext.sessionId);

    expect(recovered).toMatchObject({
      filePath: legacyPath,
      sessionId: currentContext.sessionId,
      turnId: null,
      createdAt: '2026-07-22T00:00:00.000Z',
      status: 'pending',
    });
    expect(recovered!.content).toContain('legacy plan body');
    store.beginTurn(currentContext);
    expect(store.getActive(currentContext)).toBeNull();
  });

  it('plansDirOverride：绝对路径覆盖默认 plans 目录', () => {
    const custom = join(tempDir, 'custom-plans');
    const store = new PlanStore(join(tempDir, 'micode'), custom);
    expect(store.getPlansDir()).toBe(custom);
    store.beginTurn(currentContext);
    const filePath = store.write(currentContext, 'plan');
    expect(existsSync(filePath)).toBe(true);
    expect(filePath.startsWith(custom)).toBe(true);
  });

  it('plansDirOverride：相对路径相对 cwd 解析', () => {
    const store = new PlanStore(join(tempDir, 'micode'), 'rel-plans');
    expect(store.getPlansDir()).toBe(join(process.cwd(), 'rel-plans'));
    // 清理测试副产物
    rmSync(store.getPlansDir(), { recursive: true, force: true });
  });

  it('plansDirOverride 省略时回退默认 baseDir/plans', () => {
    const baseDir = join(tempDir, 'micode');
    const store = new PlanStore(baseDir);
    expect(store.getPlansDir()).toBe(join(baseDir, 'plans'));
  });
});

describe('write_plan_file 工具', () => {
  const context = { sessionId: 'sess-1', turnId: 'turn-1' };
  it('definition 字段正确', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { definition } = createWritePlanTool(store, () => context);
    expect(definition.name).toBe('write_plan_file');
    expect(definition.parameters.required).toEqual(['content']);
  });

  it('executor 写盘成功', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.beginTurn(context);
    const { executor } = createWritePlanTool(store, () => context);
    const result = await executor({ content: '# Plan\nDo X' });
    expect(result).toMatch(/Plan written/);
    expect(store.getActive(context)?.content).toContain('# Plan');
  });

  it('空 content 返回 Error', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { executor } = createWritePlanTool(store, () => context);
    const result = await executor({ content: '' });
    expect(result).toMatch(/Error/i);
  });
});

describe('read_plan_file 工具', () => {
  const context = { sessionId: 'sess-1', turnId: 'turn-1' };
  it('definition 字段正确', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { definition } = createReadPlanTool(store, () => context);
    expect(definition.name).toBe('read_plan_file');
    expect(definition.parameters.required).toEqual([]);
  });

  it('executor 返回剥离 frontmatter 的计划正文', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    store.beginTurn(context);
    store.write(context, '# Plan\nDo X');
    const { executor } = createReadPlanTool(store, () => context);
    const result = await executor({});
    // 正文保留，frontmatter 被剥离
    expect(result).toContain('# Plan');
    expect(result).toContain('Do X');
    expect(result).not.toMatch(/^---\n/);
    expect(result).not.toContain('status: pending');
  });

  it('无计划时返回 Error', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { executor } = createReadPlanTool(store, () => context);
    const result = await executor({});
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/write_plan_file/);
  });
});

describe('exit_plan_mode 工具', () => {
  const QUESTION = 'Claude 已拟定执行方案，是否继续？';
  const AUTO_CLEAR = '确认执行，清空上下文并使用自动模式';
  const AUTO_KEEP = '确认执行，使用自动模式';
  const BUILD_KEEP = '确认执行，手动审核修改';
  const translator = createTranslator(createLanguageStore('zh-CN'));

  function makeManager() {
    const ui = {
      open: vi.fn<(id: string, request: AskQuestionRequest, done: AskQuestionOutcomeCallback) => void>(),
      close: vi.fn<(id: string) => void>(),
    };
    return { manager: new AskUserManager(ui), ui };
  }

  function createReadyTool(usagePercent = 22) {
    const store = new PlanStore(join(tempDir, 'micode'));
    const context = { sessionId: 'sess-1', turnId: 'turn-1' };
    store.beginTurn(context);
    store.write(context, 'plan body');
    const { manager, ui } = makeManager();
    const onApprove = vi.fn<(mode: 'auto' | 'build', clearContext: boolean) => void>();
    const tool = createExitPlanModeTool(manager, store, translator, {
      getUsagePercent: () => usagePercent,
      onApprove,
      getPlanContext: () => context,
    });
    return { store, context, ui, onApprove, tool };
  }

  function settle(
    ui: ReturnType<typeof makeManager>['ui'],
    outcome: AskQuestionOutcome,
  ): void {
    const [id, , done] = ui.open.mock.calls[0]!;
    done(id, outcome);
  }

  it('definition 字段正确', () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { manager } = makeManager();
    const { definition } = createExitPlanModeTool(manager, store, translator, {
      getUsagePercent: () => 0,
      onApprove: () => {},
      getPlanContext: () => ({ sessionId: 'sess-1', turnId: 'turn-1' }),
    });
    expect(definition.name).toBe('exit_plan_mode');
  });

  it('无 plan 时返回 Error', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const { manager, ui } = makeManager();
    const { executor } = createExitPlanModeTool(manager, store, translator, {
      getUsagePercent: () => 0,
      onApprove: () => {},
      getPlanContext: () => ({ sessionId: 'sess-1', turnId: 'turn-1' }),
    });
    const result = await executor({});
    expect(result).toMatch(/Error/i);
    expect(result).toMatch(/write_plan_file/);
    expect(ui.open).not.toHaveBeenCalled();
  });

  it('opens the normalized three-option approval questionnaire', async () => {
    const { ui, tool } = createReadyTool();

    const pending = tool.executor({});
    const request = ui.open.mock.calls[0]![1];

    expect(request.questions).toHaveLength(1);
    expect(request.questions[0]).toMatchObject({
      question: QUESTION,
      header: 'Plan',
      multiSelect: false,
    });
    expect(request.questions[0]!.options).toEqual([
      {
        label: AUTO_CLEAR,
        description: '重置对话（已占用 22%），Agent 自动执行所有修改',
        value: PLAN_APPROVAL_OPTION_VALUES.autoClear,
      },
      {
        label: AUTO_KEEP,
        description: '保留当前上下文，Agent 自动执行所有修改',
        value: PLAN_APPROVAL_OPTION_VALUES.autoKeep,
      },
      {
        label: BUILD_KEEP,
        description: '保留当前上下文，每步修改需你确认',
        value: PLAN_APPROVAL_OPTION_VALUES.buildKeep,
      },
    ]);
    expect(request.otherLabel).toBe('提出修改意见');
    expect(request.presentation).toEqual({
      kind: 'plan-approval',
      content: 'plan body\n',
      filePath: expect.stringMatching(/\.md$/),
    });
    settle(ui, { kind: 'cancelled' });
    await pending;
  });

  it('keeps presentation metadata out of the public tool schema', () => {
    const { tool } = createReadyTool();
    expect(JSON.stringify(tool.definition.parameters)).not.toContain('presentation');
  });

  it.each([
    { label: AUTO_CLEAR, value: PLAN_APPROVAL_OPTION_VALUES.autoClear, mode: 'auto' as const, clearContext: true },
    { label: AUTO_KEEP, value: PLAN_APPROVAL_OPTION_VALUES.autoKeep, mode: 'auto' as const, clearContext: false },
    { label: BUILD_KEEP, value: PLAN_APPROVAL_OPTION_VALUES.buildKeep, mode: 'build' as const, clearContext: false },
  ])('approves $label before resolving and maps it to $mode/$clearContext', async ({ label, value, mode, clearContext }) => {
    const events: string[] = [];
    const { store, context, ui, onApprove, tool } = createReadyTool();
    onApprove.mockImplementation(() => { events.push('approved'); });
    const outcome: AskQuestionOutcome = {
      kind: 'submitted',
      answers: { [QUESTION]: label },
      answerValues: { [QUESTION]: value },
    };

    const resultPromise = tool.executor({}).then((result) => {
      events.push('resolved');
      return result;
    });
    settle(ui, outcome);

    await expect(resultPromise).resolves.toBe(
      `User has answered your questions: ${JSON.stringify(QUESTION)}=${JSON.stringify(label)}. You can now continue with the user's answers in mind.`,
    );
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onApprove).toHaveBeenCalledWith(mode, clearContext);
    expect(events).toEqual(['approved', 'resolved']);
    expect(store.recoverLatestForSession(context.sessionId)!.content).toContain('status: approved');
  });

  it.each([
    {
      name: 'Other text',
      outcome: { kind: 'submitted', answers: { [QUESTION]: '请改用 Redis' } } as AskQuestionOutcome,
      expected: `User has answered your questions: ${JSON.stringify(QUESTION)}=${JSON.stringify('请改用 Redis')}. You can now continue with the user's answers in mind.`,
    },
    {
      name: 'Escape',
      outcome: { kind: 'cancelled' } as AskQuestionOutcome,
      expected: 'User declined to answer questions',
    },
    {
      name: 'Chat',
      outcome: { kind: 'chat', feedback: 'I need to clarify the plan.' } as AskQuestionOutcome,
      expected: 'I need to clarify the plan.',
    },
  ])('leaves the plan pending for $name and returns standard serialization', async ({ outcome, expected }) => {
    const { store, context, ui, onApprove, tool } = createReadyTool();

    const resultPromise = tool.executor({});
    settle(ui, outcome);

    await expect(resultPromise).resolves.toBe(expected);
    expect(onApprove).not.toHaveBeenCalled();
    expect(store.getActive(context)!.content).toContain('status: pending');
  });
});

describe('current turn plan isolation', () => {
  const translator = createTranslator(createLanguageStore('zh-CN'));
  it('does not open approval for an old plan when the current turn has not written one', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const oldContext = { sessionId: 'old-session', turnId: 'old-turn' };
    const currentContext = { sessionId: 'current-session', turnId: 'current-turn' };
    store.beginTurn(oldContext);
    store.write(oldContext, 'old plan that must stay private');
    store.beginTurn(currentContext);
    const ui = {
      open: vi.fn<(id: string, request: AskQuestionRequest, done: AskQuestionOutcomeCallback) => void>(),
      close: vi.fn<(id: string) => void>(),
    };
    const manager = new AskUserManager(ui);
    const deps = {
      getUsagePercent: () => 0,
      onApprove: () => {},
      getPlanContext: () => currentContext,
    };
    const { executor } = createExitPlanModeTool(manager, store, translator, deps);
    const execution = executor({});
    const call = ui.open.mock.calls[0];
    if (call) {
      const [id, , done] = call;
      done(id, { kind: 'cancelled' });
    }

    expect(ui.open).not.toHaveBeenCalled();
    await expect(execution).resolves.toBe(
      'Error: No plan was written in the current turn. Call write_plan_file first.',
    );
  });

  it('exit_plan_mode presents only the pending plan written in its current turn', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const oldContext = { sessionId: 'session', turnId: 'old-turn' };
    const currentContext = { sessionId: 'session', turnId: 'current-turn' };
    store.beginTurn(oldContext);
    store.write(oldContext, 'old plan');
    store.beginTurn(currentContext);
    store.write(currentContext, 'current plan');
    const ui = {
      open: vi.fn<(id: string, request: AskQuestionRequest, done: AskQuestionOutcomeCallback) => void>(),
      close: vi.fn<(id: string) => void>(),
    };
    const tool = createExitPlanModeTool(new AskUserManager(ui), store, translator, {
      getUsagePercent: () => 0,
      onApprove: () => {},
      getPlanContext: () => currentContext,
    });

    const pending = tool.executor({});
    expect(ui.open.mock.calls[0]![1].presentation?.content).toBe('current plan\n');
    ui.open.mock.calls[0]![2](ui.open.mock.calls[0]![0], { kind: 'cancelled' });
    await pending;
  });

  it('marks the captured plan after approval rotates the session context', async () => {
    const store = new PlanStore(join(tempDir, 'micode'));
    const writtenContext = { sessionId: 'session', turnId: 'turn' };
    let context = writtenContext;
    store.beginTurn(context);
    store.write(context, 'plan to approve');
    const ui = {
      open: vi.fn<(id: string, request: AskQuestionRequest, done: AskQuestionOutcomeCallback) => void>(),
      close: vi.fn<(id: string) => void>(),
    };
    const tool = createExitPlanModeTool(new AskUserManager(ui), store, translator, {
      getUsagePercent: () => 0,
      getPlanContext: () => context,
      onApprove: () => { context = { sessionId: 'rotated', turnId: 'next-turn' }; },
    });

    const pending = tool.executor({});
    ui.open.mock.calls[0]![2](ui.open.mock.calls[0]![0], {
      kind: 'submitted',
      answers: { 'Claude 已拟定执行方案，是否继续？': '确认执行，使用自动模式' },
      answerValues: { 'Claude 已拟定执行方案，是否继续？': PLAN_APPROVAL_OPTION_VALUES.autoKeep },
    });
    await pending;
    expect(store.recoverLatestForSession(writtenContext.sessionId)!.content).toContain('status: approved');
  });
});
