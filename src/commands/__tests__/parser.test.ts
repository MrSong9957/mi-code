import { describe, test, expect } from 'vitest';
import { parseCommand, parseBlockPrefix } from '../parser.js';

describe('parseCommand', () => {
  test('parses /skill list', () => {
    const cmd = parseCommand('/skill list');
    expect(cmd).toEqual({ name: 'skill', args: ['list'] });
  });

  test('parses /skill off code-review', () => {
    const cmd = parseCommand('/skill off code-review');
    expect(cmd).toEqual({ name: 'skill', args: ['off', 'code-review'] });
  });

  test('parses /trigger deploy', () => {
    const cmd = parseCommand('/trigger deploy');
    expect(cmd).toEqual({ name: 'trigger', args: ['deploy'] });
  });

  test('parses /trigger off deploy', () => {
    const cmd = parseCommand('/trigger off deploy');
    expect(cmd).toEqual({ name: 'trigger', args: ['off', 'deploy'] });
  });

  test('returns null for non-command input', () => {
    expect(parseCommand('hello world')).toBeNull();
  });

  test('parses /y as command', () => {
    const cmd = parseCommand('/y');
    expect(cmd).toEqual({ name: 'y', args: [] });
  });

  test('parses /n as command', () => {
    const cmd = parseCommand('/n');
    expect(cmd).toEqual({ name: 'n', args: [] });
  });

  test('parses /edit with feedback', () => {
    const cmd = parseCommand('/edit 加上回滚步骤');
    expect(cmd).toEqual({ name: 'edit', args: ['加上回滚步骤'] });
  });
});

describe('parseBlockPrefix', () => {
  test('parses !skill_name as block request', () => {
    const result = parseBlockPrefix('!code-review');
    expect(result).toEqual({ skillName: 'code-review' });
  });

  test('parses !trigger skill_name as block request', () => {
    const result = parseBlockPrefix('!trigger deploy');
    expect(result).toEqual({ skillName: 'deploy' });
  });

  test('parses !load_skill skill_name as block request', () => {
    const result = parseBlockPrefix('!load_skill code-review');
    expect(result).toEqual({ skillName: 'code-review' });
  });

  test('returns null for non-block input', () => {
    expect(parseBlockPrefix('hello')).toBeNull();
  });

  test('returns null for ! without skill name', () => {
    expect(parseBlockPrefix('!')).toBeNull();
  });
});
