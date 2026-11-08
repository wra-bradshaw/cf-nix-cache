export {};

declare global {
  interface Env {
    AUTH_PRIVATE_JWK: string;
    AUTH_PUBLIC_JWKS: string;
    NIX_PRIVATE_JWK: string;
    BOOTSTRAP_SECRET_HASH: string;
    /**
     * Overrides INLINE_VERIFY_MAX_NAR_SIZE, in bytes. Tests lower it to send
     * small NARs to the upload workflow.
     */
    INLINE_VERIFY_MAX_NAR_SIZE?: string;
  }
}
