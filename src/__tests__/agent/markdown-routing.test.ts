import { describe, expect, it } from 'vitest';
import {
  routeMarkdownSource,
  type MarkdownRouteTarget,
  type MarkdownRouteTrustEvidence,
  type MarkdownSourceRouteInput,
} from '../../agent/context/routing.js';

// ---------------------------------------------------------------------------
// M-012 Markdown Trusted Routing (CRC-3 §9.4 / §9.5 / §9.8).
//
// The router decides the TARGET of a markdown source; it NEVER elevates
// Authority. The four-gate AND is the only path to a non-reject target:
//   trusted_source_policy AND schema_valid AND deterministic_loader
//   AND sanitization_accepted
//
// Files, filenames, paths, frontmatter, schema structure, and self-reported
// content NEVER establish trust (INV-C6). The router also does not return an
// `approved` field — asset routes merely enter RC-1 candidate governance.
// ---------------------------------------------------------------------------

const ALL_PASS: MarkdownRouteTrustEvidence = {
  trusted_source_policy: true,
  schema_valid: true,
  deterministic_loader: true,
  sanitization_accepted: true,
};

function instructionInput(
  overrides: Partial<MarkdownSourceRouteInput> = {},
): MarkdownSourceRouteInput {
  return {
    context_source_id: 'src-1',
    source_policy_id: 'policy-1',
    schema_id: 'schema-1',
    loader_id: 'loader-1',
    loader_version: '1.0.0',
    sanitization_result_ref: 'san-1',
    bounded_source_ref: 'bounded-1',
    source_class: 'instruction_candidate',
    // Authority is sourced from the source policy/envelope, NOT minted here.
    authority: 'user',
    retention: 'session',
    ...overrides,
  };
}

describe('routeMarkdownSource — four-gate trust AND (CRC-3 §9.2 / §9.8)', () => {
  it.each([
    { gate: 'trusted_source_policy', flipped: { ...ALL_PASS, trusted_source_policy: false } },
    { gate: 'schema_valid', flipped: { ...ALL_PASS, schema_valid: false } },
    { gate: 'deterministic_loader', flipped: { ...ALL_PASS, deterministic_loader: false } },
    { gate: 'sanitization_accepted', flipped: { ...ALL_PASS, sanitization_accepted: false } },
  ])('rejects when $gate is false', ({ flipped }) => {
    const decision = routeMarkdownSource(instructionInput(), flipped);
    expect(decision.target).toBe<MarkdownRouteTarget>('reject');
    // reason_code must name WHICH gate failed.
    expect(decision.reason_code).toMatch(/^route\.gate_/);
    expect(decision.trust_proof_refs).not.toContain(undefined as unknown as string);
  });

  it('rejects when ALL four gates are false (still reject, with every gate in reason_code)', () => {
    const nonePass: MarkdownRouteTrustEvidence = {
      trusted_source_policy: false,
      schema_valid: false,
      deterministic_loader: false,
      sanitization_accepted: false,
    };
    const decision = routeMarkdownSource(instructionInput(), nonePass);
    expect(decision.target).toBe<MarkdownRouteTarget>('reject');
    expect(decision.reason_code).toContain('trusted_source_policy');
    expect(decision.reason_code).toContain('schema_valid');
    expect(decision.reason_code).toContain('deterministic_loader');
    expect(decision.reason_code).toContain('sanitization_accepted');
  });

  it('passes a non-reject target only when all four gates are true', () => {
    const decision = routeMarkdownSource(instructionInput(), ALL_PASS);
    expect(decision.target).not.toBe<MarkdownRouteTarget>('reject');
  });
});

describe('routeMarkdownSource — trust_proof_refs (CRC-3 §9.5)', () => {
  it('emits a ref for each PASSING gate, referencing the source policy/schema/loader/sanitization ids', () => {
    const decision = routeMarkdownSource(
      instructionInput({
        source_policy_id: 'p7',
        schema_id: 's7',
        loader_id: 'l7',
        sanitization_result_ref: 'san7',
      }),
      ALL_PASS,
    );

    expect(decision.trust_proof_refs).toEqual(
      expect.arrayContaining([
        'source_policy:p7',
        'schema:s7',
        'loader:l7',
        'sanitization:san7',
      ]),
    );
    expect(decision.trust_proof_refs).toHaveLength(4);
  });

  it('emits NO proof ref for a failing gate', () => {
    const decision = routeMarkdownSource(instructionInput(), {
      ...ALL_PASS,
      schema_valid: false,
    });
    expect(decision.trust_proof_refs).not.toContain(
      expect.stringContaining('schema:'),
    );
    // The three passing gates still get refs.
    expect(decision.trust_proof_refs).toHaveLength(3);
  });
});

