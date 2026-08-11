import type { Grant, TokenSummary } from '../../../types';
import type { RpcResult } from '../../../rpc';
import type { SqlRow } from '../../../infrastructure/durable/shared';

export const failure = (
  code: string,
  message: string,
  status: number,
): RpcResult<never> => ({ ok: false, error: { code, message, status } });

export const toTokenSummary = (row: SqlRow): TokenSummary => ({
  id: String(row.jti),
  subject: String(row.subject),
  expires_at: Number(row.expires_at),
  issued_at: Number(row.issued_at),
  grants: JSON.parse(String(row.grants)) as Grant[],
  revoked: Number(row.revoked) === 1,
});
