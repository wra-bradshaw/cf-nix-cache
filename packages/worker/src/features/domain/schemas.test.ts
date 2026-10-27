import { describe, expect, it } from 'vitest';
import { parseJsonSchema, DomainError } from './errors';
import { TokenRequestSchema, UploadRequestSchema } from './schemas';
import { manifest } from './test-fixtures';

describe('wire contract parsing', () => {
  it('uses strict schemas at JSON boundaries', () => {
    expect(() =>
      parseJsonSchema(TokenRequestSchema, {
        subject: 'alice',
        valid_for_seconds: 60,
        grants: [{ cache: 'cache', role: 'push' }],
        extra: true,
      }),
    ).toThrow(DomainError);
    expect(() =>
      parseJsonSchema(UploadRequestSchema, {
        manifest,
        compressed_size: 1,
        extra: true,
      }),
    ).toThrow(DomainError);
    expect(
      parseJsonSchema(TokenRequestSchema, {
        subject: 'alice',
        valid_for_seconds: 60,
        grants: [{ cache: 'cache', role: 'push' }],
      }).subject,
    ).toBe('alice');
  });
});
