import { canDelegate } from '../auth';
import {
  assertIdempotencyKey,
  DomainError,
  parseJsonSchema,
  TokenRequestSchema,
} from '../domain/validation';
import type { Grant, TokenClaims } from '../../types';
import { namedStub } from '../../rpc';
import { unwrapRpc } from './errors';

export function idempotency(request: Request): string {
  return assertIdempotencyKey(request.headers.get('Idempotency-Key'));
}

export async function issueFromInput(
  env: Env,
  input: { subject: string; valid_for_seconds: number; grants: Grant[] },
  operationId: string,
  parent?: TokenClaims,
): Promise<{
  id: string;
  token: string;
  expires_at: number;
  repeated: boolean;
}> {
  const validated = parseJsonSchema(TokenRequestSchema, input);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + validated.valid_for_seconds;
  if (parent && !canDelegate(parent, validated.grants, expiresAt))
    throw new DomainError(
      'forbidden',
      'requested grants must be individually covered by an administrator grant and expire no later than the issuer',
      403,
    );
  const fingerprint = JSON.stringify(validated);
  return unwrapRpc(
    await namedStub(env.TOKEN_CATALOG, 'catalog').issue({
      operation_id: operationId,
      fingerprint,
      actor: parent?.sub ?? validated.subject,
      subject: validated.subject,
      grants: validated.grants,
      expires_at: expiresAt,
    }),
  );
}
