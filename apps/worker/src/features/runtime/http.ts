import { assertIdempotencyKey, DomainError } from '../domain/validation';

export type AppEnv = { Bindings: Env; Variables: { requestId: string } };

export async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new DomainError(
      'validation_failed',
      'request body must be valid JSON',
      400,
    );
  }
}

export function idempotency(request: Request): string {
  return assertIdempotencyKey(request.headers.get('Idempotency-Key'));
}
