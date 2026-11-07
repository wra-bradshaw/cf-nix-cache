import { fail } from "./lib/fail.mts";
import { keyMaterial } from "./lib/keys.mts";
import { configPath } from "./lib/paths.mts";
import {
  missingSecrets,
  putSecrets,
  secretNamesFromWrangler,
} from "./lib/secrets.mts";

const configured = await secretNamesFromWrangler(configPath);
const missing = missingSecrets(configured);
if (missing.length)
  fail(
    `cannot rotate auth keys with an incomplete secret set (missing ${missing.join(", ")})`,
  );

const auth = keyMaterial();
await putSecrets(
  {
    AUTH_PRIVATE_JWK: JSON.stringify(auth.privateJwk),
    AUTH_PUBLIC_JWKS: JSON.stringify([{ kid: "current", jwk: auth.publicJwk }]),
  },
  configPath,
);
console.log(
  "Rotated the authentication key. Existing capability tokens are invalid and must be reissued.",
);
console.log("No private key material was written to disk or printed.");
