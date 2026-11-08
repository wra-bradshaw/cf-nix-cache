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

  /**
   * Records an event; callable inside the owner's transaction.
   *
   * Overlapping drains are safe without serialization: AuditLog.append is
   * idempotent (`INSERT OR IGNORE` keyed by event.id), and the outbox delete
   * is by event_id, so two concurrent drains that read the same batch both
   * attempt the same append and the loser is a no-op.
   */
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

  /**
   * Number of undelivered audit events.
   *
   * COUNT(*) always returns exactly one integer row in SQLite, even when the
   * table is empty, so a missing or mistyped count cannot occur in practice.
   * It is still handled defensively: an unreadable count throws
   * `audit_unavailable` (503) so callers retry rather than trusting a corrupt
   * count as drained.
   */
  pending(): number {
    const row = first(
      this.ctx.storage.sql.exec<SqlRow>(
        'SELECT COUNT(*) AS count FROM audit_outbox',
      ),
    );
    // COUNT(*) always returns exactly one row in SQLite: a missing row means
    // the count itself is unreadable, so fail closed (503) rather than
    // reporting 0 and letting removal proceed with unknown backlog.
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

  /**
   * Delivers one bounded batch. Returns false, with a retry alarm scheduled,
   * when the audit log rejects or cannot be reached.
   *
   * Auditability note: the per-row nesting below is intentional and stays
   * inline rather than split into helpers. Each row goes through three
   * fallible stages with different remediation (event_id -> delete by rowid,
   * event JSON -> delete by event_id, delivery -> retry alarm), and
   * collapsing them into one helper would hide which stage failed. Read it
   * as: validate key, validate payload, deliver, delete. `unremovableCorruptRows`
   * is the poison-pill counter for this drain, surfaced via warn so a stuck
   * row is visible instead of looping silently.
   */
  async drain(): Promise<boolean> {
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        'SELECT rowid, event_id, event FROM audit_outbox ORDER BY created_at, rowid LIMIT ?',
        BATCH_SIZE,
      ),
    ];
    // Backstop for poison pills the best-effort rowid delete cannot remove:
    // counted and warned so a perpetually re-read row is visible instead of
    // looping silently with pending() never reaching zero.
    let unremovableCorruptRows = 0;
    for (const row of rows) {
      let eventId: string;
      try {
        eventId = text(row, 'event_id');
      } catch (error) {
        // A row without a usable event_id can never be delivered or deleted
        // by key, so remove it by rowid. Without this the corrupt row is
        // re-read on every drain and pending() never reaches zero.
        // rowid itself is an SQLite-generated integer and cannot be corrupt
        // in practice; read it separately so a corrupt rowid does not mask
        // the original event_id error, and delete by best effort.
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
          // Best effort: the raw rowid may still address the row even when
          // integer() rejects it.
          const raw = (row as Record<string, unknown>)['rowid'];
          if (typeof raw === 'number' || typeof raw === 'string') {
            try {
              const deleted = this.ctx.storage.sql.exec(
                'DELETE FROM audit_outbox WHERE rowid = ?',
                raw,
              );
              // A best-effort delete may miss (wrong type, already moved).
              // rowsWritten is the real cursor in workerd; the node test
              // fake returns a bare array, so only treat an explicit zero
              // as a miss.
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
            // No usable rowid to delete by: the row will be re-read on every
            // drain. Count it so the poison pill surfaces in logs/metrics
            // instead of looping silently.
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
      // Shape validation (e.g. metadata values are strings) happens at
      // AuditLog.list, which fails the page closed so tampering stays
      // visible. The outbox preserves the bytes for delivery and only drops
      // rows that are not valid JSON, rather than second-guessing the shape
      // here and silently discarding history.
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
          // The corrupt row survives: schedule a retry and report
          // unavailable so flushAudit maps to `audit_unavailable` 503
          // instead of treating the backlog as drained.
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
        // The event was delivered but its outbox row survives; without a
        // retry the backlog alarm would stop while pending() stays > 0.
        // Delivery is idempotent (append is INSERT OR IGNORE), so reporting
        // unavailable and retrying the delete is safe.
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
    // Keep scheduling while backlog remains so a quiet object eventually
    // drains after an outage. An unreadable backlog count reads as
    // unavailable (retry) rather than drained.
    // An unremovable row can never be deleted by key or rowid, so pending()
    // would never reach zero: report unavailable instead of returning true
    // with the backlog alarm spinning. This bounds flushAudit's retry loop
    // and surfaces the poison pill instead of looping silently.
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
