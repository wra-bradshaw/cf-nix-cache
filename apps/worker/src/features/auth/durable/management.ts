import { decodeCursor } from '../../domain/validation';
import type { PageResponse, TokenSummary } from '../../../types';
import type { RpcResult } from '../../../rpc';
import { now, type SqlRow } from '../../../infrastructure/durable/shared';
import { failure, toTokenSummary } from './model';
import { TokenAudit } from './audit';

export class TokenManagement {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly audit: TokenAudit,
  ) {}

  async check(input: {
    jti: string;
    exp: number;
  }): Promise<RpcResult<{ active: boolean }>> {
    const row = [
      ...this.ctx.storage.sql.exec<{ revoked: number; expires_at: number }>(
        'SELECT revoked, expires_at FROM tokens WHERE jti = ?',
        input.jti,
      ),
    ][0];
    return {
      ok: true,
      value: {
        active: Boolean(
          row &&
          Number(row.revoked) === 0 &&
          Number(row.expires_at) >= now() &&
          Number(row.expires_at) === input.exp,
        ),
      },
    };
  }

  async revoke(input: {
    operation_id: string;
    jti: string;
    actor: string;
  }): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const old = [
        ...this.ctx.storage.sql.exec<{ jti: string }>(
          'SELECT jti FROM token_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      ][0];
      if (old && old.jti !== input.jti)
        return failure(
          'idempotency_conflict',
          'revocation operation changed token',
          409,
        );
      this.ctx.storage.sql.exec(
        'UPDATE tokens SET revoked = 1 WHERE jti = ?',
        input.jti,
      );
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO token_operations (operation_id, jti) VALUES (?, ?)',
        input.operation_id,
        input.jti,
      );
      this.audit.enqueue({
        id: input.operation_id,
        timestamp: now(),
        actor: input.actor,
        action: 'token.revoke',
        resource: input.jti,
        outcome: 'success',
        metadata: {},
      });
      return { ok: true, value: undefined };
    });
  }

  async list(input: {
    limit: number;
    cursor: string | null;
  }): Promise<RpcResult<PageResponse<TokenSummary>>> {
    const cursor = decodeCursor<{ issued_at: number; jti: string }>(
      input.cursor,
    );
    const rows = cursor
      ? [
          ...this.ctx.storage.sql.exec<SqlRow>(
            'SELECT jti, subject, expires_at, issued_at, grants, revoked FROM tokens WHERE (issued_at < ? OR (issued_at = ? AND jti < ?)) ORDER BY issued_at DESC, jti DESC LIMIT ?',
            cursor.issued_at,
            cursor.issued_at,
            cursor.jti,
            input.limit + 1,
          ),
        ]
      : [
          ...this.ctx.storage.sql.exec<SqlRow>(
            'SELECT jti, subject, expires_at, issued_at, grants, revoked FROM tokens ORDER BY issued_at DESC, jti DESC LIMIT ?',
            input.limit + 1,
          ),
        ];
    const items = rows.slice(0, input.limit).map(toTokenSummary);
    const last = rows.length > input.limit ? rows[input.limit - 1] : null;
    return {
      ok: true,
      value: {
        items,
        next_cursor: last
          ? btoa(
              JSON.stringify({
                issued_at: Number(last.issued_at),
                jti: String(last.jti),
              }),
            ).replaceAll('=', '')
          : null,
      },
    };
  }
}
