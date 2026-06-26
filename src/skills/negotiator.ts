// SkillNegotiator：S10 协商协议核心
//
// 物理本质：图书馆的"借书柜台"。
// 你要借书（加载技能），柜台先看你有没有借书证（确认流程），
// 再看你有没有逾期未还（跳过状态），最后才把书给你。

import type { SkillDocument, SkillUsageState } from './types.js';

/** 协商阶段 */
export type NegotiatePhase = 'loaded' | 'confirm' | 'blocked' | 'skipped' | 'editing' | 'feedback' | 'error';

/** 协商结果 */
export interface NegotiateResult {
  phase: NegotiatePhase;
  text: string;
  feedback?: string;
}

/** 确认结果 */
export interface ConfirmResult {
  phase: NegotiatePhase;
  text: string;
  feedback?: string;
}

/** 置信度阈值（S10 规范：>= 0.7 自动建议） */
const CONFIDENCE_THRESHOLD = 0.7;

export class SkillNegotiator {
  // per-user, per-skill 使用状态
  // key 格式: "userId:skillName"
  private usage = new Map<string, SkillUsageState>();

  // per-user 待确认的技能
  // key 格式: "userId:skillName"
  private pendingConfirmations = new Map<string, SkillDocument>();

  private makeKey(skillName: string, userId: string): string {
    return `${userId}:${skillName}`;
  }

  /** 获取使用状态 */
  getUsageState(skillName: string, userId: string): SkillUsageState | undefined {
    return this.usage.get(this.makeKey(skillName, userId));
  }

  /** 置信度是否达到建议阈值（>= 0.7） */
  shouldSuggest(confidence: number): boolean {
    return confidence >= CONFIDENCE_THRESHOLD;
  }

  /**
   * 阶段 1+2：协商
   *
   * 如果技能被拦截 → 返回 blocked
   * 如果技能被跳过 → 返回 skipped
   * 如果需要确认   → 返回 confirm（只含摘要 + [confirmation: need-confirm] 标签）
   * 否则           → 返回 loaded（全文）
   */
  negotiate(skill: SkillDocument, userId: string): NegotiateResult {
    const key = this.makeKey(skill.manifest.name, userId);
    const state = this.usage.get(key);

    // 检查拦截
    if (state?.blocked) {
      return { phase: 'blocked', text: `Skill "${skill.manifest.name}" is blocked.` };
    }

    // 检查跳过（不可重试）
    if (state?.skip) {
      return { phase: 'skipped', text: `Skill "${skill.manifest.name}" was skipped.` };
    }

    // 记录使用
    this.usage.set(key, {
      used: true,
      skip: false,
      blocked: false,
      loadConfirmation: skill.manifest.loadConfirmation,
    });

    // 需要确认 → 返回子集 + 标签
    if (skill.manifest.loadConfirmation === 'need-confirm') {
      this.pendingConfirmations.set(key, skill);
      return {
        phase: 'confirm',
        text: `[confirmation: need-confirm] Skill "${skill.manifest.name}": ${skill.manifest.description}`,
      };
    }

    // 无需确认 → 直接返回全文
    return {
      phase: 'loaded',
      text: `# ${skill.manifest.name}\n\n${skill.manifest.description}\n\n${skill.body}`,
    };
  }

  /**
   * 阶段 3：用户确认
   *
   * /y 或 空输入 → 返回全文
   * /n           → 跳过
   * /edit <text> → 编辑模式
   * 其他文本     → 反馈
   */
  confirm(skillName: string, input: string, userId: string): ConfirmResult {
    const key = this.makeKey(skillName, userId);
    const skill = this.pendingConfirmations.get(key);

    if (!skill) {
      return { phase: 'error', text: `No pending confirmation for "${skillName}".` };
    }

    // /y 或 Enter → 返回全文
    if (input === '/y' || input === '') {
      this.pendingConfirmations.delete(key);
      return {
        phase: 'loaded',
        text: `# ${skill.manifest.name}\n\n${skill.manifest.description}\n\n${skill.body}`,
      };
    }

    // /n → 跳过
    if (input === '/n') {
      this.pendingConfirmations.delete(key);
      const state = this.usage.get(key);
      if (state) state.skip = true;
      return { phase: 'skipped', text: `Skill "${skillName}" skipped.` };
    }

    // /edit <feedback> → 编辑模式
    if (input.startsWith('/edit')) {
      const feedback = input.slice('/edit'.length).trim();
      return { phase: 'editing', text: `Editing skill "${skillName}".`, feedback };
    }

    // 其他文本 → 反馈
    this.pendingConfirmations.delete(key);
    return { phase: 'feedback', text: `Feedback for "${skillName}".`, feedback: input };
  }

  /** 强制拦截（! 前缀触发） */
  block(skillName: string, userId: string): void {
    const key = this.makeKey(skillName, userId);
    const existing = this.usage.get(key);
    this.usage.set(key, {
      used: existing?.used ?? false,
      skip: existing?.skip ?? false,
      blocked: true,
    });
  }

  /** 取消跳过（用户显式 /skill retry） */
  unskip(skillName: string, userId: string): void {
    const key = this.makeKey(skillName, userId);
    const state = this.usage.get(key);
    if (state) state.skip = false;
  }

  /** 获取用户待确认的技能名（用于 /y /n /edit 等无参命令） */
  getPendingConfirmation(userId: string): string | undefined {
    for (const key of this.pendingConfirmations.keys()) {
      if (key.startsWith(`${userId}:`)) {
        return key.slice(userId.length + 1);
      }
    }
    return undefined;
  }
}
