import type { AuditEvent } from '../../types';
import { auditStub } from '../../features/audit/shard';
import { first, now, type SqlRow } from './shared';

export const AUDIT_OUTBOX_SCHEMA =
  'CREATE TABLE IF NOT EXISTS audit_outbox (event_id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at INTEGER NOT NULL);';

const BATCH_SIZE = 50;
const RETRY_DELAY_MS = 30_000;
const BACKLOG_DELAY_MS = 1_000;

/**
 * Transactional outbox for audit events. Events are written alongside the
 * owning Durable Object's state and delivered to the AuditLog shards after
 * commit; an alarm retries delivery until the outbox is empty.
 */
export class AuditOutbox {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  /** Records an event; callable inside the owner's transaction. */
  enqueue(event: AuditEvent): void {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO audit_outbox (event_id, event, created_at) VALUES (?, ?, ?)',
      event.id,
      JSON.stringify(event),
      now(),
    );
    this.ctx.waitUntil(this.drain());
  }

  async alarm(): Promise<void> {
    await this.drain();
  }

  pending(): number {
    const row = first(
      this.ctx.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM audit_outbox',
      ),
    );
    return Number(row?.count ?? 0);
  }

  /**
   * Delivers one bounded batch. Returns false, with a retry alarm scheduled,
   * when the audit log rejects or cannot be reached.
   */
  async drain(): Promise<boolean> {
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        'SELECT event_id, event FROM audit_outbox ORDER BY created_at LIMIT ?',
        BATCH_SIZE,
      ),
    ];
    for (const row of rows) {
      const event = JSON.parse(String(row.event)) as AuditEvent;
      const delivered = await auditStub(this.env, event.id)
        .append(event)
        .then(
          (result) => result.ok,
          () => false,
        );
      if (!delivered) {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
        return false;
      }
      this.ctx.storage.sql.exec(
        'DELETE FROM audit_outbox WHERE event_id = ?',
        row.event_id,
      );
    }
    // Keep scheduling while backlog remains so a quiet object eventually
    // drains after an outage.
    if (rows.length && this.pending() > 0)
      await this.ctx.storage.setAlarm(Date.now() + BACKLOG_DELAY_MS);
    return true;
  }
}
