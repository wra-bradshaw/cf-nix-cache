/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { hashSecret } from '../credentials';
import type { AuditOutbox } from '../../audit/outbox';
import { BOOTSTRAP_SCHEMA, TokenIssuance } from './issuance';
import type { TokenSigner } from './signer';

const TOKENS = `CREATE TABLE tokens (
  jti TEXT PRIMARY KEY, subject TEXT NOT NULL, expires_at INTEGER NOT NULL,
  issued_at INTEGER NOT NULL, grants TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  operation_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL
);`;

function fakeState() {
  const db = new DatabaseSync(':memory:');
  db.exec(TOKENS);
  const ctx = {
    storage: {
      sql: {
        exec: (query: string, ...args: (string | number | null)[]) =>
          db.prepare(query).all(...args),
      },
      transactionSync: <T>(operation: () => T): T => {
        db.exec('BEGIN');
        try {
          const result = operation();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    },
  };
  return { db, ctx: ctx as unknown as DurableObjectState };
}

function installation(ctx: DurableObjectState) {
  let minted = 0;
  const signer = {
    sign: async () => {
      minted += 1;
      return { jti: `${minted}`, token: `token-${minted}`, issued_at: 1 };
    },
    signFor: async ({ jti }: { jti: string }) => `token-${jti}`,
  } as unknown as TokenSigner;
  const audit = { enqueue: () => undefined } as unknown as AuditOutbox;
  const env = {} as Env;
  const issuance = new TokenIssuance(ctx, env, signer, audit);
  return {
    env,
    arm: async (secret: string) => {
      env.BOOTSTRAP_SECRET_HASH = await hashSecret(secret);
    },
    bootstrap: (secret: string, operationId: string) =>
      issuance.bootstrap({
        operation_id: operationId,
        fingerprint: 'same-request',
        subject: 'admin',
        grants: [{ cache: '*', role: 'admin' }],
        expires_at: 100,
        secret,
      }),
  };
}

function fresh() {
  const { db, ctx } = fakeState();
  db.exec(BOOTSTRAP_SCHEMA);
  return installation(ctx);
}

const errorStatus = (result: { ok: boolean; error?: { status: number } }) =>
  result.ok ? null : result.error?.status;

describe('re-armable bootstrap', () => {
  it('lets each secret mint only one token', async () => {
    const { arm, bootstrap } = fresh();
    await arm('first');
    expect((await bootstrap('first', 'a')).ok).toBe(true);
    expect(errorStatus(await bootstrap('first', 'b'))).toBe(409);
  });

  it('replays the same idempotency key under the same secret', async () => {
    const { arm, bootstrap } = fresh();
    await arm('first');
    const original = await bootstrap('first', 'a');
    const replay = await bootstrap('first', 'a');
    expect(replay).toMatchObject({
      ok: true,
      value: { token: 'token-1', repeated: true },
    });
    expect(original).toMatchObject({ value: { repeated: false } });
  });

  it('re-arms with a new hash and rejects the replaced secret', async () => {
    const { arm, bootstrap } = fresh();
    await arm('first');
    await bootstrap('first', 'a');
    await arm('second');
    expect(errorStatus(await bootstrap('first', 'b'))).toBe(403);
    expect(await bootstrap('second', 'b')).toMatchObject({
      ok: true,
      value: { token: 'token-2', repeated: false },
    });
    expect(errorStatus(await bootstrap('second', 'c'))).toBe(409);
  });

  it('never revives a used secret by setting its hash again', async () => {
    const { arm, bootstrap } = fresh();
    await arm('first');
    await bootstrap('first', 'a');
    await arm('second');
    await arm('first');
    expect(errorStatus(await bootstrap('first', 'b'))).toBe(409);
  });

  it('mints a new token when a new secret reuses a key', async () => {
    const { arm, bootstrap } = fresh();
    await arm('first');
    await bootstrap('first', 'same-key');
    await arm('second');
    expect(await bootstrap('second', 'same-key')).toMatchObject({
      ok: true,
      value: { token: 'token-2', repeated: false },
    });
  });
});

describe('stored tokens', () => {
  function issued() {
    const { db, ctx } = fakeState();
    db.exec(BOOTSTRAP_SCHEMA);
    const { arm, bootstrap } = installation(ctx);
    return { db, ctx, arm, bootstrap };
  }

  it('replays by signing again', async () => {
    const { arm, bootstrap } = issued();
    await arm('first');
    await bootstrap('first', 'a');
    expect(await bootstrap('first', 'a')).toMatchObject({
      ok: true,
      value: { token: 'token-1', repeated: true },
    });
  });

  it('refuses to replay a revoked token', async () => {
    const { db, arm, bootstrap } = issued();
    await arm('first');
    await bootstrap('first', 'a');
    db.exec('UPDATE tokens SET revoked = 1');
    expect(await bootstrap('first', 'a')).toMatchObject({
      ok: false,
      error: { code: 'token_revoked', status: 409 },
    });
  });
});
