import type { Grant, PageResponse, TokenSummary } from '../../../types';
import type { RpcResult } from '../../../rpc';
import {
  AUDIT_OUTBOX_SCHEMA,
  AuditOutbox,
} from '../../../infrastructure/durable/audit-outbox';
import { TokenIssuance } from './issuance';
import { TokenManagement } from './management';
import { TokenSigner } from './signer';
import { RpcOnlyDurableObject } from '../../../infrastructure/durable/rpc-only';

const schema = `CREATE TABLE IF NOT EXISTS tokens (
  jti TEXT PRIMARY KEY, subject TEXT NOT NULL, expires_at INTEGER NOT NULL,
  issued_at INTEGER NOT NULL, grants TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL, operation_id TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS token_operations (operation_id TEXT PRIMARY KEY, jti TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bootstrap (key INTEGER PRIMARY KEY CHECK (key = 1), operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL);
${AUDIT_OUTBOX_SCHEMA}`;

export class TokenCatalog extends RpcOnlyDurableObject {
  private readonly issuance: TokenIssuance;
  private readonly management: TokenManagement;
  private readonly audit: AuditOutbox;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(schema);
    this.audit = new AuditOutbox(ctx, env);
    this.issuance = new TokenIssuance(
      ctx,
      env,
      new TokenSigner(env),
      this.audit,
    );
    this.management = new TokenManagement(ctx, this.audit);
  }

  bootstrap(input: {
    operation_id: string;
    fingerprint: string;
    subject: string;
    grants: Grant[];
    expires_at: number;
    secret: string;
  }): Promise<
    RpcResult<{
      id: string;
      token: string;
      expires_at: number;
      repeated: boolean;
    }>
  > {
    return this.issuance.bootstrap(input);
  }

  issue(input: {
    operation_id: string;
    fingerprint: string;
    actor: string;
    subject: string;
    grants: Grant[];
    expires_at: number;
  }): Promise<
    RpcResult<{
      id: string;
      token: string;
      expires_at: number;
      repeated: boolean;
    }>
  > {
    return this.issuance.issue(input);
  }

  check(input: {
    jti: string;
    exp: number;
  }): Promise<RpcResult<{ active: boolean }>> {
    return this.management.check(input);
  }

  revoke(input: {
    operation_id: string;
    jti: string;
    actor: string;
  }): Promise<RpcResult<void>> {
    return this.management.revoke(input);
  }

  list(input: {
    limit: number;
    cursor: string | null;
  }): Promise<RpcResult<PageResponse<TokenSummary>>> {
    return this.management.list(input);
  }

  alarm(): Promise<void> {
    return this.audit.alarm();
  }
}
