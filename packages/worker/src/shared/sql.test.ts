import { describe, expect, it } from 'vitest';
import {
  collectPages,
  integer,
  json,
  pageCursor,
  text,
  type SqlRow,
} from './sql';

describe('sql helpers fail fast on corrupt data', () => {
  it('text rejects null, numbers and missing columns', () => {
    expect(text({ name: 'cache' }, 'name')).toBe('cache');
    expect(() => text({ name: null }, 'name')).toThrow(
      'column name is not text',
    );
    expect(() => text({ name: 1 }, 'name')).toThrow('column name is not text');
    expect(() => text({} as SqlRow, 'name')).toThrow('column name is not text');
  });

  it('integer rejects null, fractions, overflow and mistyped values', () => {
    expect(integer({ n: 3 }, 'n')).toBe(3);
    expect(() => integer({ n: null }, 'n')).toThrow(
      'column n is not an integer',
    );
    expect(() => integer({ n: 1.5 }, 'n')).toThrow(
      'column n is not an integer',
    );
    expect(() => integer({ n: '3' }, 'n')).toThrow(
      'column n is not an integer',
    );
    expect(() => integer({ n: Number.MAX_SAFE_INTEGER + 1 }, 'n')).toThrow(
      'column n is not an integer',
    );
    expect(() => integer({} as SqlRow, 'n')).toThrow(
      'column n is not an integer',
    );
  });

  it('json rejects mistyped columns and invalid JSON', () => {
    expect(json<{ a: number }>({ doc: '{"a":1}' }, 'doc')).toEqual({ a: 1 });
    expect(() => json({ doc: null }, 'doc')).toThrow('column doc is not text');
    expect(() => json({ doc: '{invalid' }, 'doc')).toThrow(SyntaxError);
  });
});

describe('limit+1 probe pagination', () => {
  const key = (row: { name: string }): string => row.name;

  it('returns no cursor without a probe row, even on a full page', () => {
    const exact = [{ name: 'a' }, { name: 'b' }];
    expect(pageCursor(exact, 2, (row) => key(row))).toBeNull();
    expect(pageCursor([{ name: 'a' }], 2, (row) => key(row))).toBeNull();
  });

  it('returns the last item key only when a probe row exists', () => {
    const probe = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(pageCursor(probe, 2, (row) => key(row))).toBe('b');
  });

  it('collectPages terminates without an extra fetch on exact multiples', async () => {
    const calls: (string | null)[] = [];
    const items = await collectPages<string>(async (after) => {
      calls.push(after);
      if (after === null) return { items: ['a', 'b'], next_after: 'b' };
      return { items: ['c', 'd'], next_after: null };
    });
    expect(items).toEqual(['a', 'b', 'c', 'd']);
    expect(calls).toEqual([null, 'b']);
  });

  it('collectPages bails when the cursor does not advance', async () => {
    await expect(
      collectPages<string>(async () => ({
        items: ['a'],
        next_after: 'stuck',
      })),
    ).rejects.toThrow('collectPages cursor did not advance');
  });
});
