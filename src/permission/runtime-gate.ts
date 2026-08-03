// Wave B Task 13 (M-066): RuntimeSecurityGate —— 真正阻塞的 ask 闸门。
//
// 物理本质:银行柜台的双重确认窗口。
//   - allow / deny: 自动出闸(无人值守,即时返回)。
//   - ask: **必须**按下叫号器(channel.request),等用户(approved_once)走到窗口签字才能放行;
//          没人值守(channel=null)→ 直接关门(no_channel),绝不偷偷降级为 allow。
//
// 九大不变量(对应任务 self-review checkpoint):
//   1. ask 在 approved_once 到位前,executor 调用次数必须为 0;
//   2. channel=null 时 ask 绝不降级为 allow(只 deny);
//   3. approved_once 一次即消费,不可对同一 SecurityDecision 重放;
//   4. action snapshot 改变→旧 approved_once 失效(每次 ask 是独立的 channel round-trip);
//   5. ask 不产出 tool result 占位(由调用方负责);
//   6. 不写永久 allow 规则(store 上只有 status/resolved_at/user_decision_ref 的 update);
//   7. channel 失败 / 拒绝→ 不继续执行(只 deny);
//   8. 不实现 delegation handoff classifier(M-067, Wave C);
//   9. 只动允许的文件集合。
//
// Spec: docs/superpowers/specs/2026-07-26-agent-primary-anchors-wave-b-design.md §12.3 (BRC-6)。

import { randomUUID } from 'crypto';
import type { SecurityDecision, UserDecision } from './decisions.js';
import { logPermissionDecision, type PermissionAuditSink } from './audit.js';

// ─────────────────────────────────────────────
// 类型(spec §12.3 逐字落地)
// ─────────────────────────────────────────────

export interface ActionProvenance {
  action_snapshot_id: string;
  origin_scope: 'local' | 'cross_machine' | 'unknown';
  origin_ref: string;
  propagation_refs: string[];
  content_trust: 'trusted' | 'untrusted' | 'unknown';
}

export interface PendingSecurityDecision {
  decision_id: string;
  action_snapshot_id: string;
  session_id: string;
  status: 'awaiting_user' | 'approved_once' | 'rejected' | 'expired';
  created_at: string;
  resolved_at: string | null;
  user_decision_ref: string | null;
}

export type AuthorizedAction = {
  kind: 'authorized';
  decision_id: string;
  action_snapshot_id: string;
  /** 透传自 UserDecision.remember。调用方据此写 session allowlist。 */
  remember?: boolean;
};

export type DeniedAction = {
  kind: 'denied';
  decision_id: string;
  reason_code: string;
  human_reason: string;
};

/** 请求用户决策的通道(由调用方提供 UI transport 适配器)。 */
export interface UserDecisionChannel {
  /** 请求用户对一个 pending SecurityDecision 的回应。resolve 时拿到 UserDecision。 */
  request(decision: SecurityDecision): Promise<UserDecision>;
}

/** PendingDecision 持久化接口(由 SessionStore 实现)。 */
export interface PendingDecisionStore {
  save(pending: PendingSecurityDecision): Promise<void>;
  load(sessionId: string): Promise<readonly PendingSecurityDecision[]>;
  update(decisionId: string, update: Partial<PendingSecurityDecision>): Promise<void>;
}

/** Gate 构造参数。 */
export interface RuntimeSecurityGateOptions {
  pendingStore: PendingDecisionStore;
  channel: UserDecisionChannel | null;
  /** 可选:用于 derive pending.session_id(默认 'runtime-gate')。 */
  sessionId?: string;
  /**
   * Task 13 A86: 权限审计 sink。
   * authorize 在最终决定出口（return 前）调用一次，发出 result event。
   * sink 异常被静默吞掉，不改变授权结果（设计 §9）。
   * 不传 → LEGACY 行为（无审计）。
   */
  auditSink?: PermissionAuditSink;
}

// ─────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────

