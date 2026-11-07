import { DomainError } from './errors';

/** Nix base32 alphabet (no e, o, u, t) and a store hash written in it. */
export const NIX_BASE32 = '0123456789abcdfghijklmnpqrsvwxyz';
export const STORE_HASH_PATTERN = `[${NIX_BASE32}]{32}`;
const STORE_HASH = new RegExp(`^${STORE_HASH_PATTERN}$`);
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
  if (typeof value !== 'string' || !STORE_HASH.test(value))
    throw new DomainError('invalid_store_hash', 'invalid store hash', 422);
}
