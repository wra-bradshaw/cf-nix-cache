import { base64url } from 'jose';
import { DomainError } from './errors';

export function encodeCursor(value: unknown): string {
  return base64url.encode(JSON.stringify(value));
}

export function decodeCursor<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64url.decode(value))) as T;
  } catch {
    throw new DomainError('invalid_cursor', 'invalid pagination cursor', 400);
  }
}
