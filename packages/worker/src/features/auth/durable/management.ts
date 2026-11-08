import {
  decodeCursor,
  encodeCursor,
  type PageResponse,
} from '../../../shared/cursors';
import type { TokenSummary } from '../types';
import { type RpcResult, conflict, failure, ok } from '../../../shared/rpc';
import { toTokenSummary } from './token-summary';
import { AuditOutbox } from '../../audit/outbox';
import { first, type SqlRow, text, integer } from '../../../shared/sql';
import { now } from '../../../shared/clock';

export class TokenManagement {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly audit: AuditOutbox,
  ) {}

  async check(input: {
    jti: string;
    exp: number;
  }): Promise<RpcResult<{ active: boolean }>> {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT revoked, expires_at FROM tokens WHERE jti = ?',
        input.jti,
      ),
    );
    if (!row) return ok({ active: false });
    try {
      return ok({
        active: Boolean(
          !revokedFlag(integer(row, 'revoked')) &&
            integer(row, 'expires_at') >= now() &&
            integer(row, 'expires_at') === input.exp,
        ),
      });
    } catch {
      return failure('corrupt_token', 'token record is corrupt', 500);
    }
  }

  async revoke(input: {
    operation_id: string;
    jti: string;
    actor: string;
  }): Promise<RpcResult<void>> {
    return this.ctx.storage.transactionSync(() => {
      const old = first(
        this.ctx.storage.sql.exec<SqlRow>(
          'SELECT jti FROM token_operations WHERE operation_id = ?',
          input.operation_id,
        ),
      );
      try {
        if (old && text(old, 'jti') !== input.jti)
          return conflict(
            'idempotency_conflict',
            'revocation operation changed token',
          );
      } catch {
        return failure('corrupt_token', 'token record is corrupt', 500);
      }
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
      return ok();
    });
  }

  async list(input: {
    limit: number;
    cursor: string | null;
  }): Promise<RpcResult<PageResponse<TokenSummary>>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      return failure('invalid_limit', 'limit must be between 1 and 100', 400);
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
    const items = (() => {
      try {
        return rows.slice(0, input.limit).map((row) => {
          // Allow-list the stored 0/1 before toTokenSummary: its
          // `=== 1` check would coerce a corrupt 2 to "not revoked".
          // Throwing here maps to `corrupt_token` 500 below.
          revokedFlag(integer(row, 'revoked'));
          return toTokenSummary(row);
        });
      } catch {
        return null;
      }
    })();
    if (!items) return failure('corrupt_token', 'token record is corrupt', 500);
    const last = rows.length > input.limit ? rows[input.limit - 1] : null;
    try {
      return ok({
        items,
        next_cursor: last
          ? encodeCursor({
              issued_at: integer(last, 'issued_at'),
              jti: text(last, 'jti'),
            })
          : null,
      });
    } catch {
      return failure('corrupt_token', 'token record is corrupt', 500);
    }
  }
}

function revokedFlag(value: number): boolean {
  // SQLite has no boolean type: `revoked` is stored as 0/1. An allow-list
  // keeps a corrupt 2/-1 from coercing (=== 0 reads 2 as revoked, === 1
  // reads 2 as active); any other integer throws so callers map it to
  // `corrupt_token` 500.
  if (value === 1) return true;
  if (value === 0) return false;
  throw new Error(`token revoked flag ${value} is not 0 or 1`);
}
