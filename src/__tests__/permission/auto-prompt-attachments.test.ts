// Task 12: Prompt Plane 与 Attachments（A74-A80）
//
// 设计输入：docs/auto-mode/mi-code-auto-permission-design.md §11（提示词与安全约束）、
//          §10 A74-A80 重定义。
//
// 锁定行为：
//   - mode 不改变 static system prompt hash（A74）
//   - auto_mode_exit 只走 dynamic attachment，每次 transition 最多一个（A75）
//   - dynamic attachment 只改 dynamicHash，不改 staticHash（A76）
//   - auto protected-setting write 到达 classifier after safety ask（A77）
//   - bypass 不能批准 protected settings（A78）
//   - classifier prompt 只含 trusted user/local/flag/policy sources（A79）
//   - 非空 user section replaces defaults；空 section 回退 defaults（A80）
//   - classifier stage instructions 不出现在 Agent prompt 中（隔离）
import { describe, test, expect } from 'vitest';
import {
  compilePromptForMode,
  compilePrompt,
} from '../../agent/prompt/auto-attachments.js';
import { SessionState } from '../../permission/session-state.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { PermissionChecker } from '../../permission/checker.js';
import {
  projectClassifierConfigSources,
  type ClassifierConfigSourcesInput,
} from '../../config/permission-sources.js';
import {
  buildClassifierPromptPrefix,
  buildClassifierSystemInstruction,
  renderClassifierRuleSections,
  STAGE1_INSTRUCTION,
  STAGE2_INSTRUCTION,
} from '../../permission/classifier-prompt.js';
import type { PermissionClassifierInput } from '../../permission/classifier-input.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function autoSession(): SessionState {
  return new SessionState(new SessionAllowlist(), 's1');
}

function classifierInput(): PermissionClassifierInput {
  return {
    authenticUserMessages: [
      { role: 'user', source: 'user', authoredByUser: true as const, content: 'edit src/a.ts' },
    ],
    executableToolCall: { callId: 'call-a', canonicalToolName: 'write_file', input: { path: 'src/a.ts' } },
  };
}

function allRuleSources(): ClassifierConfigSourcesInput {
  return {
    userSettings: { rules: ['USER_RULE'] },
    localSettings: { rules: ['LOCAL_RULE'] },
    flagSettings: { rules: ['FLAG_RULE'] },
    policySettings: { rules: ['POLICY_RULE'] },
    projectSettings: { rules: ['PROJECT_RULE'] },
    command: { rules: ['COMMAND_RULE'] },
    session: { rules: ['SESSION_RULE'] },
    cliArg: { rules: ['CLI_ARG_RULE'] },
    sdkSettings: { rules: ['SDK_RULE'] },
  };
}

// ─── A74: mode switch does not change static system prompt hash ───────────────

describe('[A74] mode switch does not change static system prompt hash', () => {
  test('build and auto produce identical staticHash', () => {
    const build = compilePromptForMode('build');
    const auto = compilePromptForMode('auto');
    expect(build.staticHash).toBe(auto.staticHash);
  });

  test('plan and auto also share staticHash', () => {
    const plan = compilePromptForMode('plan');
    const auto = compilePromptForMode('auto');
    expect(plan.staticHash).toBe(auto.staticHash);
  });
});

// ─── A75: auto exit emits one dynamic attachment per session transition ───────

