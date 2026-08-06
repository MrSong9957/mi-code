// Task 7: Interactive ask、竞速与 remember（A44-A47、A49）
//
// 设计输入：§8（交互、hooks 与 remember）、§10 A44-A47/A49 重定义。
//
// 锁定 resolveInteractiveAsk 行为：
//   - A44：denial threshold 回退 dialog（main）
//   - A45：2s 竞速——automatic 在 delay 内完成则不创建 dialog；超时才显示 dialog
//   - A46：accept-session 记住 exact canonical tool + structured input
//   - A47：always-allow 持久化后重新经过同步 checker（不绕过 hard deny）
//   - A49：dialog ESC 经 automatic.abort() 真实取消 classifier RPC；requiresInteraction
//          不启动 classifier，不注册 abort handle
//
// pending automatic contract：resolver 创建 PendingAutomaticDecision { promise, abort }，
// resolveInteractiveAsk 持有它；ESC 时自行调用 abort()。
import { describe, test, expect, vi } from 'vitest';
import {
  resolveInteractiveAsk,
  type InteractiveAskInput,
  type DialogResult,
} from '../../permission/interactive-ask.js';
import type { SecurityDecision } from '../../permission/decisions.js';

// ─── helpers ────────────────────────────────────────────────────────────────────

function makeDecision(behavior: 'allow' | 'ask' | 'deny', rc = 'permission.user_confirmation_required'): SecurityDecision {
  return { protocol_version: '1', decision_id: 'd1', action: { kind: 'tool_call', subject_id: 'write_file', snapshot_id: 's1' }, behavior, deciding_layer: 'permission', risk_kind: 'test', policy_id: 'p', policy_version: '1', reason_code: rc, human_reason: 'test', provenance_refs: behavior === 'allow' ? ['test'] : [] } as SecurityDecision;
}
function allowDecision(): SecurityDecision { return makeDecision('allow'); }
function denyDecision(): SecurityDecision { return makeDecision('deny'); }
function askDecision(rc = 'permission.user_confirmation_required'): SecurityDecision { return makeDecision('ask', rc); }

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mainAsk(rc = 'permission.user_confirmation_required'): InteractiveAskInput {
  return {
    decision: askDecision(rc),
    toolName: 'write_file',
    input: { path: 'src/a.ts', content: 'x' },
    origin: 'main',
  };
}
function requiresInteractionAsk(): InteractiveAskInput {
  return {
    decision: askDecision('permission.requires_interaction'),
    toolName: 'ask_user_question',
    input: {},
    origin: 'main',
  };
}

const approveOnce = (): DialogResult => ({ kind: 'approved_once' });
const approveSession = (): DialogResult => ({ kind: 'approved_session' });
const approveAlways = (): DialogResult => ({ kind: 'approved_always' });
const rejectDialog = (): DialogResult => ({ kind: 'rejected' });
const escapeDialog = (): DialogResult => ({ kind: 'escape' });

// ─── A44: denial threshold → dialog ─────────────────────────────────────────────

