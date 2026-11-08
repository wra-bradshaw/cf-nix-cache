import type { AuditEvent } from '../types';
import {
  type PageResponse,
  decodeCursor,
  encodeCursor,
} from '../../../shared/cursors';
import { type RpcResult, failure, ok } from '../../../shared/rpc';
import type { SqlRow } from '../../../shared/sql';
import { text, integer, json } from '../../../shared/sql';
import { RpcOnlyDurableObject } from '../../../shared/rpc-only-durable-object';

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
    // Fail-closed paging tradeoff: one corrupt row fails the whole page with
    // `corrupt_audit` 500 instead of skipping the row. Skipping would hide
    // audit history (an attacker could obscure an action by corrupting its
    // row and having it silently dropped), while failing the page keeps
    // tampering visible. Operators recover by reading past the corrupt row
    // with a cursor or by re-seeding from the owning outbox.
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
    const items = (() => {
      try {
        return rows.slice(0, input.limit).map((row) => ({
          id: text(row, 'id'),
          timestamp: integer(row, 'timestamp'),
          actor: text(row, 'actor'),
          action: text(row, 'action'),
          resource: text(row, 'resource'),
          outcome: auditOutcome(text(row, 'outcome')),
          metadata: auditMetadata(json<unknown>(row, 'metadata')),
        }));
      } catch {
        return null;
      }
    })();
    if (!items)
      return failure('corrupt_audit', 'audit log record is corrupt', 500);
    const last = rows.length > input.limit ? rows[input.limit - 1] : null;
    try {
      return ok({
        items,
        next_cursor: last
          ? encodeCursor({
              timestamp: integer(last, 'timestamp'),
              id: text(last, 'id'),
            })
          : null,
      });
    } catch {
      return failure('corrupt_audit', 'audit log record is corrupt', 500);
    }
  }
}

function auditOutcome(value: string): AuditEvent['outcome'] {
  if (value === 'success' || value === 'accepted' || value === 'failure')
    return value;
  throw new Error(`audit outcome ${value} is not a known outcome`);
}

/**
 * Audit metadata is `{ [k: string]: string }` per the contract. `json()` only
 * proves the column parses, so allow-list the shape here: a non-object or a
 * non-string value reads as corrupt (fail-closed page) rather than flowing a
 * mistyped value to API readers.
 */
function auditMetadata(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('audit metadata is not an object');
  for (const entry of Object.values(value as Record<string, unknown>))
    if (typeof entry !== 'string')
      throw new Error('audit metadata value is not a string');
  return value as Record<string, string>;
}
