import { DomainError } from './errors';

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

export function assertIdempotencyKey(value: string | null): string {
  if (
    !value ||
    value.length > 128 ||
    ![...value].every(
      (character) =>
        character.codePointAt(0)! >= 0x21 && character.codePointAt(0)! <= 0x7e,
    )
  ) {
    throw new DomainError(
      'idempotency_key_required',
      'a valid Idempotency-Key is required',
      400,
    );
  }
  return value;
}

export function idempotency(request: Request): string {
  return assertIdempotencyKey(request.headers.get('Idempotency-Key'));
}

export function parseContentLength(request: Request): number {
  const value = request.headers.get('content-length');
  const length = value === null ? NaN : Number(value);
  if (!Number.isSafeInteger(length) || length < 0)
    throw new DomainError(
      'length_required',
      'upload parts require a valid Content-Length header',
      411,
    );
  return length;
}

export function pageLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
}
