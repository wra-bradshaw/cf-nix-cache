import { validateGrant } from '../authorization';
import type { AuditEvent } from '../../audit/types';
import type { Grant } from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { hashSecret } from '../credentials';
import { AuditOutbox } from '../../audit/outbox';
import { TokenSigner } from './signer';
import { first, type SqlRow } from '../../../shared/sql';

type IssuedToken = {
  id: string;
  token: string;
  expires_at: number;
  repeated: boolean;
};

type Signed = Awaited<ReturnType<TokenSigner['sign']>>;

export const BOOTSTRAP_SCHEMA = `CREATE TABLE IF NOT EXISTS bootstrap_consumed (secret_hash TEXT PRIMARY KEY, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL);`;

/**
 * Earlier releases kept a single consumed flag that did not record which secret
 * consumed it. Attribute that flag to the currently configured hash, so an
 * upgrade can never revive a used secret: re-arming still takes a new hash.
 */
export function migrateLegacyBootstrap(
  ctx: DurableObjectState,
  env: Env,
): void {
  const sql = ctx.storage.sql;
  const legacy = first(
    sql.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bootstrap'",
    ),
  );
  if (!legacy || !env.BOOTSTRAP_SECRET_HASH) return;
  ctx.storage.transactionSync(() => {
    sql.exec(
      'INSERT OR IGNORE INTO bootstrap_consumed (secret_hash, operation_id, fingerprint) SELECT ?, operation_id, fingerprint FROM bootstrap WHERE key = 1',
      env.BOOTSTRAP_SECRET_HASH,
    );
    sql.exec('DROP TABLE bootstrap');
  });
}

export class TokenIssuance {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly signer: TokenSigner,
    private readonly audit: AuditOutbox,
  ) {}

  async bootstrap(input: {
    operation_id: string;
    fingerprint: string;
    subject: string;
    grants: Grant[];
    expires_at: number;
    secret: string;
  }): Promise<RpcResult<IssuedToken>> {
    if (!input.grants.length || !input.grants.every(validateGrant))
      return failure('invalid_input', 'bootstrap grants are invalid', 422);
    const secretHash = await hashSecret(input.secret);
    if (secretHash !== this.env.BOOTSTRAP_SECRET_HASH)
      return failure('forbidden', 'invalid bootstrap secret', 403);
    // Scoped to the secret, so a re-armed bootstrap that reuses an idempotency
    // key mints a new token instead of replaying one from an earlier secret.
    const operationId = `bootstrap:${secretHash.slice(0, 16)}:${input.operation_id}`;
    const existing = this.replay(operationId, input.fingerprint);
    if (existing) return existing;
    const signed = await this.signer.sign(
      input.subject,
      input.grants,
      input.expires_at,
    );
    return this.ctx.storage.transactionSync(() => {
      const repeated = this.replay(operationId, input.fingerprint);
      if (repeated) return repeated;
      if (
        first(
          this.ctx.storage.sql.exec(
            'SELECT 1 FROM bootstrap_consumed WHERE secret_hash = ?',
            secretHash,
          ),
        )
      )
        return failure(
          'bootstrap_consumed',
          'this bootstrap secret has already been consumed; set a new BOOTSTRAP_SECRET_HASH to re-arm bootstrap',
          409,
        );
      this.ctx.storage.sql.exec(
        'INSERT INTO bootstrap_consumed (secret_hash, operation_id, fingerprint) VALUES (?, ?, ?)',
        secretHash,
        input.operation_id,
        input.fingerprint,
      );
      return this.insertToken(operationId, input, signed, {
        id: operationId,
        actor: input.subject,
        action: 'bootstrap',
        resource: 'system',
      });
    });
  }

  async issue(input: {
    operation_id: string;
    fingerprint: string;
    actor: string;
    subject: string;
    grants: Grant[];
    expires_at: number;
  }): Promise<RpcResult<IssuedToken>> {
    if (!input.grants.length || !input.grants.every(validateGrant))
      return failure('invalid_input', 'token grants are invalid', 422);
    const existing = this.replay(input.operation_id, input.fingerprint);
    if (existing) return existing;
    const signed = await this.signer.sign(
      input.subject,
      input.grants,
      input.expires_at,
    );
    return this.ctx.storage.transactionSync(
      () =>
        this.replay(input.operation_id, input.fingerprint) ??
        this.insertToken(input.operation_id, input, signed, {
          id: `token:${input.operation_id}`,
          actor: input.actor,
          action: 'token.issue',
          resource: signed.jti,
        }),
    );
  }

  /** The stored result of an earlier attempt of this operation, if any. */
  private replay(
    operationId: string,
    fingerprint: string,
  ): RpcResult<IssuedToken> | null {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT jti, token, expires_at, fingerprint FROM tokens WHERE operation_id = ?',
        operationId,
      ),
    );
    if (!row) return null;
    if (String(row.fingerprint) !== fingerprint)
      return failure(
        'idempotency_conflict',
        'idempotency key was reused with different token metadata',
        409,
      );
    return ok({
      id: String(row.jti),
      token: String(row.token),
      expires_at: Number(row.expires_at),
      repeated: true,
    });
  }

  private insertToken(
    operationId: string,
    input: {
      fingerprint: string;
      subject: string;
      grants: Grant[];
      expires_at: number;
    },
    signed: Signed,
    audit: Pick<AuditEvent, 'id' | 'actor' | 'action' | 'resource'>,
  ): RpcResult<IssuedToken> {
    this.ctx.storage.sql.exec(
      'INSERT INTO tokens (jti, subject, expires_at, issued_at, grants, revoked, token, operation_id, fingerprint) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
      signed.jti,
      input.subject,
      input.expires_at,
      signed.issued_at,
      JSON.stringify(input.grants),
      signed.token,
      operationId,
      input.fingerprint,
    );
    this.audit.enqueue({
      ...audit,
      timestamp: signed.issued_at,
      outcome: 'success',
      metadata: {},
    });
    return ok({
      id: signed.jti,
      token: signed.token,
      expires_at: input.expires_at,
      repeated: false,
    });
  }
}
