import { describe, expect, it } from 'vitest';
import { stripPlanFrontmatter } from '../plan/plan-presentation.js';

describe('stripPlanFrontmatter', () => {
  it.each(['\n', '\r\n'])('strips one complete leading block with %j newlines', (nl) => {
    const input = [
      '---',
      'session: sess-1',
      'status: pending',
      '---',
      '',
      '# Plan',
      '',
      'Do **this**.',
    ].join(nl);

    expect(stripPlanFrontmatter(input)).toBe(['# Plan', '', 'Do **this**.'].join(nl));
  });

  it('preserves thematic breaks in the Markdown body', () => {
    expect(stripPlanFrontmatter('# Plan\n\n---\n\nNext')).toBe('# Plan\n\n---\n\nNext');
  });

  it('preserves an incomplete leading frontmatter block', () => {
    expect(stripPlanFrontmatter('---\nstatus: pending\n# Plan')).toBe('---\nstatus: pending\n# Plan');
  });

  it('returns an empty string when the file contains only frontmatter', () => {
    expect(stripPlanFrontmatter('---\nsession: sess-1\n---\n')).toBe('');
  });
});
