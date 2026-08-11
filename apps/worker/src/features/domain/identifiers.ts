import { DomainError } from './errors';

const NIX_BASE32 = '0123456789abcdfghijklmnpqrsvwxyz';
const NIX32 = new RegExp(`^[${NIX_BASE32}]{32}$`);
const CACHE_NAME = /^[a-z0-9_-]{1,64}$/;

export function hasControlCharacters(
  value: string,
  includeSlash = false,
): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f || (includeSlash && character === '/');
  });
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertCacheName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CACHE_NAME.test(value))
    throw new DomainError('invalid_cache', 'invalid cache name', 422);
}

export function assertOpaqueId(
  value: unknown,
  label = 'resource',
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new DomainError('invalid_id', `invalid ${label} id`, 422);
  }
}

export function assertNamespaceId(
  value: unknown,
  label = 'resource',
): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw new DomainError('invalid_id', `invalid ${label} id`, 422);
}

export function assertStoreHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !NIX32.test(value))
    throw new DomainError('invalid_store_hash', 'invalid store hash', 422);
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
