import { describe, test, expect, beforeEach } from 'vitest';
import { executeCommand } from '../executor.js';
import type { Command } from '../parser.js';
import { SkillRegistry } from '../../skills/registry.js';
import { SkillNegotiator } from '../../skills/negotiator.js';

// 测试用技能
function setupRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register('code-review', 'Checklist for reviewing code', '## Review checklist');
  registry.register('deploy', 'Deploy to production', '## Deploy steps', { loadConfirmation: 'need-confirm' });
  return registry;
}

describe('executeCommand - skill commands', () => {
  let registry: SkillRegistry;
  let negotiator: SkillNegotiator;
  let context: { skillRegistry: SkillRegistry; negotiator: SkillNegotiator; userId: string };

  beforeEach(() => {
    registry = setupRegistry();
    negotiator = new SkillNegotiator();
    context = { skillRegistry: registry, negotiator, userId: 'test-user' };
  });

  test('/skill list shows available skills', () => {
    const cmd: Command = { name: 'skill', args: ['list'] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('code-review');
    expect(result.message).toContain('deploy');
  });

  test('/skill off <name> blocks a skill', () => {
    const cmd: Command = { name: 'skill', args: ['off', 'code-review'] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('blocked');
    const state = negotiator.getUsageState('code-review', 'test-user');
    expect(state?.blocked).toBe(true);
  });

  test('/skill off without name shows usage', () => {
    const cmd: Command = { name: 'skill', args: ['off'] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('Usage');
  });

  test('/skill retry <name> un-skips a skill', () => {
    negotiator.block('code-review', 'test-user');
    const cmd: Command = { name: 'skill', args: ['retry', 'code-review'] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('retry');
  });

  test('/skill unknown subcommand shows help', () => {
    const cmd: Command = { name: 'skill', args: ['unknown'] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('Usage');
  });

  test('/trigger <name> loads skill via negotiator', () => {
    const cmd: Command = { name: 'trigger', args: ['code-review'] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('code-review');
  });

  test('/trigger off <name> blocks a skill', () => {
    const cmd: Command = { name: 'trigger', args: ['off', 'deploy'] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('blocked');
  });

  test('/y confirms pending skill', () => {
    negotiator.negotiate({ manifest: { name: 'deploy', description: 'Deploy', loadConfirmation: 'need-confirm', source: 'project' }, body: '## Deploy' }, 'test-user');
    const cmd: Command = { name: 'y', args: [] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('Deploy');
  });

  test('/n skips pending skill', () => {
    negotiator.negotiate({ manifest: { name: 'deploy', description: 'Deploy', loadConfirmation: 'need-confirm', source: 'project' }, body: '## Deploy' }, 'test-user');
    const cmd: Command = { name: 'n', args: [] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('skipped');
  });

  test('/edit returns feedback', () => {
    negotiator.negotiate({ manifest: { name: 'deploy', description: 'Deploy', loadConfirmation: 'need-confirm', source: 'project' }, body: '## Deploy' }, 'test-user');
    const cmd: Command = { name: 'edit', args: ['加上回滚'] };
    const result = executeCommand(cmd, context);
    expect(result.message).toContain('回滚');
  });
});
