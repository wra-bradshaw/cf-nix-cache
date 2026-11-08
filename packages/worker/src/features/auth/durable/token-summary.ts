import type { Grant, TokenSummary } from '../types';
import type { SqlRow } from '../../../shared/sql';
import { text, integer, json } from '../../../shared/sql';

export const toTokenSummary = (row: SqlRow): TokenSummary => ({
  id: text(row, 'jti'),
  subject: text(row, 'subject'),
  expires_at: integer(row, 'expires_at'),
  issued_at: integer(row, 'issued_at'),
  grants: json<Grant[]>(row, 'grants'),
  revoked: integer(row, 'revoked') === 1,
});
