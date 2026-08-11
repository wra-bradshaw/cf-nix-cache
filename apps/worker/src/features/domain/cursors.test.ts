import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursors';

describe('pagination cursors', () => {
  it('keeps cursors opaque while preserving their value', () => {
    const cursor = encodeCursor({ id: 'last', timestamp: 42 });
    expect(cursor).not.toContain('{');
    expect(decodeCursor(cursor)).toEqual({ id: 'last', timestamp: 42 });
  });
});
