import { generateKeyPairSync } from "node:crypto";

type KeyMaterial = {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey & { x: string };
};

export function keyMaterial(): KeyMaterial {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateJwk: pair.privateKey.export({ format: "jwk" }) as JsonWebKey,
    publicJwk: pair.publicKey.export({ format: "jwk" }) as JsonWebKey & {
      x: string;
    },
  };
}

export function nixPublicKey(
  name: string,
  jwk: JsonWebKey & { x: string },
): string {
  return `${name}:${Buffer.from(jwk.x, "base64url").toString("base64")}`;
}
