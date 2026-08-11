import { describe, expect, it } from 'vitest';
import { canDelegate, permitsCache, permitsGlobal } from './authorization';
import type { TokenClaims } from '../../types';

const parent: TokenClaims = {
  iss: 'issuer',
  aud: 'audience',
  sub: 'admin',
  jti: 'parent',
  iat: 100,
  exp: 200,
  grants: [
    { cache: 'team-a', role: 'admin' },
    { cache: 'team-b', role: 'admin' },
  ],
};

describe('capability authorization', () => {
  it('checks every delegated grant against a scoped parent grant', () => {
    expect(
      canDelegate(
        parent,
        [
          { cache: 'team-a', role: 'push' },
          { cache: 'team-b', role: 'pull' },
        ],
        199,
      ),
    ).toBe(true);
    expect(
      canDelegate(
        parent,
        [
          { cache: 'team-a', role: 'push' },
          { cache: 'other', role: 'pull' },
        ],
        199,
      ),
    ).toBe(false);
  });

  it('does not allow a delegated token to outlive its issuer', () => {
    expect(canDelegate(parent, [{ cache: 'team-a', role: 'pull' }], 200)).toBe(
      true,
    );
    expect(canDelegate(parent, [{ cache: 'team-a', role: 'pull' }], 201)).toBe(
      false,
    );
  });

  it('keeps pull and push permissions cache-scoped', () => {
    const claims = {
      ...parent,
      grants: [{ cache: 'team-a', role: 'push' as const }],
    };
    expect(permitsCache(claims, 'team-a', 'pull')).toBe(true);
    expect(permitsCache(claims, 'team-a', 'push')).toBe(true);
    expect(permitsCache(claims, 'team-b', 'pull')).toBe(false);
  });

  it('requires a wildcard grant for global operations', () => {
    expect(permitsGlobal(parent, 'admin')).toBe(false);
    expect(
      permitsGlobal(
        { ...parent, grants: [{ cache: '*', role: 'admin' }] },
        'admin',
      ),
    ).toBe(true);
  });
});
