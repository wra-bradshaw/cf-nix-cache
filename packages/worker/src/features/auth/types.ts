import type {
  Grant as GeneratedGrant,
  ResponseTokenSummary,
  Role as GeneratedRole,
} from '../../generated/contracts';

export type Role = GeneratedRole;

export type Grant = GeneratedGrant;

export interface TokenClaims {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  nbf?: number;
  exp: number;
  grants: Grant[];
}

export type TokenSummary = ResponseTokenSummary;
