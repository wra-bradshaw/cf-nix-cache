import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

export const templateDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const configPath = path.join(templateDirectory, "wrangler.jsonc");
// Rendered configs are written beside wrangler.jsonc; keep in sync with
// .gitignore.
const renderedConfigPrefix = ".wrangler-rendered-";

export const secretNames = [
  "AUTH_PRIVATE_JWK",
  "AUTH_PUBLIC_JWKS",
  "NIX_PRIVATE_JWK",
  "NIX_PUBLIC_KEYS",
  "BOOTSTRAP_SECRET_HASH",
] as const;

type Container = {
  class_name?: string;
  scheduling_policy?: string;
  images?: {
    processor?: {
      dockerfile?: string;
      build_vars?: Record<string, string>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type TemplateConfig = {
  name?: string;
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  containers?: Container[];
  env?: Record<string, { containers?: Container[] }>;
  durable_objects?: {
    bindings?: Array<{ name?: string; class_name?: string }>;
  };
  workflows?: Array<{ name?: string; binding?: string; class_name?: string }>;
  observability?: { enabled?: boolean };
  vars?: Record<string, string>;
  [key: string]: unknown;
};

export type ReleaseManifest = {
  schemaVersion: number;
  version: string;
  processorImage: string;
  platform: string;
};

export type KeyMaterial = {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey & { x: string };
};

export type CommandResult = { status: number; stdout: string; stderr: string };

export function fail(message: string): never {
  throw new Error(message);
}

function parseJsonc(source: string): unknown {
  // The template config intentionally uses JSON-compatible values. This
  // small scanner handles comments and trailing commas without introducing a
  // runtime dependency into the customer repository.
  let output = "";
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }
  return JSON.parse(output.replace(/,\s*([}\]])/g, "$1")) as unknown;
}

export async function command(
  executable: string,
  args: string[],
  options: { input?: string; allowFailure?: boolean; quiet?: boolean } = {},
): Promise<CommandResult> {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: templateDirectory,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!options.quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({ status: status ?? 1, stdout, stderr }),
    );
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
  return result;
}

export function wranglerArgs(args: string[], config = configPath): string[] {
  return [...args, "--config", config];
}

export function wrangler(
  args: string[],
  options: { input?: string; allowFailure?: boolean; quiet?: boolean } = {},
  config = configPath,
): Promise<CommandResult> {
  return command("wrangler", wranglerArgs(args, config), options);
}

export async function readConfig(): Promise<TemplateConfig> {
  const source = await readFile(configPath, "utf8");
  try {
    return parseJsonc(source) as TemplateConfig;
  } catch {
    fail(`could not parse ${configPath}`);
  }
}

