import { describe, it, expect } from 'vitest';
import { mapPermissionAnswerToUserDecision } from '../../permission/permission-answer-mapping.js';
import { SECURITY_PROTOCOL_VERSION } from '../../permission/decisions.js';
import type { AskQuestionOutcome } from '../../agent/ask-user-types.js';

const decisionId = 'dec-1';

function submitted(answer: string | undefined): AskQuestionOutcome {
  // AskQuestionOutcome.answers 是 Record<string,string>;模拟单选问卷选中一个选项
  const answers = answer === undefined ? {} : { q0: answer };
  return { kind: 'submitted', answers };
}

describe('mapPermissionAnswerToUserDecision(精确映射)', () => {
  it('Allow once → approved_once, remember=false', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('Allow once'));
    expect(u.response).toBe('approved_once');
    expect(u.remember).toBe(false);
  });

  it('Allow this exact action for this session → approved_once, remember=true', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('Allow this exact action for this session'));
    expect(u.response).toBe('approved_once');
    expect(u.remember).toBe(true);
  });

  it('Reject → rejected', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('Reject'));
    expect(u.response).toBe('rejected');
  });

  it('unknown answer → rejected(不允许任何未知值变成 approved_once)', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('something else'));
    expect(u.response).toBe('rejected');
  });

  it('empty answers(选中但无值)→ rejected', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted(undefined));
    expect(u.response).toBe('rejected');
  });

  it('outcome 非 submitted(cancelled)→ rejected', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, { kind: 'cancelled' });
    expect(u.response).toBe('rejected');
  });

  it('outcome 非 submitted(chat)→ rejected', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, { kind: 'chat', feedback: 'discuss' });
    expect(u.response).toBe('rejected');
  });

  it('所有结果携带 decision_id + protocol_version + decided_at', () => {
    const u = mapPermissionAnswerToUserDecision(decisionId, submitted('Allow once'));
    expect(u.decision_id).toBe(decisionId);
    expect(u.protocol_version).toBe(SECURITY_PROTOCOL_VERSION);
    expect(typeof u.decided_at).toBe('string');
  });
});
