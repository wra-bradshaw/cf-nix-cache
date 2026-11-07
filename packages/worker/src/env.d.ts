export {};

declare global {
  interface Env {
    AUTH_PRIVATE_JWK: string;
    AUTH_PUBLIC_JWKS: string;
    NIX_PRIVATE_JWK: string;
    BOOTSTRAP_SECRET_HASH: string;
  }
}
