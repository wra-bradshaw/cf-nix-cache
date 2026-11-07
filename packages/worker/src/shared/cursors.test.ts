import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursors';

describe('pagination cursors', () => {
  it('keeps cursors opaque while preserving their value', () => {
    const cursor = encodeCursor({ id: 'last', timestamp: 42 });
    expect(cursor).not.toContain('{');
    expect(decodeCursor(cursor)).toEqual({ id: 'last', timestamp: 42 });
  });

  it('matches the unpadded base64 token cursors issued before', () => {
    // ASCII JSON never produces the 6-bit groups that differ between
    // base64 and base64url, so released cursors stay byte-identical.
    const value = {
      issued_at: 1_767_225_600,
      jti: '0123456789abcdef0123456789abcdef',
    };
    expect(encodeCursor(value)).toBe(
      btoa(JSON.stringify(value)).replaceAll('=', ''),
    );
  });
});
