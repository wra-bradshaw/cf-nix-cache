import { describe, expect, it } from 'vitest';
import {
  parseJsonSchema,
  BootstrapRequestSchema,
  TokenRequestSchema,
  EncodedUploadRequestSchema,
} from './schemas';
import { DomainError } from './errors';
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
      parseJsonSchema(EncodedUploadRequestSchema, {
        manifest,
        encoding_id: 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1',
        chunks: [
          {
            raw_hash: `sha256:${'0'.repeat(52)}`,
            raw_size: 1,
            compressed_hash: `sha256:${'0'.repeat(52)}`,
            compressed_size: 1,
          },
        ],
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

  it('accepts token lifetimes up to 200 years', () => {
    const request = (valid_for_seconds: number) => ({
      subject: 'alice',
      valid_for_seconds,
      grants: [{ cache: '*', role: 'admin' }],
    });
    for (const [schema, extra] of [
      [TokenRequestSchema, {}],
      [BootstrapRequestSchema, { secret: 'secret' }],
    ] as const) {
      expect(
        parseJsonSchema(schema, { ...request(6311520000), ...extra })
          .valid_for_seconds,
      ).toBe(6311520000);
      expect(() =>
        parseJsonSchema(schema, { ...request(6311520001), ...extra }),
      ).toThrow(DomainError);
    }
  });
});
