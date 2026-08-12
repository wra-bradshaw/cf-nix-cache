import {
  bucketName,
  bootstrapCommand,
  configPath,
  ensureBucket,
  ensureLifecycle,
  fail,
  healthCheck,
  hashSecret,
  installedPackageVersion,
  keyMaterial,
  lifecycleIsConfigured,
  nixPublicKey,
  putSecrets,
  processorContainers,
  readConfig,
  releaseImage,
  secretNames,
  secretNamesFromWrangler,
  withRenderedConfig,
  workerUrl,
  wrangler,
  type TemplateConfig,
} from "./lib.mts";

const action = process.argv[2] ?? "deploy";

function missing(names: Set<string>): string[] {
  return secretNames.filter((name) => !names.has(name));
}

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

function secretState(names: Set<string>): "none" | "complete" | "partial" {
  const count = secretNames.filter((name) => names.has(name)).length;
  return count === 0
    ? "none"
    : count === secretNames.length
      ? "complete"
      : "partial";
}

async function deployWorker(
  config: TemplateConfig,
  image: string,
): Promise<string> {
  return withRenderedConfig(image, async (rendered) => {
    const output = await wrangler(["deploy"], {}, rendered);
    return workerUrl(config, `${output.stdout}\n${output.stderr}`) ?? "";
  });
}

async function configureSecrets(config: TemplateConfig): Promise<{
  publicKey: string;
  url: string;
}> {
  const names = await secretNamesFromWrangler(configPath);
  const state = secretState(names);
  if (state === "partial") {
    fail(
      `partial Wrangler secret set detected (missing: ${missing(names).join(", ")}). Refusing to regenerate keys; restore the missing secrets or run an explicit key rotation.`,
    );
  }

  let publicKey = "";
  if (state === "none") {
    const bootstrapSecret = requireBootstrapSecret();
    const auth = keyMaterial();
    const nix = keyMaterial();
    publicKey = nixPublicKey("cache.nix-signing", nix.publicJwk);
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
      configPath,
    );
    console.log(
      "Installed the initial Worker secret set. Private key material was kept in memory only.",
    );
  }

  // Secret values cannot be read back from Wrangler. The public key is printed
  // on first setup and remains available at /api/public-key thereafter.
  const url =
    workerUrl(config) ??
    fail("could not determine the workers.dev URL; set CF_NIX_CACHE_URL");
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
  const existingSecrets = await secretNamesFromWrangler(configPath);
  if (secretState(existingSecrets) === "partial") {
    fail(
      `partial Wrangler secret set detected (missing: ${missing(existingSecrets).join(", ")}). Refusing to deploy until the missing secrets are restored or an explicit key rotation is performed.`,
    );
  }
  const bucket = bucketName(config);
  await ensureBucket(bucket, configPath);
  await ensureLifecycle(bucket);

  // A first deploy creates the Worker, Durable Objects, Workflows, and
  // Container binding before the bulk secret operation targets the Worker.
  const initialUrl = await deployWorker(config, image);
  const configured = await configureSecrets(config);
  const url = configured.url || initialUrl;
  await deployWorker(config, image);
  await healthCheck(url);

  const publicKey =
    configured.publicKey || "(fetch /api/public-key after propagation)";
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

async function deploy(): Promise<void> {
  // setup is deliberately idempotent. It performs no key generation when the
  // complete secret set already exists, which makes this command safe for
  // Workers Builds and every external CI runner.
  await setup();
}

async function preview(): Promise<void> {
  const config = await readConfig();
  const { image } = await releaseImage();
  await withRenderedConfig(image, async (rendered) => {
    await wrangler(["versions", "upload"], {}, rendered);
  });
  console.log(
    "Uploaded a Worker version for preview; production Container state was not changed.",
  );
}

async function doctor(): Promise<void> {
  const config = await readConfig();
  const { manifest, image } = await releaseImage();
  const findings: string[] = [];
  if ((await installedPackageVersion()) !== manifest.version)
    findings.push(
      "installed Worker package and release manifest versions differ",
    );
  try {
    const names = await secretNamesFromWrangler(configPath);
    const state = secretState(names);
    if (state === "partial")
      findings.push(
        `partial secret set (missing ${missing(names).join(", ")})`,
      );
    if (state === "none")
      findings.push("required Worker secrets are not installed");
  } catch (error) {
    findings.push(
      error instanceof Error
        ? error.message
        : "could not inspect Worker secrets",
    );
  }

  try {
    const bucket = bucketName(config);
    const listed = await wrangler(
      ["r2", "bucket", "list"],
      { allowFailure: true, quiet: true },
      configPath,
    );
    if (listed.status !== 0 || !listed.stdout.includes(bucket))
      findings.push(
        `R2 bucket ${bucket} was not found (or Wrangler returned non-JSON output)`,
      );
    const lifecycle = await lifecycleIsConfigured(bucket);
    if (lifecycle === false)
      findings.push("R2 staging/multipart lifecycle rules are missing");
    if (lifecycle === undefined)
      findings.push(
        "cannot verify R2 lifecycle rules; check Wrangler authentication",
      );
  } catch (error) {
    findings.push(
      error instanceof Error ? error.message : "could not inspect R2",
    );
  }

  const containerStatus = await wrangler(
    ["containers", "list"],
    { allowFailure: true, quiet: true },
    configPath,
  );
  if (containerStatus.status !== 0)
    findings.push(
      "could not inspect Container status (deploy once, then check Wrangler credentials and Container rollout)",
    );

  const containers = processorContainers(config);
  if (containers.length < 1)
    findings.push("ProcessorContainer binding is missing");
  if (config.observability?.enabled !== true)
    findings.push("observability.enabled should be true");
  if (config.vars?.CF_NIX_CACHE_CONFIG_SCHEMA !== "1")
    findings.push("CF_NIX_CACHE_CONFIG_SCHEMA must be 1");
  if (
    image !== manifest.processorImage &&
    !process.env.CF_NIX_CACHE_PROCESSOR_IMAGE
  )
    findings.push("rendered image does not match the package release manifest");
  if (manifest.platform !== "linux/amd64")
    findings.push("processor platform is not linux/amd64");

  if (findings.length) {
    console.error("doctor found issues:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `doctor: ${config.name} is compatible with cf-nix-cache@${manifest.version}`,
  );
  console.log(`doctor: processor ${image}`);
  console.log(
    "doctor: secrets, R2 binding, Container binding, lifecycle configuration, and schema checks passed",
  );
}

switch (action) {
  case "setup":
    await setup();
    break;
  case "deploy":
    await deploy();
    break;
  case "doctor":
    await doctor();
    break;
  case "preview":
    await preview();
    break;
  default:
    fail(`unknown action ${action}; use setup, deploy, or doctor`);
}
