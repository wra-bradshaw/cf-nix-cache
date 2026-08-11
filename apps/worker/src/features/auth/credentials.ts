import { base64url } from 'jose';
import { AuthError } from './errors';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function tokenFromRequest(request: Request): string | undefined {
  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer '))
    return authorization.slice(7).trim();
  if (authorization?.toLowerCase().startsWith('basic ')) {
    try {
      const encoded = authorization.slice(6).trim();
      const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
      const decoded = decoder.decode(
        Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
      );
      const separator = decoded.indexOf(':');
      return separator < 0 ? decoded : decoded.slice(separator + 1);
    } catch {
      throw new AuthError('invalid_token', 'malformed basic credentials');
    }
  }
  return undefined;
}

export async function hashSecret(value: string): Promise<string> {
  return base64url.encode(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', encoder.encode(value)),
    ),
  );
}