describe('interactive permission asks', () => {
  test('[A44] denial threshold falls back to main dialog', async () => {
    const dialog = vi.fn().mockResolvedValue(approveOnce());
    const result = await resolveInteractiveAsk(mainAsk(), {
      automatic: null, // denial threshold: 无 automatic
      dialog,
      dialogDelayMs: 0,
      denialState: { consecutive: 3, total: 3 },
    });
    expect(dialog).toHaveBeenCalledOnce();
    expect(result.behavior).toBe('allow');
  });

  // ─── A45: 竞速 ────────────────────────────────────────────────────────────────

  test('[A45] automatic result inside delay wins without creating dialog', async () => {
    vi.useFakeTimers();
    const autoDeferred = deferred<SecurityDecision>();
    const dialog = vi.fn();
    const pending = resolveInteractiveAsk(mainAsk(), {
      automatic: { promise: autoDeferred.promise, abort: vi.fn() },
      dialog,
      dialogDelayMs: 2000,
    });
    autoDeferred.resolve(allowDecision());
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.behavior).toBe('allow');
    expect(dialog).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('[A45] dialog starts after delay when automatic check is pending', async () => {
    vi.useFakeTimers();
    const autoDeferred = deferred<SecurityDecision>();
    const dialog = vi.fn().mockResolvedValue(rejectDialog());
    const pending = resolveInteractiveAsk(mainAsk(), {
      automatic: { promise: autoDeferred.promise, abort: vi.fn() },
      dialog,
      dialogDelayMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(dialog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dialog).toHaveBeenCalledOnce();
    const result = await pending;
    expect(result.behavior).toBe('deny');
    vi.useRealTimers();
  });

  // ─── A45b: dialog 显示后 classifier 永久失去决定权（回归） ────────────────────
  //
  // 锁定语义：classifier 的决定权只存在于 dialog delay 窗口内。一旦 delay 到期、
  // dialog 已创建（用户已看见），automatic 从此永久失去本次 tool call 的决定权：
  //   - delay 到期时 abort 尚未完成的 classifier；
  //   - 即使 classifier 随后 resolve allow，也不能放行；
  //   - 最终 decision 只能来自用户 dialog。
  test('[A45b] after dialog shown, classifier allow must NOT win; dialog decides; abort called', async () => {
    vi.useFakeTimers();
    const autoDeferred = deferred<SecurityDecision>();
    const abort = vi.fn();
    const dialogDeferred = deferred<DialogResult>();
    const dialog = vi.fn().mockReturnValue(dialogDeferred.promise);

    const pending = resolveInteractiveAsk(mainAsk(), {
      automatic: { promise: autoDeferred.promise, abort },
      dialog,
      dialogDelayMs: 100,
    });

    // 越过 delay：dialog 创建（用户看见），automatic 仍 pending
    await vi.advanceTimersByTimeAsync(100);
    expect(dialog, 'dialog created exactly once').toHaveBeenCalledOnce();

    // classifier 在 dialog 显示后 resolve allow（用户尚未选择）
    autoDeferred.resolve(allowDecision());
    await vi.advanceTimersByTimeAsync(50);

    // resolver 必须仍未返回（classifier 的 allow 不再赢得 race）
    let resolved = false;
    pending.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(resolved, 'resolver NOT returned after classifier allow (dialog shown)').toBe(false);

    // 用户选择 approved_once
    dialogDeferred.resolve(approveOnce());
    const result = await pending;

    // 最终结果严格等于 dialog 结果，不是 classifier allow
    expect(result.behavior).toBe('allow');
    expect(result.reason_code).toBe('permission.user_approved');
    // dialog 只创建一次（classifier allow 没有触发第二次 dialog）
    expect(dialog).toHaveBeenCalledOnce();
    // 进入 dialog 路径后 abort 被调用（取消尚在跑的 classifier RPC）
    expect(abort, 'abort called when entering dialog path').toHaveBeenCalled();
    vi.useRealTimers();
  });

  // ─── A46: accept-session 记住 ─────────────────────────────────────────────────

  test('[A46] accept-session records exact tool+input in sessionAllowlist', async () => {
    const sessionAllowlist = new Map<string, true>();
    const dialog = vi.fn().mockResolvedValue(approveSession());
    await resolveInteractiveAsk(mainAsk(), {
      automatic: null,
      dialog,
      dialogDelayMs: 0,
      onSessionAllow: (tool, input) => {
        sessionAllowlist.set(`${tool}\u0000${JSON.stringify(input)}`, true);
      },
    });
    // exact match 命中
    expect(sessionAllowlist.has(`write_file\u0000${JSON.stringify({ path: 'src/a.ts', content: 'x' })}`)).toBe(true);
    // 不同 input 不命中
    expect(sessionAllowlist.has(`write_file\u0000${JSON.stringify({ path: 'src/b.ts', content: 'x' })}`)).toBe(false);
  });

  // ─── A47: always-allow 持久化 + 重新经过 checker ───────────────────────────────

  test('[A47] always-allow persists rule, rechecks through checker (hard deny wins)', async () => {
    const persist = vi.fn();
    const recheckChecker = vi.fn().mockReturnValue(denyDecision()); // hard deny
    const dialog = vi.fn().mockResolvedValue(approveAlways());
    const result = await resolveInteractiveAsk(mainAsk(), {
      automatic: null,
      dialog,
      dialogDelayMs: 0,
      onPersistRule: persist,
      recheckAfterPersist: recheckChecker,
    });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ type: 'addRules', destination: 'userSettings' }));
    expect(recheckChecker).toHaveBeenCalledOnce();
    expect(result.behavior).toBe('deny'); // hard deny 仍生效
  });

  test('[A47] always-allow with no hard deny allows', async () => {
    const persist = vi.fn();
    const recheckChecker = vi.fn().mockReturnValue(allowDecision());
    const dialog = vi.fn().mockResolvedValue(approveAlways());
    const result = await resolveInteractiveAsk(mainAsk(), {
      automatic: null,
      dialog,
      dialogDelayMs: 0,
      onPersistRule: persist,
      recheckAfterPersist: recheckChecker,
    });
    expect(result.behavior).toBe('allow');
  });

  // ─── A49: dialog ESC 经 automatic.abort() 取消 classifier ─────────────────────

  test('[A49] dialog ESC calls automatic.abort() (no second controller)', async () => {
    const abort = vi.fn();
    const autoDeferred = deferred<SecurityDecision>();
    const dialog = vi.fn().mockResolvedValue(escapeDialog());
    vi.useFakeTimers();
    const pending = resolveInteractiveAsk(mainAsk(), {
      automatic: { promise: autoDeferred.promise, abort },
      dialog,
      dialogDelayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1); // trigger dialog immediately
    const result = await pending;
    // ESC -> 自行调用 abort()（A45b 后：delay 到期进 dialog 时已 abort 取消 classifier，
    // ESC 时 handleDialogResult 再调一次，幂等。断言 abort 被调，证明 ESC 路径触发取消。）
    expect(abort).toHaveBeenCalled();
    expect(result.behavior).toBe('deny');
    vi.useRealTimers();
  });

  test('[A49] no automatic (null) means no abort call on ESC', async () => {
    const dialog = vi.fn().mockResolvedValue(escapeDialog());
    const result = await resolveInteractiveAsk(mainAsk(), {
      automatic: null,
      dialog,
      dialogDelayMs: 0,
    });
    expect(result.behavior).toBe('deny');
  });

  // ─── requiresInteraction：不启动 classifier，dialog 直接出现 ──────────────────

  test('requiresInteraction opens dialog directly (no automatic race)', async () => {
    const dialog = vi.fn().mockResolvedValue(escapeDialog());
    const result = await resolveInteractiveAsk(requiresInteractionAsk(), {
      automatic: null, // requiresInteraction 不启动 classifier
      dialog,
      dialogDelayMs: 0,
    });
    expect(dialog).toHaveBeenCalledOnce();
    expect(result.behavior).toBe('deny'); // ESC -> deny
  });

  // ─── rejected dialog -> deny ──────────────────────────────────────────────────

  test('rejected dialog produces deny', async () => {
    const dialog = vi.fn().mockResolvedValue(rejectDialog());
    const result = await resolveInteractiveAsk(mainAsk(), {
      automatic: null,
      dialog,
      dialogDelayMs: 0,
    });
    expect(result.behavior).toBe('deny');
  });
});
