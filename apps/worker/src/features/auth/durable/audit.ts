import type { AuditEvent } from '../../../types';
import { auditStub } from '../../audit/shard';
import {
  first,
  now,
  type SqlRow,
} from '../../../infrastructure/durable/shared';

export class TokenAudit {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

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

  private async drain(): Promise<void> {
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        'SELECT event_id, event FROM audit_outbox ORDER BY created_at LIMIT 50',
      ),
    ];
    if (!rows.length) return;
    for (const row of rows) {
      const event = JSON.parse(String(row.event)) as AuditEvent;
      const result = await auditStub(this.env, event.id).append(event);
      if (!result.ok) {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
      this.ctx.storage.transactionSync(() =>
        this.ctx.storage.sql.exec(
          'DELETE FROM audit_outbox WHERE event_id = ?',
          row.event_id,
        ),
      );
    }

    // A recovery alarm processes one bounded batch. Keep scheduling while
    // backlog remains so a quiet catalog eventually drains after an outage.
    const pending = first(
      this.ctx.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM audit_outbox',
      ),
    );
    if (pending && Number(pending.count) > 0)
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }
}
