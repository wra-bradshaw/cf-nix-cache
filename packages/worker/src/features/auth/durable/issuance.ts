import { validateGrant } from '../authorization';
import type { AuditEvent } from '../../audit/types';
import type { Grant } from '../types';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import { hashSecret } from '../credentials';
import { AuditOutbox } from '../../audit/outbox';
import { TokenSigner } from './signer';
import { first, type SqlRow, text, integer, json } from '../../../shared/sql';

type IssuedToken = {
  id: string;
  token: string;
  expires_at: number;
  repeated: boolean;
};

type Signed = Awaited<ReturnType<TokenSigner['sign']>>;

type IssueOutcome =
  | { repeated: EarlierIssue | RpcResult<never>; issued?: never }
  | { issued: RpcResult<IssuedToken>; repeated?: never };

type EarlierIssue = {
  jti: string;
  subject: string;
  grants: Grant[];
  issued_at: number;
  expires_at: number;
  revoked: boolean;
};

export const BOOTSTRAP_SCHEMA = `CREATE TABLE IF NOT EXISTS bootstrap_consumed (secret_hash TEXT PRIMARY KEY, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL);`;

/**
 * Earlier releases kept a single consumed flag that did not record which secret
 * consumed it. Attribute that flag to the currently configured hash, so an
 * upgrade can never revive a used secret: re-arming still takes a new hash.
 */
/**
 * Clears the bearer tokens that earlier releases stored for replay. A replay
 * now re-signs from the row's metadata, so storage holds no usable credential.
 */
export function scrubStoredTokens(ctx: DurableObjectState): void {
  ctx.storage.sql.exec("UPDATE tokens SET token = '' WHERE token <> ''");
}

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
    const existing = this.earlierIssue(operationId, input.fingerprint);
    if (existing) return this.replay(existing);
    const signed = await this.signer.sign(
      input.subject,
      input.grants,
      input.expires_at,
    );
    const outcome = this.ctx.storage.transactionSync((): IssueOutcome => {
      const repeated = this.earlierIssue(operationId, input.fingerprint);
      if (repeated) return { repeated };
      if (
        first(
          this.ctx.storage.sql.exec(
            'SELECT 1 FROM bootstrap_consumed WHERE secret_hash = ?',
            secretHash,
          ),
        )
      )
        return {
          issued: failure(
            'bootstrap_consumed',
            'this bootstrap secret has already been consumed; set a new BOOTSTRAP_SECRET_HASH to re-arm bootstrap',
            409,
          ),
        };
      this.ctx.storage.sql.exec(
        'INSERT INTO bootstrap_consumed (secret_hash, operation_id, fingerprint) VALUES (?, ?, ?)',
        secretHash,
        input.operation_id,
        input.fingerprint,
      );
      return {
        issued: this.insertToken(operationId, input, signed, {
          id: operationId,
          actor: input.subject,
          action: 'bootstrap',
          resource: 'system',
        }),
      };
    });
    return outcome.repeated ? this.replay(outcome.repeated) : outcome.issued;
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
    const existing = this.earlierIssue(input.operation_id, input.fingerprint);
    if (existing) return this.replay(existing);
    const signed = await this.signer.sign(
      input.subject,
      input.grants,
      input.expires_at,
    );
    const outcome = this.ctx.storage.transactionSync((): IssueOutcome => {
      const repeated = this.earlierIssue(input.operation_id, input.fingerprint);
      if (repeated) return { repeated };
      return {
        issued: this.insertToken(input.operation_id, input, signed, {
          id: `token:${input.operation_id}`,
          actor: input.actor,
          action: 'token.issue',
          resource: signed.jti,
        }),
      };
    });
    return outcome.repeated ? this.replay(outcome.repeated) : outcome.issued;
  }

  /** What an earlier attempt of this operation issued, if any. */
  private earlierIssue(
    operationId: string,
    fingerprint: string,
  ): EarlierIssue | RpcResult<never> | null {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT jti, subject, grants, issued_at, expires_at, revoked, fingerprint FROM tokens WHERE operation_id = ?',
        operationId,
      ),
    );
    if (!row) return null;
    if (text(row, 'fingerprint') !== fingerprint)
      return failure(
        'idempotency_conflict',
        'idempotency key was reused with different token metadata',
        409,
      );
    return {
      jti: text(row, 'jti'),
      subject: text(row, 'subject'),
      grants: json<Grant[]>(row, 'grants'),
      issued_at: integer(row, 'issued_at'),
      expires_at: integer(row, 'expires_at'),
      revoked: integer(row, 'revoked') === 1,
    };
  }

  private async replay(
    earlier: EarlierIssue | RpcResult<never>,
  ): Promise<RpcResult<IssuedToken>> {
    if ('ok' in earlier) return earlier;
    if (earlier.revoked)
      return failure(
        'token_revoked',
        'the token issued for this idempotency key has been revoked',
        409,
      );
    return ok({
      id: earlier.jti,
      token: await this.signer.signFor(
        earlier,
        earlier.subject,
        earlier.grants,
        earlier.expires_at,
      ),
      expires_at: earlier.expires_at,
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
      '',
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
