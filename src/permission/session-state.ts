// src/permission/session-state.ts
//
// SessionState:唯一的 session mutation boundary。
//
// 物理本质:sessionId 是一把"当前会话钥匙"。换钥匙时必须同步清空所有绑定这把钥匙
// 的 session 级缓存(当前是 SessionAllowlist)。本类把这把钥匙封装起来——
// 外部只能读 currentId,不能直接写;切换只能经 transitionTo,由它统一清缓存。
//
// 设计意图:结构上消除"调用方直接赋值 sessionId 而忘记 clear"的双写风险。
// rotate / hard rewind / resume 三条生产路径都只能调 transitionTo,
// 不存在绕过 transitionTo 直接改 id 的旁路。
//
// Task 2 扩展（设计 §3、§8、§10 A64/A88）：
//   - permissionSnapshot：当前 { mode, rules, strippedDangerousRules }，frozen。
//     变换只经 applyPermissionUpdate（委托 permission-updates.ts，不内嵌规则变换）。
//   - denialState：auto 拒绝计数 { consecutive, total }。allow 重置 consecutive，保留 total。
//   - transitionTo(不同 id)：清 allowlist + denial + stash（瞬态全清）；
//     持久规则的稳定态由后续 reload(replaceRules) 重建。
//   - transitionTo(相同 id)：no-op，保留全部瞬态。
//
// 不变量:
//   - currentId 只读(getter,无 setter);TypeScript 编译期禁止外部赋值
//   - transitionTo(newId):newId !== currentId → clear + 更新;相同 → 不 clear
//   - 同 session 跨 turn(transitionTo 相同 id)→ 保留 allowlist 记忆

import type { SessionAllowlist } from './session-allowlist.js';
import {
  applyPermissionUpdate as applyUpdate,
  type PermissionSnapshot,
  type PermissionUpdate,
} from './permission-updates.js';
import type { PromptAttachment } from '../agent/prompt/auto-attachments.js';

/** auto 拒绝计数（设计 §3 AutoPermissionState.denial） */
export interface DenialState {
  readonly consecutive: number;
  readonly total: number;
}

const EMPTY_SNAPSHOT: PermissionSnapshot = Object.freeze({
  mode: 'build',
  rules: Object.freeze([]) as readonly never[],
  strippedDangerousRules: Object.freeze([]) as readonly never[],
});

export class SessionState {
  private _currentId: string;
  private readonly allowlist: SessionAllowlist;
  private _snapshot: PermissionSnapshot = EMPTY_SNAPSHOT;
  private _denial: DenialState = { consecutive: 0, total: 0 };
  /**
   * auto_mode_exit attachment 队列（设计 §11 / A75）。
   * 每次 exit auto 时入队一个 attachment；takeAttachments 消费并清空。
   * transitionTo 清空此队列（A88）。
   */
  private _attachments: PromptAttachment[] = [];

  constructor(allowlist: SessionAllowlist, initialId: string) {
    this.allowlist = allowlist;
    this._currentId = initialId;
  }

  /** 当前 sessionId(只读)。外部不可直接赋值。 */
  get currentId(): string {
    return this._currentId;
  }

  /** 当前权限快照（只读 frozen）。变换只经 applyPermissionUpdate。 */
  get permissionSnapshot(): PermissionSnapshot {
    return this._snapshot;
  }

  /** 当前 auto 拒绝计数（只读）。 */
  get denialState(): DenialState {
    return this._denial;
  }

  /** 暴露 session allowlist（供交互链/测试只读访问）。 */
  get sessionAllowlist(): SessionAllowlist {
    return this.allowlist;
  }

  /** 是否有未消费的 auto_mode_exit attachment（设计 §10 A88）。 */
  get exitAttachmentPending(): boolean {
    return this._attachments.length > 0;
  }

  /**
   * 切换到新 sessionId。唯一允许的 session 变更入口。
   * newId !== currentId → 清空 session 级瞬态缓存(allowlist + denial + stash)+ 更新 id。
   * newId === currentId → 不清空(同 session 跨 turn 保留记忆)。
   *
   * 清空范围（设计 §10 A88）：allowlist、denial、dangerous stash、attachment pending。
   * mode 保留（mode 是会话语义，非瞬态缓存）；rules 清空（持久规则由后续 reload 重建，
   * A64 的稳定态由 reload/repartition 决定）。
   */
  transitionTo(newId: string): void {
    if (newId !== this._currentId) {
      this.allowlist.clear();
      this._denial = { consecutive: 0, total: 0 };
      // 清瞬态：stash + rules + attachment 队列归零，但保留 mode（会话语义）
      const keptMode = this._snapshot.mode;
      this._snapshot = Object.freeze({
        mode: keptMode,
        rules: Object.freeze([]) as readonly never[],
        strippedDangerousRules: Object.freeze([]) as readonly never[],
      });
      this._attachments = [];
    }
    this._currentId = newId;
  }

  /**
   * 应用 PermissionUpdate（唯一规则/模式变换入口）。
   * 委托 permission-updates.ts 的 applyPermissionUpdate，不内嵌规则变换逻辑。
   */
  applyPermissionUpdate(update: PermissionUpdate): PermissionSnapshot {
    this._snapshot = applyUpdate(this._snapshot, update);
    return this._snapshot;
  }

  /** 记录一次 auto 拒绝（consecutive +1, total +1）。 */
  recordDenial(): void {
    this._denial = {
      consecutive: this._denial.consecutive + 1,
      total: this._denial.total + 1,
    };
  }

  /** 记录一次 allow（consecutive 重置 0, total 保留）。 */
  recordAllow(): void {
    this._denial = { consecutive: 0, total: this._denial.total };
  }

  /**
   * 退出 auto 模式时入队一个 auto_mode_exit attachment（设计 §11 / A75）。
   *
   * 每次 session transition（从 auto 退出）最多产生一个 attachment（debounce）。
   * 非 auto 模式下调用为 no-op。
   * takeAttachments 消费并清空队列。
   */
  exitAuto(): void {
    if (this._snapshot.mode !== 'auto') return;
    // debounce：已有 pending attachment 不再追加
    if (this._attachments.length > 0) return;
    this._attachments.push({ type: 'auto_mode_exit' });
  }

  /**
   * 消费并返回当前所有 attachment，清空队列（设计 §11 / A75）。
   */
  takeAttachments(): PromptAttachment[] {
    const out = this._attachments;
    this._attachments = [];
    return out;
  }
}
