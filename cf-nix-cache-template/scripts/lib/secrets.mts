import { createHash } from "node:crypto";
import { fail } from "./fail.mts";
import { wrangler } from "./wrangler.mts";

const secretNames = [
  "AUTH_PRIVATE_JWK",
  "AUTH_PUBLIC_JWKS",
  "NIX_PRIVATE_JWK",
  "NIX_PUBLIC_KEYS",
  "BOOTSTRAP_SECRET_HASH",
] as const;

export function missingSecrets(names: Set<string>): string[] {
  return secretNames.filter((name) => !names.has(name));
}

export function secretState(
  names: Set<string>,
): "none" | "complete" | "partial" {
  const count = secretNames.filter((name) => names.has(name)).length;
  return count === 0
    ? "none"
    : count === secretNames.length
      ? "complete"
      : "partial";
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
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
