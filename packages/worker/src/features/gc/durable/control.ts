import type { GcSummary } from '../model';
import type { RpcResult } from '../../../rpc';
import type { AuditEvent } from '../../../types';
import {
  AUDIT_OUTBOX_SCHEMA,
  AuditOutbox,
} from '../../../infrastructure/durable/audit-outbox';
import { now, ok } from '../../../infrastructure/durable/shared';
import { RpcOnlyDurableObject } from '../../../infrastructure/durable/rpc-only';
import { GcLedger } from './ledger';

/** The installation-wide authority for garbage collection and upload leases. */
export class GcControl extends RpcOnlyDurableObject {
  private readonly ledger: GcLedger;
  private readonly audit: AuditOutbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(AUDIT_OUTBOX_SCHEMA);
    this.ledger = new GcLedger(ctx.storage.sql, (body) =>
      ctx.storage.transactionSync(body),
    );
    this.audit = new AuditOutbox(ctx, env);
  }

  async alarm(): Promise<void> {
    await this.audit.alarm();
  }

  async recordAudit(event: AuditEvent): Promise<RpcResult<void>> {
    this.audit.enqueue(event);
    return ok();
  }

  async begin(input: { run_id: string; dry_run: boolean }) {
    return this.ledger.begin({ ...input, now: now() });
  }

  async addMarks(input: { run_id: string; keys: string[] }) {
    return this.ledger.addMarks({ ...input, now: now() });
  }

  async pendingManifests(input: { run_id: string; limit: number }) {
    return this.ledger.pendingManifests({ ...input, now: now() });
  }

  async expand(input: {
    run_id: string;
    manifests: { key: string; chunk_keys: string[] }[];
  }) {
    return this.ledger.expand({ ...input, now: now() });
  }

  async addCandidates(input: {
    run_id: string;
    objects: { key: string; size: number }[];
  }) {
    return this.ledger.addCandidates({ ...input, now: now() });
  }

  async candidateTotals(input: { run_id: string }) {
    return this.ledger.candidateTotals({ ...input, now: now() });
  }

  async closeGate(input: { run_id: string }) {
    return this.ledger.closeGate({ ...input, now: now() });
  }

  async nextDeletions(input: { run_id: string; limit: number }) {
    return this.ledger.nextDeletions({ ...input, now: now() });
  }

  async markDeleted(input: { run_id: string; keys: string[] }) {
    return this.ledger.markDeleted({ ...input, now: now() });
  }

  async finish(summary: GcSummary) {
    return this.ledger.finish(summary);
  }

  /** The token is empty while the upload gate is closed. */
  async acquireLease(input: {
    job_id: string;
  }): Promise<RpcResult<{ token: string | null }>> {
    const token = crypto.randomUUID();
    const lease = this.ledger.acquireLease({ ...input, token, now: now() });
    if (!lease.ok) return lease;
    return ok({ token: lease.value.granted ? token : null });
  }

  async prepublish(input: {
    job_id: string;
    token: string;
    manifest_key: string;
  }) {
    return this.ledger.prepublish({ ...input, now: now() });
  }

  async releaseLease(input: { job_id: string; token: string }) {
    return this.ledger.releaseLease(input);
  }

  async status() {
    return ok(this.ledger.status(now()));
  }
}
