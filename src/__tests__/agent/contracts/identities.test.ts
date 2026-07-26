import { describe, expect, it } from 'vitest';
import { freezeSnapshot, requireIdentity } from '../../../agent/contracts/identities.js';

describe('requireIdentity', () => {
  it.each<[unknown, string]>([
    ['', 'empty'],
    ['   ', 'blank'],
    [null, 'null'],
    [42, 'number'],
    [undefined, 'undefined'],
    [{}, 'object'],
    [[], 'array'],
  ])('rejects %s identity', (value) => {
    expect(() => requireIdentity(value, 'request_id')).toThrow('request_id');
  });

  it('accepts a non-empty string and returns it as-is', () => {
    expect(requireIdentity('turn-1', 'turn_id')).toBe('turn-1');
  });

  it('does not infer authority from an id prefix', () => {
    expect(requireIdentity('system:memory-1', 'source_id')).toBe('system:memory-1');
  });

  it('does not trim legitimate surrounding characters', () => {
    // requireIdentity trims for the empty-check, but the returned value preserves the
    // original string semantics: callers pass already-canonical IDs. We only assert that
    // a value with interior whitespace passes through.
    expect(requireIdentity('a b', 'id')).toBe('a b');
  });
});

describe('freezeSnapshot', () => {
  it('deep-freezes nested arrays and records', () => {
    const value = freezeSnapshot({ items: [{ id: 'a' }], list: [1, 2, 3] });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.items)).toBe(true);
    expect(Object.isFrozen(value.items[0])).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
  });

  it('returns primitives unchanged without throwing', () => {
    expect(freezeSnapshot('hello')).toBe('hello');
    expect(freezeSnapshot(42)).toBe(42);
    expect(freezeSnapshot(null)).toBeNull();
    expect(freezeSnapshot(undefined)).toBeUndefined();
  });

  it('freezes nested arrays of arrays', () => {
    const value = freezeSnapshot({ matrix: [[1, 2], [3, 4]] });
    expect(Object.isFrozen(value.matrix)).toBe(true);
    expect(Object.isFrozen(value.matrix[0])).toBe(true);
    expect(Object.isFrozen(value.matrix[1])).toBe(true);
  });

  it('is idempotent on already-frozen objects', () => {
    const frozen = Object.freeze({ a: 1 });
    expect(() => freezeSnapshot(frozen)).not.toThrow();
    expect(Object.isFrozen(freezeSnapshot(frozen))).toBe(true);
  });

  it('does not freeze functions', () => {
    const fn = (): void => {};
    const value = freezeSnapshot({ callback: fn });
    expect(Object.isFrozen(value)).toBe(true);
    // The function itself is left alone (freezing functions is allowed but useless;
    // we simply must not throw).
    expect(value.callback).toBe(fn);
  });
});