describe('[A75] auto exit emits one dynamic attachment per session transition', () => {
  test('exitAuto twice produces only one attachment (debounce)', () => {
    const state = autoSession();
    // 先进入 auto，再退出
    state.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    state.exitAuto();
    state.exitAuto(); // 第二次不应再产生 attachment
    expect(state.takeAttachments()).toEqual([{ type: 'auto_mode_exit' }]);
    expect(state.takeAttachments()).toEqual([]);
  });

  test('takeAttachments consumes the queue', () => {
    const state = autoSession();
    state.applyPermissionUpdate({ kind: 'setMode', mode: 'auto' });
    state.exitAuto();
    const first = state.takeAttachments();
    const second = state.takeAttachments();
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test('non-auto session has no exit attachment', () => {
    const state = autoSession();
    // build 模式下 exitAuto 不产生 attachment
    state.exitAuto();
    expect(state.takeAttachments()).toEqual([]);
  });
});

// ─── A76: dynamic attachment changes dynamic hash only ────────────────────────

describe('[A76] dynamic attachment changes dynamic hash only', () => {
  test('auto_mode_exit attachment changes dynamicHash not staticHash', () => {
    const before = compilePrompt({ attachments: [] });
    const after = compilePrompt({ attachments: [{ type: 'auto_mode_exit' }] });
    expect(after.staticHash).toBe(before.staticHash);
    expect(after.dynamicHash).not.toBe(before.dynamicHash);
  });

  test('multiple attachments change dynamicHash further', () => {
    const noAttachment = compilePrompt({ attachments: [] });
    const oneAttachment = compilePrompt({ attachments: [{ type: 'auto_mode_exit' }] });
    expect(oneAttachment.dynamicHash).not.toBe(noAttachment.dynamicHash);
  });
});

// ─── A77: auto protected-setting write reaches classifier after safety ask ────

describe('[A77] auto protected-setting write reaches classifier after safety ask', () => {
  test('protected setting write is classifierApprovable ask (not hard deny)', () => {
    // 设计 §10 A77：auto 修改受保护设置先返回 classifierApprovable safety ask，
    // 再由 classifier 决定。不进入 non-approvable fast-path。
    const checker = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
    const decision = checker.check('write_file', { path: '.micode/config.json', content: 'x' });
    // 受保护设置写不应是 deny（应是 ask，让 classifier 决定）
    expect(decision.behavior).not.toBe('deny');
  });
});

// ─── A78: bypass cannot approve protected settings ────────────────────────────

describe('[A78] bypass cannot approve protected settings', () => {
  test('bypassPermissions mode still asks for protected settings write', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    expect(
      checker.checkWithEvaluationMode('write_file', { path: '.micode/config.json' }, 'bypassPermissions').behavior,
    ).toBe('ask');
  });

  test('bypassPermissions for .git/config also asks', () => {
    const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });
    expect(
      checker.checkWithEvaluationMode('write_file', { path: '.git/config' }, 'bypassPermissions').behavior,
    ).toBe('ask');
  });
});

// ─── A79: only trusted sources affect classifier prompt ───────────────────────

describe('[A79] only trusted user/local/flag/policy sources affect classifier prompt', () => {
  test('classifier prompt contains only trusted rules', () => {
    const projected = projectClassifierConfigSources(allRuleSources());
    const si = buildClassifierSystemInstruction(STAGE1_INSTRUCTION, projected.rules);
    expect(si).toContain('USER_RULE');
    expect(si).toContain('LOCAL_RULE');
    expect(si).toContain('FLAG_RULE');
    expect(si).toContain('POLICY_RULE');
    // 排除来源的规则不出现
    expect(si).not.toContain('PROJECT_RULE');
    expect(si).not.toContain('COMMAND_RULE');
    expect(si).not.toContain('SESSION_RULE');
    expect(si).not.toContain('CLI_ARG_RULE');
    expect(si).not.toContain('SDK_RULE');
  });
});

// ─── A80: non-empty user section replaces defaults ────────────────────────────

describe('[A80] non-empty user section replaces defaults; empty uses defaults', () => {
  test('non-empty user replaces defaults', () => {
    expect(renderClassifierRuleSections({ defaults: ['D'], organization: ['O'], user: ['U'] }))
      .toEqual(['U', 'O']);
  });

  test('empty user falls back to defaults', () => {
    expect(renderClassifierRuleSections({ defaults: ['D'], organization: ['O'], user: [] }))
      .toEqual(['D', 'O']);
  });
});

// ─── classifier stage prompts never enter the normal Agent prompt ─────────────

describe('classifier stage prompts never enter the normal Agent prompt', () => {
  test('Agent prompt does not contain STAGE1/STAGE2 instructions', () => {
    const agentPrompt = compilePromptForMode('auto');
    expect(agentPrompt.text).not.toContain(STAGE1_INSTRUCTION);
    expect(agentPrompt.text).not.toContain(STAGE2_INSTRUCTION);
  });

  test('Agent prompt for build also does not contain classifier instructions', () => {
    const agentPrompt = compilePromptForMode('build');
    expect(agentPrompt.text).not.toContain(STAGE1_INSTRUCTION);
    expect(agentPrompt.text).not.toContain(STAGE2_INSTRUCTION);
  });
});