describe('routeMarkdownSource — target / source-class matrix (CRC-3 §9.4)', () => {
  it('instruction_candidate (all pass, no asset_kind) → project_instruction_context', () => {
    const decision = routeMarkdownSource(instructionInput(), ALL_PASS);
    expect(decision.target).toBe<MarkdownRouteTarget>('project_instruction_context');
  });

  it('instruction_candidate with asset_kind=agent_role → agent_role_asset', () => {
    const decision = routeMarkdownSource(
      instructionInput({ asset_kind: 'agent_role' }),
      ALL_PASS,
    );
    expect(decision.target).toBe<MarkdownRouteTarget>('agent_role_asset');
  });

  it('instruction_candidate with asset_kind=task_template → task_template_asset', () => {
    const decision = routeMarkdownSource(
      instructionInput({ asset_kind: 'task_template' }),
      ALL_PASS,
    );
    expect(decision.target).toBe<MarkdownRouteTarget>('task_template_asset');
  });

  it('instruction_candidate with asset_kind=tool_prompt → tool_prompt_asset', () => {
    const decision = routeMarkdownSource(
      instructionInput({ asset_kind: 'tool_prompt' }),
      ALL_PASS,
    );
    expect(decision.target).toBe<MarkdownRouteTarget>('tool_prompt_asset');
  });

  it('instruction_candidate with an UNKNOWN asset_kind → still routes to project_instruction_context (default), never to an asset target', () => {
    const decision = routeMarkdownSource(
      instructionInput({ asset_kind: 'nonsense' as never }),
      ALL_PASS,
    );
    expect(decision.target).toBe<MarkdownRouteTarget>('project_instruction_context');
  });

  it('auto_memory (all pass) → auto_memory_context', () => {
    const decision = routeMarkdownSource(
      instructionInput({ source_class: 'auto_memory' }),
      ALL_PASS,
    );
    expect(decision.target).toBe<MarkdownRouteTarget>('auto_memory_context');
  });

  it.each([
    { source_class: 'environment', expected_code: 'route.environment_not_markdown_routable' },
    { source_class: 'tool_result', expected_code: 'route.tool_result_not_markdown_routable' },
  ])(
    'rejects $source_class even when all four gates pass (reason_code=$expected_code)',
    ({ source_class, expected_code }) => {
      const decision = routeMarkdownSource(
        instructionInput({ source_class: source_class as MarkdownSourceRouteInput['source_class'] }),
        ALL_PASS,
      );
      expect(decision.target).toBe<MarkdownRouteTarget>('reject');
      expect(decision.reason_code).toBe(expected_code);
    },
  );

  it('rejects attachment and external_content sources even when all four gates pass', () => {
    const att = routeMarkdownSource(
      instructionInput({ source_class: 'attachment' }),
      ALL_PASS,
    );
    expect(att.target).toBe<MarkdownRouteTarget>('reject');

    const ext = routeMarkdownSource(
      instructionInput({ source_class: 'external_content' }),
      ALL_PASS,
    );
    expect(ext.target).toBe<MarkdownRouteTarget>('reject');
    expect(ext.reason_code).toMatch(/^route\./);
  });

  it('for a failing gate, gate-check reason takes precedence over source-class compatibility', () => {
    // environment source with a failing gate ⇒ reject with a GATE reason, not
    // the environment-not-markdown-routable reason. Gate failure is the first
    // hard stop.
    const decision = routeMarkdownSource(
      instructionInput({ source_class: 'environment' }),
      { ...ALL_PASS, schema_valid: false },
    );
    expect(decision.target).toBe<MarkdownRouteTarget>('reject');
    expect(decision.reason_code).toMatch(/^route\.gate_/);
  });
});

describe('routeMarkdownSource — invariants (CRC-3 §9.5 / INV-C6)', () => {
  it('authority is sourced from the input, never "system"', () => {
    const decision = routeMarkdownSource(
      instructionInput({ authority: 'user' }),
      ALL_PASS,
    );
    expect(decision.authority).toBe('user');
    expect(decision.authority).not.toBe('system');
  });

  it('policy_ref references the source policy id/version', () => {
    const decision = routeMarkdownSource(
      instructionInput({ source_policy_id: 'p9', policy_version: '3.1.0' }),
      ALL_PASS,
    );
    expect(decision.policy_ref).toEqual({ policy_id: 'p9', policy_version: '3.1.0' });
  });

  it('retention is sourced from the input, never overwritten', () => {
    const decision = routeMarkdownSource(
      instructionInput({ retention: 'persistent' }),
      ALL_PASS,
    );
    expect(decision.retention).toBe('persistent');
  });

  it('context_source_id is echoed from the input', () => {
    const decision = routeMarkdownSource(
      instructionInput({ context_source_id: 'echo-42' }),
      ALL_PASS,
    );
    expect(decision.context_source_id).toBe('echo-42');
  });

  it('route_decision_id has the `route:` prefix and 16-char sha256 truncation', () => {
    const decision = routeMarkdownSource(instructionInput(), ALL_PASS);
    expect(decision.route_decision_id).toMatch(/^route:[0-9a-f]{16}$/);
  });

  it('route_decision_id is deterministic for identical inputs and evidence', () => {
    const a = routeMarkdownSource(instructionInput(), ALL_PASS);
    const b = routeMarkdownSource(instructionInput(), ALL_PASS);
    expect(a.route_decision_id).toBe(b.route_decision_id);
  });

  it('route_decision_id changes when evidence changes (reject vs accept produces different ids)', () => {
    const accepted = routeMarkdownSource(instructionInput(), ALL_PASS);
    const rejected = routeMarkdownSource(instructionInput(), {
      ...ALL_PASS,
      schema_valid: false,
    });
    expect(accepted.route_decision_id).not.toBe(rejected.route_decision_id);
  });

  it('does NOT return an `approved` field — routing only decides target, never approves (CRC-3 §9.5 rule 5)', () => {
    const decision = routeMarkdownSource(
      instructionInput({ asset_kind: 'agent_role' }),
      ALL_PASS,
    );
    expect((decision as Record<string, unknown>).approved).toBeUndefined();
    expect(decision.target).toBe<MarkdownRouteTarget>('agent_role_asset');
  });

  it('the decision object is frozen', () => {
    const decision = routeMarkdownSource(instructionInput(), ALL_PASS);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.trust_proof_refs)).toBe(true);
  });

  it('the protocol version field is present and non-empty', () => {
    const decision = routeMarkdownSource(instructionInput(), ALL_PASS);
    expect(typeof decision.route_protocol_version).toBe('string');
    expect(decision.route_protocol_version.length).toBeGreaterThan(0);
  });
});
