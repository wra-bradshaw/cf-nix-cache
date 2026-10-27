import type { Grant, TokenSummary } from '../../../types';
import { type SqlRow } from '../../../infrastructure/durable/shared';

export const toTokenSummary = (row: SqlRow): TokenSummary => ({
  id: String(row.jti),
  subject: String(row.subject),
  expires_at: Number(row.expires_at),
  issued_at: Number(row.issued_at),
  grants: JSON.parse(String(row.grants)) as Grant[],
  revoked: Number(row.revoked) === 1,
});
