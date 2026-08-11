import { describe, expect, it } from 'vitest';
import { assertIdempotencyKey } from './identifiers';
import { DomainError } from './errors';

describe('request identifiers', () => {
  it('requires printable idempotency keys', () => {
    expect(assertIdempotencyKey('retry-1')).toBe('retry-1');
    expect(() => assertIdempotencyKey(null)).toThrow(DomainError);
    expect(() => assertIdempotencyKey('bad\nkey')).toThrow(DomainError);
  });
});
