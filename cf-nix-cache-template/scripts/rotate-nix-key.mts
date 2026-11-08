import { readConfig, signingKeyName } from "./lib/config.mts";
import { fail } from "./lib/fail.mts";
import { keyMaterial, nixPublicKey } from "./lib/keys.mts";
import {
  missingSecrets,
  putSecrets,
  secretNamesFromWrangler,
} from "./lib/secrets.mts";

const configured = await secretNamesFromWrangler();
const missing = missingSecrets(configured);
if (missing.length)
  fail(
    `cannot rotate the Nix key with an incomplete secret set (missing ${missing.join(", ")})`,
  );

const nix = keyMaterial();
const publicKey = nixPublicKey(signingKeyName(await readConfig()), nix.publicJwk);
await putSecrets({
  NIX_PRIVATE_JWK: JSON.stringify(nix.privateJwk),
  NIX_PUBLIC_KEYS: publicKey,
});
console.log(
  "Rotated the Nix signing key. Existing narinfo signatures will no longer verify.",
);
console.log(`Update every Nix client with: trusted-public-keys = ${publicKey}`);
console.log("No private key material was written to disk or printed.");
