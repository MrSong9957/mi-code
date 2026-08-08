import { describe, expect, it } from 'vitest';
import { enUS } from '../../locale/resources/en-US.js';
import { zhCN } from '../../locale/resources/zh-CN.js';

const PLACEHOLDER_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;

function placeholderNames(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1] ?? '')
    .sort();
}

function compareSharedLeaves(left: unknown, right: unknown, path: string[] = []): void {
  if (typeof left === 'string' && typeof right === 'string') {
    expect(placeholderNames(right), `${path.join('.')} placeholder names`).toEqual(
      placeholderNames(left),
    );
    return;
  }

  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;

  for (const key of Object.keys(leftRecord)) {
    if (!(key in rightRecord)) continue;
    compareSharedLeaves(leftRecord[key], rightRecord[key], [...path, key]);
  }
}

describe('locale resource placeholder shape', () => {
  it('matches placeholder-name sets for every shared string leaf', () => {
    compareSharedLeaves(zhCN, enUS);
  });
});
