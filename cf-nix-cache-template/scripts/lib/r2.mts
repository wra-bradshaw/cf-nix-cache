import { stripVTControlCharacters } from "node:util";
import type { TemplateConfig } from "./config.mts";
import { fail } from "./fail.mts";
import { wrangler } from "./wrangler.mts";

export function bucketName(config: TemplateConfig): string {
  const bucket = (config.r2_buckets ?? []).find(
    (entry) => entry.binding === "CACHE_BUCKET",
  )?.bucket_name;
  return bucket ?? fail("CACHE_BUCKET is not configured");
}

// `wrangler r2 bucket list` has no JSON output. Each bucket is printed as a
// labelled block containing the line `name:  <bucket>`, so match that line
// exactly instead of searching for a substring of some other bucket's name.
function bucketListed(output: string, name: string): boolean {
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
