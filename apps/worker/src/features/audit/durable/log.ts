import { base64url } from 'jose';
import type { AuditEvent, PageResponse } from '../../../types';
import type { RpcResult } from '../../../rpc';
import { decodeCursor } from '../../domain/validation';
import {
  failure,
  ok,
  RpcOnlyDurableObject,
  type SqlRow,
} from '../../../infrastructure/durable/shared';

export class AuditLog extends RpcOnlyDurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, resource TEXT NOT NULL, outcome TEXT NOT NULL, metadata TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_order ON audit(timestamp DESC, id DESC);`);
  }

  async append(event: AuditEvent): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() =>
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO audit (id, timestamp, actor, action, resource, outcome, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
        event.id,
        event.timestamp,
        event.actor,
        event.action,
        event.resource,
        event.outcome,
        JSON.stringify(event.metadata),
      ),
    );
    return ok();
  }

  async list(input: {
    limit: number;
    cursor: string | null;
  }): Promise<RpcResult<PageResponse<AuditEvent>>> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      return failure('invalid_limit', 'limit must be between 1 and 100', 400);
    const cursor = decodeCursor<{ timestamp: number; id: string }>(
      input.cursor,
    );
    const rows = cursor
      ? [
          ...this.ctx.storage.sql.exec<SqlRow>(
            'SELECT id, timestamp, actor, action, resource, outcome, metadata FROM audit WHERE (timestamp < ? OR (timestamp = ? AND id < ?)) ORDER BY timestamp DESC, id DESC LIMIT ?',
            cursor.timestamp,
            cursor.timestamp,
            cursor.id,
            input.limit + 1,
          ),
        ]
      : [
          ...this.ctx.storage.sql.exec<SqlRow>(
            'SELECT id, timestamp, actor, action, resource, outcome, metadata FROM audit ORDER BY timestamp DESC, id DESC LIMIT ?',
            input.limit + 1,
          ),
        ];
    const items = rows.slice(0, input.limit).map((row) => ({
      id: String(row.id),
      timestamp: Number(row.timestamp),
      actor: String(row.actor),
      action: String(row.action),
      resource: String(row.resource),
      outcome: String(row.outcome) as AuditEvent['outcome'],
      metadata: JSON.parse(String(row.metadata)) as Record<string, string>,
    }));
    const last = rows.length > input.limit ? rows[input.limit - 1] : null;
    return ok({
      items,
      next_cursor: last
        ? base64url.encode(
            JSON.stringify({
              timestamp: Number(last.timestamp),
              id: String(last.id),
            }),
          )
        : null,
    });
  }
}
