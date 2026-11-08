import type { AuditEvent } from './types';
import { auditStub } from './shard';
import { first, type SqlRow, integer, json, text } from '../../shared/sql';
import { now } from '../../shared/clock';
import { DomainError } from '../../shared/errors';

export const AUDIT_OUTBOX_SCHEMA =
  'CREATE TABLE IF NOT EXISTS audit_outbox (event_id TEXT PRIMARY KEY, event TEXT NOT NULL, created_at INTEGER NOT NULL);';

const BATCH_SIZE = 50;
const RETRY_DELAY_MS = 30_000;
const BACKLOG_DELAY_MS = 1_000;

export class AuditOutbox {
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

  pending(): number {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT COUNT(*) AS count FROM audit_outbox',
      ),
    );
    if (!row)
      throw new DomainError(
        'audit_unavailable',
        'audit outbox is unavailable',
        503,
      );
    try {
      return integer(row, 'count');
    } catch (error) {
      throw new DomainError(
        'audit_unavailable',
        'audit outbox is unavailable',
        503,
      );
    }
  }

  async drain(): Promise<boolean> {
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        'SELECT rowid, event_id, event FROM audit_outbox ORDER BY created_at, rowid LIMIT ?',
        BATCH_SIZE,
      ),
    ];
    let unremovableCorruptRows = 0;
    for (const row of rows) {
      let eventId: string;
      try {
        eventId = text(row, 'event_id');
      } catch (error) {
        let rowid: number | undefined;
        try {
          rowid = integer(row, 'rowid');
        } catch (rowidError) {
          console.error({
            message: 'dropping audit outbox row with corrupt rowid',
            error: error instanceof Error ? error.message : error,
            rowid_error:
              rowidError instanceof Error
                ? rowidError.message
                : rowidError,
          });
          const raw = (row as Record<string, unknown>)['rowid'];
          if (typeof raw === 'number' || typeof raw === 'string') {
            try {
              const deleted = this.ctx.storage.sql.exec(
                'DELETE FROM audit_outbox WHERE rowid = ?',
                raw,
              );
              const written = (deleted as unknown as { rowsWritten?: unknown })
                .rowsWritten;
              if (typeof written === 'number' && written === 0) {
                unremovableCorruptRows += 1;
                console.warn({
                  message:
                    'audit outbox best-effort rowid delete missed corrupt row',
                  error: error instanceof Error ? error.message : error,
                  unremovable: unremovableCorruptRows,
                });
              }
            } catch (deleteError) {
              unremovableCorruptRows += 1;
              console.error({
                message:
                  'dropping audit outbox row with corrupt event_id',
                error: error instanceof Error ? error.message : error,
                delete_error:
                  deleteError instanceof Error
                    ? deleteError.message
                    : deleteError,
                unremovable: unremovableCorruptRows,
              });
            }
          } else {
            unremovableCorruptRows += 1;
            console.warn({
              message: 'audit outbox has unremovable corrupt row',
              error: error instanceof Error ? error.message : error,
              unremovable: unremovableCorruptRows,
            });
          }
          continue;
        }
        try {
          this.ctx.storage.sql.exec(
            'DELETE FROM audit_outbox WHERE rowid = ?',
            rowid,
          );
        } catch (deleteError) {
          unremovableCorruptRows += 1;
          console.error({
            message: 'dropping audit outbox row with corrupt event_id',
            error: error instanceof Error ? error.message : error,
            delete_error:
              deleteError instanceof Error ? deleteError.message : deleteError,
            unremovable: unremovableCorruptRows,
          });
          continue;
        }
        console.error({
          message: 'dropping audit outbox row with corrupt event_id',
          error: error instanceof Error ? error.message : error,
        });
        continue;
      }
      let event: AuditEvent;
      try {
        event = json<AuditEvent>(row, 'event');
      } catch (error) {
        console.error({
          event_id: eventId,
          message: 'dropping corrupt audit outbox event',
          error: error instanceof Error ? error.message : error,
        });
        try {
          this.ctx.storage.sql.exec(
            'DELETE FROM audit_outbox WHERE event_id = ?',
            eventId,
          );
        } catch (deleteError) {
          await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
          console.error({
            event_id: eventId,
            message: 'audit outbox delete of corrupt event failed',
            error: error instanceof Error ? error.message : error,
            delete_error:
              deleteError instanceof Error
                ? deleteError.message
                : deleteError,
          });
          return false;
        }
        continue;
      }
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
      try {
        this.ctx.storage.sql.exec(
          'DELETE FROM audit_outbox WHERE event_id = ?',
          eventId,
        );
      } catch (deleteError) {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
        console.error({
          event_id: eventId,
          message: 'audit outbox delete after delivery failed',
          delete_error:
            deleteError instanceof Error ? deleteError.message : deleteError,
        });
        return false;
      }
    }
    if (unremovableCorruptRows > 0) {
      console.warn({
        message: 'audit outbox left unremovable corrupt rows',
        unremovable: unremovableCorruptRows,
      });
      await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
      return false;
    }
    if (rows.length) {
      let backlog: boolean;
      try {
        backlog = this.pending() > 0;
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
        return false;
      }
      if (backlog)
        await this.ctx.storage.setAlarm(Date.now() + BACKLOG_DELAY_MS);
    }
    return true;
  }
}