/**
 * RuntimeSecurityGate: ask → block → resolve 的运行时闸门。
 *
 * 关键不变量(再次声明,实现里逐条遵守):
 *   - allow → 立即 authorized,不动 channel、不写 pending。
 *   - deny  → 立即 denied,不动 channel、不写 pending。
 *   - ask   → 写 pending(awaiting_user);channel=null → expired + denied(ask.no_channel);
 *             有 channel → await request;UserDecision.response=approved_once 且 decision_id 匹配
 *             → pending approved_once + authorized(消费,不缓存);
 *             UserDecision.response=rejected → pending rejected + denied(ask.user_rejected);
 *             UserDecision.decision_id 不匹配 → denied(ask.stale_decision_id);
 *             channel.request reject(故障) → denied(ask.channel_failed)。
 */
export class RuntimeSecurityGate {
  /** 测试用:暴露 options 让 test 取出 channel 做 resolve(非生产 API,仅测试访问)。 */
  public readonly options: RuntimeSecurityGateOptions;
  private readonly pendingStore: PendingDecisionStore;
  private readonly channel: UserDecisionChannel | null;
  private readonly sessionId: string;
  private readonly auditSink?: PermissionAuditSink;

  constructor(options: RuntimeSecurityGateOptions) {
    this.options = options;
    this.pendingStore = options.pendingStore;
    this.channel = options.channel;
    this.sessionId = options.sessionId ?? 'runtime-gate';
    this.auditSink = options.auditSink;
  }

  /**
   * Authorize 一个 action。绝不调用 executor——executor 由调用方在 authorized 时自行调用,
   * 或用 execute() 便利方法。
   *
   * Task 13 A86：在最终决定出口发出恰好一个 result audit event（如果提供了 auditSink）。
   * audit 异常被静默吞掉，不改变授权结果。
   */
  async authorize(decision: SecurityDecision): Promise<AuthorizedAction | DeniedAction> {
    const startTime = performance.now();
    const result = await this.authorizeInternal(decision);
    // 最终决定出口：fan-out 恰好一个 result audit event
    if (this.auditSink) {
      const latencyMs = performance.now() - startTime;
      const behavior: 'allow' | 'deny' = result.kind === 'authorized' ? 'allow' : 'deny';
      const reasonCode = result.kind === 'denied' ? result.reason_code : decision.reason_code;
      logPermissionDecision(
        {
          decisionId: decision.decision_id,
          toolName: decision.action.subject_id,
          behavior,
          reasonCode,
          source: decision.deciding_layer,
          latencyMs,
        },
        this.auditSink,
      );
    }
    return result;
  }

