import { doctor } from "./doctor.mts";
import {
  readConfig,
  signingKeyName,
  withRenderedConfig,
} from "./lib/config.mts";
import { fail } from "./lib/fail.mts";
import { keyMaterial, nixPublicKey } from "./lib/keys.mts";
import { bucketName, ensureBucket, ensureLifecycle } from "./lib/r2.mts";
import { releaseImage } from "./lib/release.mts";
import {
  hashSecret,
  missingSecrets,
  putSecrets,
  secretNamesFromWrangler,
  secretState,
} from "./lib/secrets.mts";
import {
  bootstrapCommand,
  healthCheck,
  workerUrl,
} from "./lib/worker-endpoint.mts";
import { wrangler } from "./lib/wrangler.mts";
import { preview } from "./preview.mts";

const action = process.argv[2] ?? "deploy";

function requireBootstrapSecret(): string {
  const secret = process.env.CF_NIX_CACHE_BOOTSTRAP_SECRET;
  if (!secret) {
    fail(
      "CF_NIX_CACHE_BOOTSTRAP_SECRET is required for the first deployment; set it as a Deploy-button/Workers Builds secret",
    );
  }
  if (secret.length < 32)
    fail("CF_NIX_CACHE_BOOTSTRAP_SECRET must contain at least 32 characters");
  return secret;
}

async function deployWorker(rendered: string): Promise<string | undefined> {
  const output = await wrangler(["deploy"], {}, rendered);
  return workerUrl(`${output.stdout}\n${output.stderr}`);
}

async function configureSecrets(
  state: "none" | "complete",
  initialUrl: string | undefined,
  rendered: string,
  keyName: string,
): Promise<{
  publicKey: string;
  url: string;
}> {
  // Resolve the URL before generating keys so that a missing URL cannot leave
  // a freshly installed key set whose public key was never printed.
  const url =
    initialUrl ??
    fail("could not determine the workers.dev URL; set CF_NIX_CACHE_URL");

  let publicKey = "";
  if (state === "none") {
    const bootstrapSecret = requireBootstrapSecret();
    const auth = keyMaterial();
    const nix = keyMaterial();
    publicKey = nixPublicKey(keyName, nix.publicJwk);
    await putSecrets(
      {
        AUTH_PRIVATE_JWK: JSON.stringify(auth.privateJwk),
        AUTH_PUBLIC_JWKS: JSON.stringify([
          { kid: "current", jwk: auth.publicJwk },
        ]),
        NIX_PRIVATE_JWK: JSON.stringify(nix.privateJwk),
        NIX_PUBLIC_KEYS: publicKey,
        BOOTSTRAP_SECRET_HASH: hashSecret(bootstrapSecret),
      },
      rendered,
    );
    console.log(
      "Installed the initial Worker secret set. Private key material was kept in memory only.",
    );
  }

  // Secret values cannot be read back from Wrangler. The public key is printed
  // on first setup and remains available at /api/public-key thereafter.
  if (!publicKey) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/api/public-key`);
      if (response.ok) publicKey = (await response.text()).trim();
    } catch {
      // A deployment may still be propagating. doctor can verify it later.
    }
  }
  return { publicKey, url };
}

async function setup(): Promise<void> {
  const config = await readConfig();
  const { image } = await releaseImage();
  const { url, publicKey: installedPublicKey } = await withRenderedConfig(
    image,
    async (rendered) => {
      // This is the only point where a missing Worker may be read as "no
      // secrets": the Worker has not been deployed yet. Every other Wrangler
      // failure aborts instead of regenerating keys.
      const existingSecrets = await secretNamesFromWrangler(rendered, {
        allowMissingWorker: true,
      });
      const state = secretState(existingSecrets);
      if (state === "partial") {
        fail(
          `partial Wrangler secret set detected (missing: ${missingSecrets(existingSecrets).join(", ")}). Refusing to deploy until the missing secrets are restored or an explicit key rotation is performed.`,
        );
      }
      // Checked before anything is created, so that a first run without the
      // secret can't leave a live Worker that has no secrets.
      if (state === "none") requireBootstrapSecret();
      const bucket = bucketName(config);
      await ensureBucket(bucket, rendered);
      await ensureLifecycle(bucket, rendered);

      // A first deploy creates the Worker, Durable Objects, Workflows, and
      // Container binding before the bulk secret operation targets the Worker.
      const initialUrl = await deployWorker(rendered);
      const configured = await configureSecrets(
        state,
        initialUrl,
        rendered,
        signingKeyName(config),
      );
      // Only a first deploy has just installed secrets to start up with.
      if (state === "none") await deployWorker(rendered);
      return configured;
    },
  );
  await healthCheck(url);

  const publicKey =
    installedPublicKey || "(fetch /api/public-key after propagation)";
  console.log(`\ncf-nix-cache is ready at ${url}`);
  console.log(`Nix public key: ${publicKey}`);
  console.log(
    "\nMint the first admin token (the bootstrap secret is read from the environment):",
  );
  console.log(bootstrapCommand(url));
  console.log("\nNix configuration:");
  console.log(`substituters = ${url}/cache/<cache-name>`);
  console.log(`trusted-public-keys = ${publicKey}`);
}

switch (action) {
  case "setup":
  case "deploy":
    // setup is deliberately idempotent. It performs no key generation when the
    // complete secret set already exists, which makes this command safe for
    // Workers Builds and every external CI runner.
    await setup();
    break;
  case "doctor":
    await doctor();
    break;
  case "preview":
    await preview();
    break;
  default:
    fail(`unknown action ${action}; use setup, deploy, preview, or doctor`);
}
