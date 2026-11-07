import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fail } from "./fail.mts";
import { parseJsonc } from "./jsonc.mts";
import { configPath, templateDirectory } from "./paths.mts";
import { validateImageReference } from "./release.mts";

// Rendered configs are written beside wrangler.jsonc; keep in sync with
// .gitignore.
const renderedConfigPrefix = ".wrangler-rendered-";

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
/** The name the Worker signs narinfo with, which clients must trust. */
export function signingKeyName(config: TemplateConfig): string {
  return config.vars?.NIX_SIGNING_KEY_NAME ?? "cache.nix-signing";
}

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

export async function readConfig(): Promise<TemplateConfig> {
  const source = await readFile(configPath, "utf8");
  try {
    return parseJsonc(source) as TemplateConfig;
  } catch {
    fail(`could not parse ${configPath}`);
  }
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

function validateConfig(config: TemplateConfig, image: string): void {
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
    "GC_CONTROL",
  ]) {
    if (!durableNames.has(required))
      fail(`missing Durable Object binding ${required}`);
  }
  if ((config.workflows ?? []).length < 3)
    fail(
      "wrangler.jsonc must define process-upload, delete-cache and garbage-collect workflows",
    );
}

async function renderedConfig(image: string): Promise<string> {
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
