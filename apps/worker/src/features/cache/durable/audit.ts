import type { AuditEvent } from '../../../types';
import type { RpcResult } from '../../../rpc';
import { auditStub } from '../../audit/shard';
import { now, type SqlRow } from '../../../infrastructure/durable/shared';
import { failure } from './helpers';

export class CoordinatorAudit {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async record(event: AuditEvent): Promise<RpcResult<void>> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'INSERT OR IGNORE INTO audit_outbox (event_id, event, created_at) VALUES (?, ?, ?)',
        event.id,
        JSON.stringify(event),
        now(),
      );
    });
    this.ctx.waitUntil(this.drain());
    return { ok: true, value: undefined };
  }

  async flush(): Promise<RpcResult<void>> {
    while (true) {
      if (!(await this.drain()))
        return failure(
          'audit_unavailable',
          'audit log is unavailable; retry before removing the cache',
          503,
        );
      const pending = [
        ...this.ctx.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM audit_outbox',
        ),
      ][0];
      if (!pending || Number(pending.count) === 0)
        return { ok: true, value: undefined };
    }
  }

  async shardId(prefix: string): Promise<RpcResult<string>> {
    if (!/^[0-9a-f]{2}$/u.test(prefix))
      return failure('invalid_shard', 'invalid cache index shard', 422);
    const row = [
      ...this.ctx.storage.sql.exec<{ incarnation: string }>(
        'SELECT incarnation FROM cache LIMIT 1',
      ),
    ][0];
    return row
      ? {
          ok: true,
          value: this.env
            .CACHE_INDEX!.idFromName(`${row.incarnation}:${prefix}`)
            .toString(),
        }
      : failure('not_found', 'cache not found', 404);
  }

  async alarm(): Promise<void> {
    await this.drain();
  }

  private async drain(): Promise<boolean> {
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        'SELECT event_id, event FROM audit_outbox ORDER BY created_at LIMIT 50',
      ),
    ];
    if (!rows.length) return true;
    for (const row of rows) {
      const event = JSON.parse(String(row.event)) as AuditEvent;
      const result = await auditStub(this.env, event.id).append(event);
      if (!result.ok) {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return false;
      }
      this.ctx.storage.transactionSync(() =>
        this.ctx.storage.sql.exec(
          'DELETE FROM audit_outbox WHERE event_id = ?',
          row.event_id,
        ),
      );
    }
    const pending = [
      ...this.ctx.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM audit_outbox',
      ),
    ][0];
    if (pending && Number(pending.count) > 0)
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    return true;
  }
}
