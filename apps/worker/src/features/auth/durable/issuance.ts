import { validateGrant } from '../../domain/validation';
import type { Grant } from '../../../types';
import type { RpcResult } from '../../../rpc';
import { hashSecret } from '../credentials';
import { TokenAudit } from './audit';
import { TokenSigner } from './signer';
import {
  failure,
  first,
  ok,
  type SqlRow,
} from '../../../infrastructure/durable/shared';

export class TokenIssuance {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly signer: TokenSigner,
    private readonly audit: TokenAudit,
  ) {}

  async bootstrap(input: {
    operation_id: string;
    fingerprint: string;
    subject: string;
    grants: Grant[];
    expires_at: number;
    secret: string;
  }): Promise<
    RpcResult<{
      id: string;
      token: string;
      expires_at: number;
      repeated: boolean;
    }>
  > {
    if (!input.grants.length || !input.grants.every(validateGrant))
      return failure('invalid_input', 'bootstrap grants are invalid', 422);
    if ((await hashSecret(input.secret)) !== this.env.BOOTSTRAP_SECRET_HASH)
      return failure('forbidden', 'invalid bootstrap secret', 403);
    const operationId = `bootstrap:${input.operation_id}`;
    const existing = this.findOperation(operationId);
    if (existing) {
      if (String(existing.fingerprint) !== input.fingerprint)
        return failure(
          'idempotency_conflict',
          'idempotency key was reused with different token metadata',
          409,
        );
      return ok({
        id: String(existing.jti),
        token: String(existing.token),
        expires_at: Number(existing.expires_at),
        repeated: true,
      });
    }
    const signed = await this.signer.sign(
      input.subject,
      input.grants,
      input.expires_at,
    );
    return this.ctx.storage.transactionSync(() => {
      const operation = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT jti, token, expires_at, fingerprint FROM tokens WHERE operation_id = ?',
          operationId,
        ),
      );
      if (operation) {
        if (String(operation.fingerprint) !== input.fingerprint)
          return failure(
            'idempotency_conflict',
            'idempotency key was reused with different token metadata',
            409,
          );
        return ok({
          id: String(operation.jti),
          token: String(operation.token),
          expires_at: Number(operation.expires_at),
          repeated: true,
        });
      }
      const consumed = first(
        this.ctx.storage.sql.exec('SELECT 1 FROM bootstrap WHERE key = 1'),
      );
      if (consumed)
        return failure(
          'bootstrap_consumed',
          'bootstrap has already been consumed',
          409,
        );
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
      this.ctx.storage.sql.exec(
        'INSERT INTO bootstrap (key, operation_id, fingerprint) VALUES (1, ?, ?)',
        input.operation_id,
        input.fingerprint,
      );
      this.audit.enqueue({
        id: `bootstrap:${input.operation_id}`,
        timestamp: signed.issued_at,
        actor: input.subject,
        action: 'bootstrap',
        resource: 'system',
        outcome: 'success',
        metadata: {},
      });
      return ok({
        id: signed.jti,
        token: signed.token,
        expires_at: input.expires_at,
        repeated: false,
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
  }): Promise<
    RpcResult<{
      id: string;
      token: string;
      expires_at: number;
      repeated: boolean;
    }>
  > {
    if (!input.grants.length || !input.grants.every(validateGrant))
      return failure('invalid_input', 'token grants are invalid', 422);
    const existing = this.findOperation(input.operation_id);
    if (existing) {
      if (String(existing.fingerprint) !== input.fingerprint)
        return failure(
          'idempotency_conflict',
          'idempotency key was reused with different token metadata',
          409,
        );
      return ok({
        id: String(existing.jti),
        token: String(existing.token),
        expires_at: Number(existing.expires_at),
        repeated: true,
      });
    }
    const signed = await this.signer.sign(
      input.subject,
      input.grants,
      input.expires_at,
    );
    return this.ctx.storage.transactionSync(() => {
      const old = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT jti, token, expires_at, fingerprint FROM tokens WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      if (old) {
        if (String(old.fingerprint) !== input.fingerprint)
          return failure(
            'idempotency_conflict',
            'idempotency key was reused with different token metadata',
            409,
          );
        return ok({
          id: String(old.jti),
          token: String(old.token),
          expires_at: Number(old.expires_at),
          repeated: true,
        });
      }
      this.ctx.storage.sql.exec(
        'INSERT INTO tokens (jti, subject, expires_at, issued_at, grants, revoked, token, operation_id, fingerprint) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
        signed.jti,
        input.subject,
        input.expires_at,
        signed.issued_at,
        JSON.stringify(input.grants),
        signed.token,
        input.operation_id,
        input.fingerprint,
      );
      this.audit.enqueue({
        id: `token:${input.operation_id}`,
        timestamp: signed.issued_at,
        actor: input.actor,
        action: 'token.issue',
        resource: signed.jti,
        outcome: 'success',
        metadata: {},
      });
      return ok({
        id: signed.jti,
        token: signed.token,
        expires_at: input.expires_at,
        repeated: false,
      });
    });
  }

  private findOperation(operationId: string): SqlRow | null {
    return (
      first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT jti, token, expires_at, fingerprint FROM tokens WHERE operation_id = ?',
          operationId,
        ),
      ) ?? null
    );
  }
}