  /**
   * authorize 内部逻辑（无 audit）。6 个出口点返回 authorized/denied。
   */
  private async authorizeInternal(decision: SecurityDecision): Promise<AuthorizedAction | DeniedAction> {
    // ─── allow ───
    if (decision.behavior === 'allow') {
      // 不动 channel、不写 pending(allow 不是永久规则,只是 per-action-snapshot 的即时放行)
      return {
        kind: 'authorized',
        decision_id: decision.decision_id,
        action_snapshot_id: decision.action.snapshot_id,
      };
    }

    // ─── deny ───
    if (decision.behavior === 'deny') {
      return {
        kind: 'denied',
        decision_id: decision.decision_id,
        reason_code: decision.reason_code,
        human_reason: decision.human_reason,
      };
    }

    // ─── ask ───
    // 1. 先写 pending(awaiting_user),无论是否有 channel——便于审计 / resume。
    const pending: PendingSecurityDecision = {
      decision_id: decision.decision_id,
      action_snapshot_id: decision.action.snapshot_id,
      session_id: this.sessionId,
      status: 'awaiting_user',
      created_at: new Date().toISOString(),
      resolved_at: null,
      user_decision_ref: null,
    };
    await this.pendingStore.save(pending);

    // 2. channel=null → fail closed(no_channel)。绝不降级为 allow。
    if (this.channel === null) {
      await this.pendingStore.update(decision.decision_id, {
        status: 'expired',
        resolved_at: new Date().toISOString(),
      });
      return {
        kind: 'denied',
        decision_id: decision.decision_id,
        reason_code: 'ask.no_channel',
        human_reason: 'Asking the user is required, but no user-decision channel is available.',
      };
    }

    // 3. await channel.request —— 在这里阻塞,直到用户回应。
    //    channel.request 抛错 → 视为通道故障 → denied(ask.channel_failed),绝不放行。
    let userDecision: UserDecision;
    try {
      userDecision = await this.channel.request(decision);
    } catch (err) {
      await this.pendingStore.update(decision.decision_id, {
        status: 'expired',
        resolved_at: new Date().toISOString(),
      });
      const detail = err instanceof Error ? err.message : String(err);
      return {
        kind: 'denied',
        decision_id: decision.decision_id,
        reason_code: 'ask.channel_failed',
        human_reason: `Asking the user failed (channel error: ${detail}). Failing closed.`,
      };
    }

    // 4. UserDecision.decision_id 必须与 pending 的 decision_id 一致。
    //    不一致 → 陈旧 / 错位(可能是上一次会话遗留的 UserDecision)→ denied(ask.stale_decision_id)。
    if (userDecision.decision_id !== decision.decision_id) {
      await this.pendingStore.update(decision.decision_id, {
        status: 'rejected',
        resolved_at: new Date().toISOString(),
      });
      return {
        kind: 'denied',
        decision_id: decision.decision_id,
        reason_code: 'ask.stale_decision_id',
        human_reason:
          `User decision carried a mismatched decision_id ` +
          `(got ${userDecision.decision_id}, expected ${decision.decision_id}).`,
      };
    }

    // 5. 按 UserDecision.response 分支。
    if (userDecision.response === 'approved_once') {
      // approved_once 与 decision_id 已匹配 ⇒ 同一 action snapshot(每个 SecurityDecision 1:1 绑定其 snapshot)。
      // approved_once 一次即消费:本 gate 不缓存任何 cross-decision 批准,
      // 后续同 decision_id 的请求要么走完完整 ask 流程,要么因 decision_id 不匹配被拒。
      const userDecisionRef = `ud:${randomUUID()}`;
      await this.pendingStore.update(decision.decision_id, {
        status: 'approved_once',
        resolved_at: new Date().toISOString(),
        user_decision_ref: userDecisionRef,
      });
      return {
        kind: 'authorized',
        decision_id: decision.decision_id,
        action_snapshot_id: decision.action.snapshot_id,
        remember: userDecision.remember,
      };
    }

    // 6. rejected
    //    (UserDecision.response 只可能是 'approved_once' | 'rejected',
    //     但稳妥起见用 else 兜底,任何非 approved_once 都视为 rejected)
    await this.pendingStore.update(decision.decision_id, {
      status: 'rejected',
      resolved_at: new Date().toISOString(),
      user_decision_ref: `ud:${randomUUID()}`,
    });
    return {
      kind: 'denied',
      decision_id: decision.decision_id,
      reason_code: 'ask.user_rejected',
      human_reason: 'The user rejected this action.',
    };
  }

  /**
   * Authorize + 在 authorized 时执行 executor。
   *
   * 不变量:denied 时 **绝不** 调用 executor;authorized 时调用 executor 一次并返回其结果。
   *
   * 可选 options.onAuthorized 是 non-interfering observer:仅在 authorized 路径
   * (authorize 已返回 authorized)、executor 之前触发一次。其异常被 try/catch 吞掉,
   * 不阻止 executor、不改变 authorized(即不会把 authorized 变成 denied)。
   */
  async execute<T>(
    decision: SecurityDecision,
    executor: () => Promise<T>,
    options?: { onAuthorized?: (action: AuthorizedAction) => void },
  ): Promise<T | DeniedAction> {
    const outcome = await this.authorize(decision);
    if (outcome.kind === 'denied') {
      return outcome; // 不变:denied 绝不调 executor,也不触发 onAuthorized
    }
    // authorized:通知观察者(携带 remember 元数据)。observer 是 non-interfering:
    // 其异常不得阻止 executor、不得改变 authorized→denied。吞掉异常保证 executor 仍执行一次。
    if (options?.onAuthorized) {
      try {
        options.onAuthorized(outcome);
      } catch {
        // observer 故障不影响执行语义:executor 仍恰好执行一次,返回其结果。
        // 不记录、不重抛——observer 是纯观察点,无权影响授权/执行流。
      }
    }
    return await executor();
  }
}
