// src/__tests__/agent/tool-transcript-validator.test.ts
// Task 10 (M-070 / BRC-5): Tool Transcript Validator.
//
// 物理本质: tool use/result 配对的因果完整性校验。扫描 transcript snapshot 的
// messages,把每个 ToolUseBlock 与其 ToolResultBlock 配对,分类出 6 种 pair state,
// 映射到 accepted/blocked/rejected。validator 不合成 result、不判业务对错、
// 不读 summary 文本、不决定 Outcome —— 它只验证配对完整性。
//
// 重点断言:
//   - 6 种 pair state 的分类规则(spec §11.3)
//   - 状态映射: rejected > blocked > accepted 优先级
//   - pending_execution 只能从 executing_facts.executing_tool_call_ids 推出
//   - 只有 ToolResultBlock 算作 result(文本块/进度/日志不算)
//   - validation_id 确定性(同输入同 id;checkpoint/policy_version 参与哈希)
//   - 输出三层深冻结
//   - reason_codes 结构化 + accepted 时为空

import { describe, expect, it } from 'vitest';
import {
  validateToolTranscript,
  type ToolPairState,
  type ToolTranscriptSnapshot,
} from '../../agent/tools/transcript-validator.js';
import type { Message } from '../../agent/types.js';

// ---------- helpers ----------

function use(id: string, name = 'read_file'): Message {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] };
}

function result(id: string, content = 'ok'): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function snapshot(
  messages: Message[],
  opts: { transcript_snapshot_id?: string; session_id?: string; turn_id?: string } = {},
): ToolTranscriptSnapshot {
  return {
    transcript_snapshot_id: opts.transcript_snapshot_id ?? 'ts-1',
    session_id: opts.session_id ?? 'sess-1',
    turn_id: opts.turn_id ?? 'turn-1',
    messages,
  };
}

const BASE_OPTS = {
  checkpoint: 'before_provider_send' as const,
  validator_policy_id: 'pairing',
  validator_policy_version: '1',
};

// ---------- classification: parametrized basic cases ----------

it.each<[string, Message[], 'accepted' | 'blocked' | 'rejected']>([
  ['paired', [use('c1'), result('c1')], 'accepted'],
  ['missing_result', [use('c1')], 'rejected'],
  ['orphan_result', [result('c1')], 'rejected'],
  ['duplicate_result', [use('c1'), result('c1'), result('c1')], 'rejected'],
])('classifies %s deterministically (status=%s)', (_name, messages, status) => {
  const validation = validateToolTranscript(snapshot(messages), { ...BASE_OPTS });
  expect(validation.status).toBe(status);
});

// ---------- pending_execution ----------

it('classifies a use with no result as pending_execution (blocked) when executing_facts lists it', () => {
  const validation = validateToolTranscript(snapshot([use('c1')]), {
    ...BASE_OPTS,
    executing_facts: { executing_tool_call_ids: new Set(['c1']) },
  });
  expect(validation.status).toBe('blocked');
  const c1 = validation.pair_records.find((p) => p.tool_call_id === 'c1');
  expect(c1?.state).toBe('pending_execution');
  expect(validation.reason_codes).toContain('pair.pending_execution:c1');
});

it('classifies a use with no result as missing_result (rejected) WITHOUT executing_facts', () => {
  const validation = validateToolTranscript(snapshot([use('c1')]), { ...BASE_OPTS });
  expect(validation.status).toBe('rejected');
  const c1 = validation.pair_records.find((p) => p.tool_call_id === 'c1');
  expect(c1?.state).toBe('missing_result');
  expect(validation.reason_codes).toContain('pair.missing_result:c1');
});

it('pending_execution classification depends ONLY on executing_facts, not on guesswork', () => {
  // Same transcript, with vs without facts -> different state for the same tool_call_id.
  const noFacts = validateToolTranscript(snapshot([use('c1')]), { ...BASE_OPTS });
  const withFacts = validateToolTranscript(snapshot([use('c1')]), {
    ...BASE_OPTS,
    executing_facts: { executing_tool_call_ids: new Set(['c1']) },
  });
  expect(noFacts.pair_records[0].state).toBe('missing_result');
  expect(withFacts.pair_records[0].state).toBe('pending_execution');
});

// ---------- mixed transcripts ----------

it('mixed: one paired + one pending_execution -> status blocked (not accepted, not rejected)', () => {
  const validation = validateToolTranscript(
    snapshot([use('c1'), result('c1'), use('c2')]),
    {
      ...BASE_OPTS,
      executing_facts: { executing_tool_call_ids: new Set(['c2']) },
    },
  );
  expect(validation.status).toBe('blocked');
  const states = validation.pair_records.map((p) => p.state).sort();
  expect(states).toEqual(['paired', 'pending_execution']);
});

