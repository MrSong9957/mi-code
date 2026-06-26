import { describe, test, expect, beforeEach } from 'vitest';
import { SkillNegotiator } from '../negotiator.js';
import type { SkillDocument } from '../types.js';

// 测试用技能文档
const testSkill: SkillDocument = {
  manifest: {
    name: 'code-review',
    description: 'Checklist for reviewing code changes',
    source: 'project',
  },
  body: '## Code Review Checklist\n\n### Security\n- No hardcoded secrets',
};

const forkSkill: SkillDocument = {
  manifest: {
    name: 'dangerous-skill',
    description: 'A skill that runs in fork context',
    context: 'fork',
    source: 'project',
  },
  body: '## Dangerous operations',
};

const confirmSkill: SkillDocument = {
  manifest: {
    name: 'deploy',
    description: 'Deploy to production',
    loadConfirmation: 'need-confirm',
    source: 'project',
  },
  body: '## Deploy steps',
};

describe('SkillNegotiator', () => {
  let negotiator: SkillNegotiator;

  beforeEach(() => {
    negotiator = new SkillNegotiator();
  });

  // === 三阶段协商 ===

  describe('negotiate()', () => {
    test('returns subset with confirmation tag when loadConfirmation is need-confirm', () => {
      const result = negotiator.negotiate(confirmSkill, 'user-1');
      expect(result.phase).toBe('confirm');
      expect(result.text).toContain('[confirmation: need-confirm]');
      expect(result.text).toContain('deploy');
      expect(result.text).not.toContain('## Deploy steps'); // 不含全文
    });

    test('returns full text immediately when no confirmation needed', () => {
      const result = negotiator.negotiate(testSkill, 'user-1');
      expect(result.phase).toBe('loaded');
      expect(result.text).toContain('## Code Review Checklist');
      expect(result.text).not.toContain('[confirmation:');
    });

    test('tracks skill usage after negotiation', () => {
      negotiator.negotiate(testSkill, 'user-1');
      const state = negotiator.getUsageState('code-review', 'user-1');
      expect(state).toBeDefined();
      expect(state!.used).toBe(true);
    });
  });

  // === 确认流程 ===

  describe('confirm()', () => {
    test('returns full text on /y confirmation', () => {
      negotiator.negotiate(confirmSkill, 'user-1');
      const result = negotiator.confirm('deploy', '/y', 'user-1');
      expect(result.text).toContain('## Deploy steps');
      expect(result.phase).toBe('loaded');
    });

    test('returns full text on empty input (Enter) confirmation', () => {
      negotiator.negotiate(confirmSkill, 'user-1');
      const result = negotiator.confirm('deploy', '', 'user-1');
      expect(result.text).toContain('## Deploy steps');
      expect(result.phase).toBe('loaded');
    });

    test('skips on /n', () => {
      negotiator.negotiate(confirmSkill, 'user-1');
      const result = negotiator.confirm('deploy', '/n', 'user-1');
      expect(result.phase).toBe('skipped');
      const state = negotiator.getUsageState('deploy', 'user-1');
      expect(state!.skip).toBe(true);
    });

    test('returns modified text on /edit', () => {
      negotiator.negotiate(confirmSkill, 'user-1');
      const result = negotiator.confirm('deploy', '/edit 加上回滚步骤', 'user-1');
      expect(result.phase).toBe('editing');
      expect(result.feedback).toBe('加上回滚步骤');
    });

    test('returns feedback on free text', () => {
      negotiator.negotiate(confirmSkill, 'user-1');
      const result = negotiator.confirm('deploy', '只部署 staging', 'user-1');
      expect(result.phase).toBe('feedback');
      expect(result.feedback).toBe('只部署 staging');
    });

    test('returns error when no pending confirmation', () => {
      const result = negotiator.confirm('deploy', '/y', 'user-1');
      expect(result.phase).toBe('error');
    });
  });

  // === 拦截机制 ===

  describe('block()', () => {
    test('blocks a skill and records it', () => {
      negotiator.block('code-review', 'user-1');
      const state = negotiator.getUsageState('code-review', 'user-1');
      expect(state!.blocked).toBe(true);
    });

    test('blocked skill returns blocked result on negotiate', () => {
      negotiator.block('code-review', 'user-1');
      const result = negotiator.negotiate(testSkill, 'user-1');
      expect(result.phase).toBe('blocked');
      expect(result.text).toContain('blocked');
    });
  });

  // === 跳过不可重试 ===

  describe('skip immutability', () => {
    test('skipped skill cannot be re-negotiated in same session', () => {
      negotiator.negotiate(confirmSkill, 'user-1');
      negotiator.confirm('deploy', '/n', 'user-1');
      const result = negotiator.negotiate(confirmSkill, 'user-1');
      expect(result.phase).toBe('skipped');
    });

    test('user can explicitly un-skip with /skill retry', () => {
      negotiator.negotiate(confirmSkill, 'user-1');
      negotiator.confirm('deploy', '/n', 'user-1');
      negotiator.unskip('deploy', 'user-1');
      const result = negotiator.negotiate(confirmSkill, 'user-1');
      expect(result.phase).toBe('confirm');
    });
  });

  // === confidence >= 0.7 ===

  describe('confidence threshold', () => {
    test('shouldSuggest returns true when confidence >= 0.7', () => {
      expect(negotiator.shouldSuggest(0.7)).toBe(true);
      expect(negotiator.shouldSuggest(0.9)).toBe(true);
      expect(negotiator.shouldSuggest(1.0)).toBe(true);
    });

    test('shouldSuggest returns false when confidence < 0.7', () => {
      expect(negotiator.shouldSuggest(0.6)).toBe(false);
      expect(negotiator.shouldSuggest(0.0)).toBe(false);
    });
  });

  // === 多用户隔离 ===

  describe('per-user isolation', () => {
    test('different users have independent usage states', () => {
      negotiator.negotiate(confirmSkill, 'user-1');
      negotiator.confirm('deploy', '/n', 'user-1');

      // user-2 不受影响
      const result = negotiator.negotiate(confirmSkill, 'user-2');
      expect(result.phase).toBe('confirm');
    });
  });
});