export async function readReleaseManifest(): Promise<ReleaseManifest> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("cf-nix-cache/release-manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as ReleaseManifest;
  if (manifest.schemaVersion !== 1)
    fail(`unsupported release manifest schema ${manifest.schemaVersion}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))
    fail(`invalid package version in release manifest: ${manifest.version}`);
  return manifest;
}

export async function installedPackageVersion(): Promise<string> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("cf-nix-cache");
  const packagePath = path.resolve(path.dirname(entry), "..", "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    version?: string;
  };
  return packageJson.version ?? fail("installed Worker package has no version");
}

export function validateImageReference(image: string): void {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    fail(
      `processor image must be immutable (expected a digest ending in @sha256:<64 hex characters>): ${image}`,
    );
  }
}

export async function releaseImage(): Promise<{
  manifest: ReleaseManifest;
  image: string;
}> {
  const manifest = await readReleaseManifest();
  validateImageReference(manifest.processorImage);
  if (manifest.platform !== "linux/amd64")
    fail(
      `processor release platform must be linux/amd64, got ${manifest.platform}`,
    );
  const image =
    process.env.CF_NIX_CACHE_PROCESSOR_IMAGE ?? manifest.processorImage;
  validateImageReference(image);
  return { manifest, image };
}

export function processorContainers(config: TemplateConfig): Container[] {
  const values: Container[] = [];
  if (config.containers) values.push(...config.containers);
  for (const environment of Object.values(config.env ?? {})) {
    if (environment.containers) values.push(...environment.containers);
  }
  return values.filter(
    (container) => container.class_name === "ProcessorContainer",
  );
}

export function validateConfig(config: TemplateConfig, image: string): void {
  if (!config.name) fail("wrangler.jsonc must define a Worker name");
  const buckets = config.r2_buckets ?? [];
  const cacheBucket = buckets.find(
    (bucket) => bucket.binding === "CACHE_BUCKET",
  );
  if (!cacheBucket?.bucket_name)
    fail("wrangler.jsonc must define CACHE_BUCKET with a bucket_name");
  const containers = processorContainers(config);
  if (containers.length < 1)
    fail("wrangler.jsonc must define at least one ProcessorContainer");
  for (const container of containers) {
    if (container.scheduling_policy !== "durable_object")
      fail('ProcessorContainer must use "scheduling_policy": "durable_object"');
    if (!container.images?.processor?.dockerfile)
      fail(
        "ProcessorContainer must build images.processor from a dockerfile (./Dockerfile)",
      );
  }
  // The source config may retain the last release image. It is rendered into
  // a temporary config for every deploy, so only the rendered value matters.
  validateImageReference(image);
  const durableNames = new Set(
    (config.durable_objects?.bindings ?? []).map((binding) => binding.name),
  );
  for (const required of [
    "SYSTEM_CONTROL",
    "TOKEN_CATALOG",
    "AUDIT_LOG",
    "CACHE_COORDINATOR",
    "CACHE_INDEX",
    "UPLOAD_JOB",
    "PROCESSOR",
  ]) {
    if (!durableNames.has(required))
      fail(`missing Durable Object binding ${required}`);
  }
  if ((config.workflows ?? []).length < 2)
    fail(
      "wrangler.jsonc must define process-upload and delete-cache workflows",
    );
}

export async function renderedConfig(image: string): Promise<string> {
  const config = await readConfig();
  validateConfig(config, image);
  // ./Dockerfile takes the processor image as its PROCESSOR_IMAGE build
  // argument; Wrangler builds it and pushes it to the account's registry.
  for (const container of processorContainers(config)) {
    const processor = container.images?.processor;
    if (processor)
      processor.build_vars = {
        ...processor.build_vars,
        PROCESSOR_IMAGE: image,
      };
  }
  // The rendered file sits beside wrangler.jsonc so that every relative path
  // in the customer config (main, $schema, assets, rules, tsconfig) resolves
  // exactly as it does for the source config.
  const output = path.join(
    templateDirectory,
    `${renderedConfigPrefix}${process.pid}-${randomUUID()}.json`,
  );
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return output;
}

export async function withRenderedConfig<T>(
  image: string,
  operation: (config: string) => Promise<T>,
): Promise<T> {
  const rendered = await renderedConfig(image);
  try {
    return await operation(rendered);
  } finally {
    await rm(rendered, { force: true });
  }
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

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

// Wrangler reports a missing script as `Worker "<name>" not found.`; older
// releases surface the raw API error code 10007 instead.
const workerNotFound =
  /Worker "[^"]+"(?: \(env: [^)]+\))? not found\.|\[code: 10007\]/;

export async function secretNamesFromWrangler(
  config: string,
  options: { allowMissingWorker?: boolean } = {},
): Promise<Set<string>> {
  const result = await wrangler(
    ["secret", "list", "--format", "json"],
    {
      allowFailure: true,
      quiet: true,
    },
    config,
  );
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    // Only an explicit "Worker not found" before the first deployment means
    // that no secrets exist. Any other failure (authentication, network, API)
    // must never be mistaken for an empty set, which would regenerate keys.
    if (options.allowMissingWorker && workerNotFound.test(output))
      return new Set();
    process.stderr.write(output);
    fail(
      `wrangler secret list failed with exit code ${result.status}; refusing to continue without a reliable secret inventory`,
    );
  }
  try {
    const parsed = JSON.parse(result.stdout) as
      Array<{ name?: string }> | { secrets?: Array<{ name?: string }> };
    const entries = Array.isArray(parsed) ? parsed : (parsed.secrets ?? []);
    return new Set(
      entries
        .map((entry) => entry.name)
        .filter((name): name is string => Boolean(name)),
    );
  } catch {
    fail("Wrangler returned an unreadable secret list");
  }
}

export async function putSecrets(
  secrets: Record<string, string>,
  config: string,
): Promise<void> {
  // Values are sent through stdin in one bulk operation. They never appear in
  // argv, the repository, a temporary file, or the command log.
  await wrangler(
    ["secret", "bulk"],
    {
      input: `${JSON.stringify(secrets)}\n`,
    },
    config,
  );
}

export function bucketName(config: TemplateConfig): string {
  const bucket = (config.r2_buckets ?? []).find(
    (entry) => entry.binding === "CACHE_BUCKET",
  )?.bucket_name;
  return bucket ?? fail("CACHE_BUCKET is not configured");
}

// `wrangler r2 bucket list` has no JSON output. Each bucket is printed as a
// labelled block containing the line `name:  <bucket>`, so match that line
// exactly instead of searching for a substring of some other bucket's name.
export function bucketListed(output: string, name: string): boolean {
  return stripVTControlCharacters(output)
    .split(/\r?\n/)
    .some((line) => /^\s*name:\s+(\S+)\s*$/.exec(line)?.[1] === name);
}

export async function bucketExists(
  name: string,
  config: string,
): Promise<boolean> {
  const listed = await wrangler(
    ["r2", "bucket", "list"],
    { quiet: true },
    config,
  );
  return bucketListed(listed.stdout, name);
}

export async function ensureBucket(
  name: string,
  config: string,
): Promise<void> {
  if (await bucketExists(name, config)) return;
  const created = await wrangler(
    ["r2", "bucket", "create", name],
    { allowFailure: true },
    config,
  );
  // Tolerate a concurrent creation of the same bucket by this account.
  if (
    created.status !== 0 &&
    !/already exists/i.test(`${created.stdout}\n${created.stderr}`)
  )
    fail(`could not create R2 bucket ${name}`);
}

export async function ensureLifecycle(
  bucket: string,
  config: string,
): Promise<void> {
  const listed = await wrangler(
    ["r2", "bucket", "lifecycle", "list", bucket],
    { quiet: true },
    config,
  );
  const output = `${listed.stdout}\n${listed.stderr}`;
  if (!output.includes("abandoned-staging"))
    await wrangler(
      [
        "r2",
        "bucket",
        "lifecycle",
        "add",
        bucket,
        "abandoned-staging",
        "staging/",
        "--expire-days",
        "1",
        "--force",
      ],
      {},
      config,
    );
  if (!output.includes("abort-multipart"))
    await wrangler(
      [
        "r2",
        "bucket",
        "lifecycle",
        "add",
        bucket,
        "abort-multipart",
        "",
        "--abort-multipart-days",
        "1",
        "--force",
      ],
      {},
      config,
    );
}

export async function lifecycleIsConfigured(
  bucket: string,
  config: string,
): Promise<boolean | undefined> {
  const listed = await wrangler(
    ["r2", "bucket", "lifecycle", "list", bucket],
    { allowFailure: true, quiet: true },
    config,
  );
  if (listed.status !== 0) return undefined;
  const output = `${listed.stdout}\n${listed.stderr}`;
  return (
    output.includes("abandoned-staging") && output.includes("abort-multipart")
  );
}

export function workerUrl(deploymentOutput = ""): string | undefined {
  const configured = process.env.CF_NIX_CACHE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  // A workers.dev hostname contains the account subdomain, which only the
  // deployment output (or the operator, via CF_NIX_CACHE_URL) knows.
  return deploymentOutput.match(/https:\/\/[^\s'"`]+\.workers\.dev/)?.[0];
}

export async function healthCheck(url: string | undefined): Promise<void> {
  if (!url || process.env.CF_NIX_CACHE_SKIP_HEALTHCHECK === "1") return;
  const response = await fetch(`${url.replace(/\/$/, "")}/health`);
  if (!response.ok)
    fail(`Worker health check failed with HTTP ${response.status}`);
}

export function bootstrapCommand(url: string): string {
  return `curl -fsS '${url.replace(/\/$/, "")}/api/bootstrap' \\
  -H 'content-type: application/json' \\
  -H "Idempotency-Key: first-admin-$(date +%s)" \\
  --data '{"subject":"admin","valid_for_seconds":31536000,"grants":[{"cache":"*","role":"admin"}],"secret":"'"$CF_NIX_CACHE_BOOTSTRAP_SECRET"'"}'`;
}
