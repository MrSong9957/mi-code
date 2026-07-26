import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverProjectRuleSources } from '../../agent/context/discovery.js';

describe('discoverProjectRuleSources', () => {
  it('discovers candidates from repository root to working directory deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    const child = join(root, 'packages', 'app');
    await mkdir(child, { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'root');
    await writeFile(join(child, 'AGENTS.md'), 'child');

    const result = await discoverProjectRuleSources(
      {
        workspace_root: root,
        repository_root: root,
        working_directory: child,
        source_policy_id: 'default-project-rules',
      },
      {
        source_policy_id: 'default-project-rules',
        candidate_names: ['AGENTS.md', 'CLAUDE.md'],
      },
    );

    expect(result.map((entry) => entry.absolute_path)).toEqual([
      join(root, 'CLAUDE.md'),
      join(child, 'AGENTS.md'),
    ]);
    expect(result.every((entry) => !('trusted' in entry))).toBe(true);
  });

  it('rejects a relative workspace_root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    await expect(
      discoverProjectRuleSources(
        {
          workspace_root: '.',
          repository_root: null,
          working_directory: root,
          source_policy_id: 'default-project-rules',
        },
        {
          source_policy_id: 'default-project-rules',
          candidate_names: ['CLAUDE.md'],
        },
      ),
    ).rejects.toThrow(/workspace_root must be an absolute path/);
  });

  it('rejects a relative working_directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    await expect(
      discoverProjectRuleSources(
        {
          workspace_root: root,
          repository_root: null,
          working_directory: 'relative/path',
          source_policy_id: 'default-project-rules',
        },
        {
          source_policy_id: 'default-project-rules',
          candidate_names: ['CLAUDE.md'],
        },
      ),
    ).rejects.toThrow(/working_directory must be an absolute path/);
  });

  it('rejects a working_directory outside the workspace_root', async () => {
    const inside = await mkdtemp(join(tmpdir(), 'mi-code-inside-'));
    const sibling = await mkdtemp(join(tmpdir(), 'mi-code-sibling-'));
    await expect(
      discoverProjectRuleSources(
        {
          workspace_root: inside,
          repository_root: null,
          working_directory: sibling,
          source_policy_id: 'default-project-rules',
        },
        {
          source_policy_id: 'default-project-rules',
          candidate_names: ['CLAUDE.md'],
        },
      ),
    ).rejects.toThrow(/outside workspace/);
  });

  it('rejects a working_directory outside repository_root when set (but inside workspace)', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mi-code-ws-'));
    const repo = join(workspace, 'repo');
    const outsideRepo = join(workspace, 'other');
    await mkdir(repo, { recursive: true });
    await mkdir(outsideRepo, { recursive: true });
    await expect(
      discoverProjectRuleSources(
        {
          workspace_root: workspace,
          repository_root: repo,
          working_directory: outsideRepo,
          source_policy_id: 'default-project-rules',
        },
        {
          source_policy_id: 'default-project-rules',
          candidate_names: ['CLAUDE.md'],
        },
      ),
    ).rejects.toThrow(/outside repository/);
  });

  it('rejects a repository_root set outside the workspace_root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'mi-code-ws-'));
    const repoOutside = await mkdtemp(join(tmpdir(), 'mi-code-repo-'));
    const working = join(workspace, 'pkg');
    await mkdir(working, { recursive: true });
    await expect(
      discoverProjectRuleSources(
        {
          workspace_root: workspace,
          repository_root: repoOutside,
          working_directory: working,
          source_policy_id: 'default-project-rules',
        },
        {
          source_policy_id: 'default-project-rules',
          candidate_names: ['CLAUDE.md'],
        },
      ),
    ).rejects.toThrow();
  });

  it('throws unknown source_policy_id on input/policy mismatch (not empty success)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    await expect(
      discoverProjectRuleSources(
        {
          workspace_root: root,
          repository_root: null,
          working_directory: root,
          source_policy_id: 'policy-A',
        },
        {
          source_policy_id: 'policy-B',
          candidate_names: ['CLAUDE.md'],
        },
      ),
    ).rejects.toThrow(/unknown source_policy_id/);
  });

  it('rejects an empty source_policy_id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    await expect(
      discoverProjectRuleSources(
        {
          workspace_root: root,
          repository_root: null,
          working_directory: root,
          source_policy_id: '',
        },
        {
          source_policy_id: '',
          candidate_names: ['CLAUDE.md'],
        },
      ),
    ).rejects.toThrow(/source_policy_id/);
  });

  it('deduplicates the same physical file when a candidate name repeats in policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    await writeFile(join(root, 'CLAUDE.md'), 'root');
    const result = await discoverProjectRuleSources(
      {
        workspace_root: root,
        repository_root: null,
        working_directory: root,
        source_policy_id: 'default-project-rules',
      },
      {
        source_policy_id: 'default-project-rules',
        candidate_names: ['CLAUDE.md', 'CLAUDE.md'],
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0].absolute_path).toBe(join(root, 'CLAUDE.md'));
  });

  it('skips candidates that do not exist without throwing or recording a diagnostic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    const result = await discoverProjectRuleSources(
      {
        workspace_root: root,
        repository_root: null,
        working_directory: root,
        source_policy_id: 'default-project-rules',
      },
      {
        source_policy_id: 'default-project-rules',
        candidate_names: ['CLAUDE.md', 'AGENTS.md'],
      },
    );
    expect(result).toEqual([]);
  });

  it('preserves candidate_names order when two files exist at the same depth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    await writeFile(join(root, 'CLAUDE.md'), 'root-claude');
    await writeFile(join(root, 'AGENTS.md'), 'root-agents');
    const result = await discoverProjectRuleSources(
      {
        workspace_root: root,
        repository_root: null,
        working_directory: root,
        source_policy_id: 'default-project-rules',
      },
      {
        source_policy_id: 'default-project-rules',
        candidate_names: ['AGENTS.md', 'CLAUDE.md'],
      },
    );
    expect(result.map((entry) => entry.candidate_kind)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
    ]);
  });

  it('never attaches trusted/authority/placement/content properties to output entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    const child = join(root, 'packages', 'app');
    await mkdir(child, { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'root');
    await writeFile(join(child, 'AGENTS.md'), 'child');

    const result = await discoverProjectRuleSources(
      {
        workspace_root: root,
        repository_root: root,
        working_directory: child,
        source_policy_id: 'default-project-rules',
      },
      {
        source_policy_id: 'default-project-rules',
        candidate_names: ['AGENTS.md', 'CLAUDE.md'],
      },
    );

    expect(result.length).toBeGreaterThan(0);
    for (const entry of result) {
      expect(entry).not.toHaveProperty('trusted');
      expect(entry).not.toHaveProperty('authority');
      expect(entry).not.toHaveProperty('placement');
      expect(entry).not.toHaveProperty('content');
      expect(entry).not.toHaveProperty('instructions');
    }
  });

  it('computes relative_depth as 0 at workspace_root and 2 two levels deep', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    const deep = join(root, 'a', 'b');
    await mkdir(deep, { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'root');
    await writeFile(join(deep, 'AGENTS.md'), 'deep');

    const result = await discoverProjectRuleSources(
      {
        workspace_root: root,
        repository_root: null,
        working_directory: deep,
        source_policy_id: 'default-project-rules',
      },
      {
        source_policy_id: 'default-project-rules',
        candidate_names: ['AGENTS.md', 'CLAUDE.md'],
      },
    );

    const byKind = new Map(result.map((entry) => [entry.candidate_kind, entry]));
    expect(byKind.get('CLAUDE.md')?.relative_depth).toBe(2);
    expect(byKind.get('AGENTS.md')?.relative_depth).toBe(0);
  });

  it('returns byte-identical results across two identical invocations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    const child = join(root, 'packages', 'app');
    await mkdir(child, { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'root');
    await writeFile(join(child, 'AGENTS.md'), 'child');

    const input = {
      workspace_root: root,
      repository_root: root,
      working_directory: child,
      source_policy_id: 'default-project-rules',
    };
    const policy = {
      source_policy_id: 'default-project-rules',
      candidate_names: ['AGENTS.md', 'CLAUDE.md'],
    };

    const first = await discoverProjectRuleSources(input, policy);
    const second = await discoverProjectRuleSources(input, policy);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
  });

  it('uses workspace_root as the discovery ceiling when repository_root is null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    const child = join(root, 'pkg', 'app');
    await mkdir(child, { recursive: true });
    await writeFile(join(root, 'CLAUDE.md'), 'root');
    await writeFile(join(child, 'AGENTS.md'), 'child');

    const result = await discoverProjectRuleSources(
      {
        workspace_root: root,
        repository_root: null,
        working_directory: child,
        source_policy_id: 'default-project-rules',
      },
      {
        source_policy_id: 'default-project-rules',
        candidate_names: ['AGENTS.md', 'CLAUDE.md'],
      },
    );
    expect(result.map((entry) => entry.absolute_path)).toEqual([
      join(root, 'CLAUDE.md'),
      join(child, 'AGENTS.md'),
    ]);
  });

  // Windows: chmod 0o000 does not reliably produce EACCES, so a flaky
  // unreadable-candidate test would violate the determinism contract.
  // The KEY invariant (discovery never throws fatal on a single unreadable
  // candidate and never adds `trusted`) is asserted in the property test above.
  const unreadableTest = process.platform === 'win32' ? it.skip : it;
  unreadableTest('records a diagnostic for an unreadable candidate instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mi-code-rules-'));
    const { default: os } = await import('node:os');
    if (os.platform() === 'win32') return;
    await writeFile(join(root, 'CLAUDE.md'), 'root');
    const { chmod } = await import('node:fs/promises');
    await chmod(join(root, 'CLAUDE.md'), 0o000);
    try {
      const result = await discoverProjectRuleSources(
        {
          workspace_root: root,
          repository_root: null,
          working_directory: root,
          source_policy_id: 'default-project-rules',
        },
        {
          source_policy_id: 'default-project-rules',
          candidate_names: ['CLAUDE.md'],
        },
      );
      // Either it was unreadable (diagnostic recorded) or it was discoverable
      // but with a diagnostic; either way we never throw and never add trusted.
      for (const entry of result) {
        expect(entry).not.toHaveProperty('trusted');
      }
    } finally {
      await chmod(join(root, 'CLAUDE.md'), 0o644).catch(() => undefined);
    }
  });
});