it('mixed: one paired + one missing_result (no facts) -> status rejected', () => {
  const validation = validateToolTranscript(snapshot([use('c1'), result('c1'), use('c2')]), {
    ...BASE_OPTS,
  });
  expect(validation.status).toBe('rejected');
  const states = validation.pair_records.map((p) => p.state).sort();
  expect(states).toEqual(['missing_result', 'paired']);
});

it('mixed: one pending_execution + one orphan_result -> status rejected (precedence rejected > blocked)', () => {
  const validation = validateToolTranscript(
    snapshot([use('c1'), result('c_orphan')]),
    {
      ...BASE_OPTS,
      executing_facts: { executing_tool_call_ids: new Set(['c1']) },
    },
  );
  expect(validation.status).toBe('rejected');
  const states = validation.pair_records.map((p) => p.state).sort();
  expect(states).toContain('pending_execution');
  expect(states).toContain('orphan_result');
});

// ---------- identity_conflict ----------

it('classifies two uses with the same id as identity_conflict (rejected)', () => {
  const validation = validateToolTranscript(snapshot([use('c1'), use('c1')]), { ...BASE_OPTS });
  expect(validation.status).toBe('rejected');
  expect(validation.pair_records.some((p) => p.state === 'identity_conflict')).toBe(true);
  expect(validation.reason_codes.some((r) => r.startsWith('pair.identity_conflict:c1'))).toBe(true);
});

// ---------- only ToolResultBlock counts as a result ----------

it('does NOT treat a user text block as a tool result (state stays missing_result)', () => {
  const validation = validateToolTranscript(snapshot([use('c1'), userText('not a result')]), {
    ...BASE_OPTS,
  });
  expect(validation.status).toBe('rejected');
  const c1 = validation.pair_records.find((p) => p.tool_call_id === 'c1');
  expect(c1?.state).toBe('missing_result');
});

it('does NOT treat assistant text / summaries as tool results', () => {
  const validation = validateToolTranscript(
    snapshot([use('c1'), assistantText('I already ran c1 successfully.')]),
    { ...BASE_OPTS },
  );
  expect(validation.status).toBe('rejected');
  const c1 = validation.pair_records.find((p) => p.tool_call_id === 'c1');
  expect(c1?.state).toBe('missing_result');
});

// ---------- reason_codes ----------

it('emits empty reason_codes when accepted', () => {
  const validation = validateToolTranscript(snapshot([use('c1'), result('c1')]), { ...BASE_OPTS });
  expect(validation.status).toBe('accepted');
  expect(validation.reason_codes).toEqual([]);
});

it('emits structured reason_codes like "pair.missing_result:<tool_call_id>" when rejected', () => {
  const validation = validateToolTranscript(snapshot([use('alpha'), use('beta')]), { ...BASE_OPTS });
  expect(validation.reason_codes).toEqual(
    expect.arrayContaining(['pair.missing_result:alpha', 'pair.missing_result:beta']),
  );
});

it('emits structured reason_codes for orphan/duplicate/identity_conflict', () => {
  const orphan = validateToolTranscript(snapshot([result('ghost')]), { ...BASE_OPTS });
  expect(orphan.reason_codes).toContain('pair.orphan_result:ghost');

  const dup = validateToolTranscript(snapshot([use('d'), result('d'), result('d')]), {
    ...BASE_OPTS,
  });
  expect(dup.reason_codes.some((r) => r.startsWith('pair.duplicate_result:d'))).toBe(true);
});

// ---------- determinism ----------

it('returns identical validation_id, status, pair_records content, reason_codes for same inputs', () => {
  const a = validateToolTranscript(snapshot([use('c1'), result('c1'), use('c2')]), {
    ...BASE_OPTS,
    executing_facts: { executing_tool_call_ids: new Set(['c2']) },
  });
  const b = validateToolTranscript(snapshot([use('c1'), result('c1'), use('c2')]), {
    ...BASE_OPTS,
    executing_facts: { executing_tool_call_ids: new Set(['c2']) },
  });
  expect(a.validation_id).toBe(b.validation_id);
  expect(a.status).toBe(b.status);
  expect(a.reason_codes).toEqual(b.reason_codes);
  // pair_records content identical (compare by tool_call_id + state)
  const norm = (records: typeof a.pair_records) =>
    records.map((p) => [p.tool_call_id, p.state].join('|')).sort();
  expect(norm(a.pair_records)).toEqual(norm(b.pair_records));
});

it('changes validation_id when checkpoint differs (checkpoint participates in hash)', () => {
  const beforeSend = validateToolTranscript(snapshot([use('c1'), result('c1')]), {
    ...BASE_OPTS,
    checkpoint: 'before_provider_send',
  });
  const beforePersist = validateToolTranscript(snapshot([use('c1'), result('c1')]), {
    ...BASE_OPTS,
    checkpoint: 'before_persistence',
  });
  expect(beforeSend.validation_id).not.toBe(beforePersist.validation_id);
  // status is still the same (accepted) — only the id changes
  expect(beforeSend.status).toBe('accepted');
  expect(beforePersist.status).toBe('accepted');
});

