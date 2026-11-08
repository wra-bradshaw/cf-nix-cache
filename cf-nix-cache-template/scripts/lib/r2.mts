import { stripVTControlCharacters } from "node:util";
import type { TemplateConfig } from "./config.mts";
import { fail } from "./fail.mts";
import { wrangler } from "./wrangler.mts";

export type CacheBucketRef = { envName: string | null; bucket: string };

export function cacheBuckets(config: TemplateConfig): CacheBucketRef[] {
  const refs: CacheBucketRef[] = [];
  const rawTop: unknown = (config as Record<string, unknown> | null | undefined)
    ?.r2_buckets;
  const top = (
    Array.isArray(rawTop)
      ? rawTop.find(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry) &&
            (entry as { binding?: unknown }).binding === "CACHE_BUCKET",
        ) as { bucket_name?: unknown } | undefined
      : undefined
  )?.bucket_name;
  if (typeof top === "string" && top !== "")
    refs.push({ envName: null, bucket: top });
  const envRecord: unknown = (
    config as Record<string, unknown> | null | undefined
  )?.env;
  if (typeof envRecord !== "object" || envRecord === null || Array.isArray(envRecord))
    return refs;
  for (const [envName, env] of Object.entries(
    envRecord as Record<string, unknown>,
  )) {
    if (typeof env !== "object" || env === null || Array.isArray(env))
      continue;
    const raw: unknown = (env as { r2_buckets?: unknown }).r2_buckets;
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) continue;
    const found = raw.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        (entry as { binding?: unknown }).binding === "CACHE_BUCKET",
    ) as { bucket_name?: unknown } | undefined;
    const name = found?.bucket_name;
    if (typeof name !== "string" || name === "") continue;
    if (refs.some((ref) => ref.bucket === name)) continue;
    refs.push({ envName, bucket: name });
  }
  return refs;
}

// `wrangler r2 bucket list` has no JSON output. Each bucket is printed as a
// labelled block containing the line `name:  <bucket>`, so match that line
// exactly instead of searching for a substring of some other bucket's name.
function bucketListed(output: string, name: string): boolean {
  return stripVTControlCharacters(output)
    .split(/\r?\n/)
    .some((line) => /^\s*name:\s+(\S+)\s*$/.exec(line)?.[1] === name);
}

export async function bucketExists(name: string): Promise<boolean> {
  const listed = await wrangler(["r2", "bucket", "list"], { quiet: true });
  return bucketListed(listed.stdout, name);
}

export async function ensureBucket(name: string): Promise<void> {
  if (await bucketExists(name)) return;
  const created = await wrangler(["r2", "bucket", "create", name], {
    allowFailure: true,
  });
  if (
    created.status !== 0 &&
    !/already exists/i.test(`${created.stdout}\n${created.stderr}`)
  )
    fail(`could not create R2 bucket ${name}`);
}

export async function ensureLifecycle(bucket: string): Promise<void> {
  const listed = await wrangler(["r2", "bucket", "lifecycle", "list", bucket], {
    quiet: true,
  });
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
      ]);
}

export async function lifecycleIsConfigured(
  bucket: string,
): Promise<boolean | undefined> {
  const listed = await wrangler(["r2", "bucket", "lifecycle", "list", bucket], {
    allowFailure: true,
    quiet: true,
  });
  if (listed.status !== 0) return undefined;
  const output = `${listed.stdout}\n${listed.stderr}`;
  return output.includes("abandoned-staging");
}
