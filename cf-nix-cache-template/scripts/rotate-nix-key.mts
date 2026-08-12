import {
  configPath,
  fail,
  keyMaterial,
  nixPublicKey,
  putSecrets,
  secretNames,
  secretNamesFromWrangler,
} from "./lib.mts";

const configured = await secretNamesFromWrangler(configPath);
const missing = secretNames.filter((name) => !configured.has(name));
if (missing.length)
  fail(
    `cannot rotate the Nix key with an incomplete secret set (missing ${missing.join(", ")})`,
  );

const nix = keyMaterial();
const publicKey = nixPublicKey("cache.nix-signing", nix.publicJwk);
await putSecrets(
  {
    NIX_PRIVATE_JWK: JSON.stringify(nix.privateJwk),
    NIX_PUBLIC_KEYS: publicKey,
  },
  configPath,
);
console.log(
  "Rotated the Nix signing key. Existing narinfo signatures will no longer verify.",
);
console.log(`Update every Nix client with: trusted-public-keys = ${publicKey}`);
console.log("No private key material was written to disk or printed.");