it('changes validation_id when validator_policy_version differs', () => {
  const v1 = validateToolTranscript(snapshot([use('c1'), result('c1')]), {
    ...BASE_OPTS,
    validator_policy_version: '1',
  });
  const v2 = validateToolTranscript(snapshot([use('c1'), result('c1')]), {
    ...BASE_OPTS,
    validator_policy_version: '2',
  });
  expect(v1.validation_id).not.toBe(v2.validation_id);
});

it('prefixes validation_id deterministically', () => {
  const v = validateToolTranscript(snapshot([use('c1'), result('c1')]), { ...BASE_OPTS });
  expect(v.validation_id.startsWith('tv:')).toBe(true);
});

// ---------- freezing ----------

it('deep-freezes the output: top-level, pair_records array, each record, reason_codes', () => {
  const validation = validateToolTranscript(snapshot([use('c1'), result('c1')]), { ...BASE_OPTS });
  expect(Object.isFrozen(validation)).toBe(true);
  expect(Object.isFrozen(validation.pair_records)).toBe(true);
  expect(Object.isFrozen(validation.pair_records[0])).toBe(true);
  expect(Object.isFrozen(validation.reason_codes)).toBe(true);
});

it('freezes the output even when rejected', () => {
  const validation = validateToolTranscript(snapshot([use('c1'), use('c1')]), { ...BASE_OPTS });
  expect(Object.isFrozen(validation)).toBe(true);
  expect(Object.isFrozen(validation.pair_records)).toBe(true);
  expect(Object.isFrozen(validation.pair_records[0])).toBe(true);
  expect(Object.isFrozen(validation.reason_codes)).toBe(true);
});

// ---------- edge cases ----------

it('empty transcript (no messages) -> status accepted, empty pair_records', () => {
  const validation = validateToolTranscript(snapshot([]), { ...BASE_OPTS });
  expect(validation.status).toBe('accepted');
  expect(validation.pair_records).toEqual([]);
  expect(validation.reason_codes).toEqual([]);
});

it('multiple paired uses -> all paired, status accepted, pair_records length matches', () => {
  const validation = validateToolTranscript(
    snapshot([use('a'), result('a'), use('b'), result('b'), use('c'), result('c')]),
    { ...BASE_OPTS },
  );
  expect(validation.status).toBe('accepted');
  expect(validation.pair_records).toHaveLength(3);
  for (const r of validation.pair_records) {
    expect(r.state).toBe('paired');
  }
});

it('exposes session_id / turn_id on each pair record, and pairs use/result message refs', () => {
  const validation = validateToolTranscript(
    snapshot([use('c1'), result('c1')], { session_id: 'sess-x', turn_id: 'turn-y' }),
    { ...BASE_OPTS },
  );
  expect(validation.pair_records).toHaveLength(1);
  const r = validation.pair_records[0];
  expect(r.session_id).toBe('sess-x');
  expect(r.turn_id).toBe('turn-y');
  expect(r.tool_call_id).toBe('c1');
  // a paired record references both the use message and the result message
  expect(r.tool_use_message_ref).not.toBe(null);
  expect(r.tool_result_message_ref).not.toBe(null);
});

it('a pending_execution record has tool_result_message_ref = null', () => {
  const validation = validateToolTranscript(snapshot([use('c1')]), {
    ...BASE_OPTS,
    executing_facts: { executing_tool_call_ids: new Set(['c1']) },
  });
  expect(validation.pair_records[0].tool_result_message_ref).toBe(null);
});

it('hardcodes validation_protocol_version to "1"', () => {
  const validation = validateToolTranscript(snapshot([]), { ...BASE_OPTS });
  expect(validation.validation_protocol_version).toBe('1');
});

it('echoes transcript_snapshot_id, checkpoint and policy identity onto the validation', () => {
  const validation = validateToolTranscript(snapshot([], { transcript_snapshot_id: 'ts-42' }), {
    checkpoint: 'before_compaction',
    validator_policy_id: 'pol-xyz',
    validator_policy_version: '9',
  });
  expect(validation.transcript_snapshot_id).toBe('ts-42');
  expect(validation.checkpoint).toBe('before_compaction');
  expect(validation.validator_policy_id).toBe('pol-xyz');
  expect(validation.validator_policy_version).toBe('9');
});

// ---------- one describe block just to group the file ----------

describe('ToolTranscriptValidator', () => {
  it('placeholder so describe has at least one nested test', () => {
    expect(true).toBe(true);
  });
});
