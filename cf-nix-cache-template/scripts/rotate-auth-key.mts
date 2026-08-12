import {
  configPath,
  fail,
  keyMaterial,
  putSecrets,
  secretNames,
  secretNamesFromWrangler,
} from "./lib.mts";

const configured = await secretNamesFromWrangler(configPath);
const missing = secretNames.filter((name) => !configured.has(name));
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
