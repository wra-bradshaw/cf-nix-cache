import { readFile } from "node:fs/promises";
import { fail } from "./fail.mts";
import { parseJsonc } from "./jsonc.mts";
import { configPath } from "./paths.mts";

type DurableObjectBinding = { name?: string; class_name?: string };
type Limits = { cpu_ms?: number; subrequests?: number };
type WorkflowEntry = {
  name?: string;
  binding?: string;
  class_name?: string;
  [key: string]: unknown;
};
type EnvScope = {
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  vars?: Record<string, string>;
  durable_objects?: { bindings?: DurableObjectBinding[] };
  limits?: Limits;
  workflows?: WorkflowEntry[];
  observability?: { enabled?: boolean };
};

export type TemplateConfig = {
  name?: string;
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  durable_objects?: { bindings?: DurableObjectBinding[] };
  limits?: Limits;
  env?: Record<string, EnvScope>;
  workflows?: WorkflowEntry[];
  observability?: { enabled?: boolean };
  vars?: Record<string, string>;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function signingKeyName(config: TemplateConfig): string {
  const vars: unknown = (
    config as Record<string, unknown> | null | undefined
  )?.vars;
  const top: unknown =
    typeof vars === "object" && vars !== null && !Array.isArray(vars)
      ? (vars as Record<string, unknown>).NIX_SIGNING_KEY_NAME
      : undefined;
  return typeof top === "string" && top !== "" ? top : "cache.nix-signing";
}

export const CONFIG_SCHEMA_VERSION = "1";

export async function readConfig(): Promise<TemplateConfig> {
  const source = await readFile(configPath, "utf8");
  try {
    return parseJsonc(source) as TemplateConfig;
  } catch {
    fail(`could not parse ${configPath}`);
  }
}

export const MIN_CPU_MS = 300000;

// See https://github.com/cloudflare/workers-sdk/issues/8756.
export function cpuLimitsProblem(config: TemplateConfig): string | undefined {
  const topLimits: unknown = (config as Record<string, unknown>)?.limits;
  if (topLimits !== undefined && !isRecord(topLimits))
    return `limits must be an object with cpu_ms at least ${MIN_CPU_MS} (5 minutes, which needs Workers Paid)`;
  const topRaw: unknown =
    topLimits === undefined ? undefined : (topLimits as Limits).cpu_ms;
  if (
    topRaw === undefined ||
    typeof topRaw !== "number" ||
    !Number.isFinite(topRaw) ||
    topRaw < MIN_CPU_MS
  )
    return `limits.cpu_ms must be at least ${MIN_CPU_MS} (5 minutes, which needs Workers Paid)`;
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  if (envRecord !== undefined && !isRecord(envRecord))
    return `env must be an object keyed by environment name`;
  for (const [envName, env] of Object.entries(
    (isRecord(envRecord) ? envRecord : {}) as Record<string, EnvScope>,
  )) {
    if (!isRecord(env)) return `env "${envName}": must be an object`;
    const envLimits: unknown = (env as EnvScope).limits;
    if (envLimits === undefined) continue;
    if (!isRecord(envLimits))
      return `env "${envName}": limits must be an object with cpu_ms at least ${MIN_CPU_MS} explicitly`;
    const raw: unknown = (envLimits as Limits).cpu_ms;
    if (raw === undefined)
      return `env "${envName}": defines limits without cpu_ms; set limits.cpu_ms to at least ${MIN_CPU_MS} explicitly`;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < MIN_CPU_MS)
      return `env "${envName}": limits.cpu_ms must be at least ${MIN_CPU_MS} (5 minutes, which needs Workers Paid)`;
  }
  return undefined;
}

export const EXPECTED_WORKFLOWS = [
  {
    name: "process-upload",
    binding: "PROCESS_UPLOAD",
    class_name: "ProcessUploadWorkflow",
  },
  {
    name: "delete-cache",
    binding: "DELETE_CACHE",
    class_name: "DeleteCacheWorkflow",
  },
  {
    name: "garbage-collect",
    binding: "GARBAGE_COLLECT",
    class_name: "GarbageCollectWorkflow",
  },
  {
    name: "evict-cache",
    binding: "EVICT_CACHE",
    class_name: "EvictCacheWorkflow",
  },
] as const;

export const REQUIRED_DURABLE_BINDINGS = [
  { name: "SYSTEM_CONTROL", class_name: "SystemControl" },
  { name: "TOKEN_CATALOG", class_name: "TokenCatalog" },
  { name: "AUDIT_LOG", class_name: "AuditLog" },
  { name: "CACHE_COORDINATOR", class_name: "CacheCoordinator" },
  { name: "CACHE_INDEX", class_name: "CacheIndexShard" },
  { name: "UPLOAD_JOB", class_name: "UploadJob" },
  { name: "GC_CONTROL", class_name: "GcControl" },
] as const;

function checkDurableScope(
  bindings: unknown,
  prefix: string,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (bindings !== undefined && !Array.isArray(bindings)) {
    problems.push(`${prefix}durable_objects.bindings must be an array`);
    return { problems, warnings };
  }
  const byName = new Map<string, DurableObjectBinding>();
  const seen = new Set<string>();
  for (const entry of (bindings ?? []) as unknown[]) {
    if (!isRecord(entry)) {
      problems.push(`${prefix}invalid Durable Object binding entry without a name`);
      continue;
    }
    const binding = entry as DurableObjectBinding;
    if (typeof binding.name !== "string" || binding.name === "") {
      problems.push(`${prefix}invalid Durable Object binding entry without a name`);
      continue;
    }
    if (seen.has(binding.name)) {
      problems.push(`${prefix}duplicate Durable Object binding ${binding.name}`);
      continue;
    }
    seen.add(binding.name);
    byName.set(binding.name, binding);
  }
  for (const required of REQUIRED_DURABLE_BINDINGS) {
    const found = byName.get(required.name);
    if (!found)
      problems.push(`${prefix}missing Durable Object binding ${required.name}`);
    else if (found.class_name !== required.class_name)
      problems.push(
        `${prefix}Durable Object binding ${required.name} must use class ${required.class_name} (found ${found.class_name ?? "none"})`,
      );
  }
  const requiredNames: Set<string> = new Set(
    REQUIRED_DURABLE_BINDINGS.map((required) => required.name),
  );
  for (const name of byName.keys()) {
    if (!requiredNames.has(name))
      warnings.push(
        `${prefix}unknown Durable Object binding ${name} is not used by the Worker`,
      );
  }
  return { problems, warnings };
}

function durableObjectProblems(config: TemplateConfig): string[] {
  const problems: string[] = [];
  const topHolder: unknown = isRecord(config as unknown)
    ? (config as TemplateConfig).durable_objects
    : undefined;
  const topBindings: unknown = isRecord(topHolder)
    ? (topHolder as { bindings?: unknown }).bindings
    : topHolder === undefined
      ? undefined
      : "invalid";
  problems.push(
    ...checkDurableScope(
      topBindings === "invalid" ? "invalid" : topBindings,
      "",
    ).problems,
  );
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  if (!isRecord(envRecord)) return problems;
  for (const [envName, env] of Object.entries(envRecord)) {
    if (!isRecord(env)) continue;
    const holder: unknown = (env as EnvScope).durable_objects;
    if (holder === undefined) continue;
    if (!isRecord(holder)) {
      problems.push(`env "${envName}": durable_objects must be an object`);
      continue;
    }
    const bindings: unknown = (holder as { bindings?: unknown }).bindings;
    if (bindings === undefined) continue;
    problems.push(
      ...checkDurableScope(bindings, `env "${envName}": `).problems,
    );
  }
  return problems;
}

export function durableObjectWarnings(config: TemplateConfig): string[] {
  const warnings: string[] = [];
  const topHolder: unknown = isRecord(config as unknown)
    ? (config as TemplateConfig).durable_objects
    : undefined;
  const topBindings: unknown =
    topHolder === undefined
      ? undefined
      : isRecord(topHolder)
        ? (topHolder as { bindings?: unknown }).bindings
        : "invalid";
  if (Array.isArray(topBindings) || topBindings === undefined)
    warnings.push(...checkDurableScope(topBindings, "").warnings);
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  if (!isRecord(envRecord)) return warnings;
  for (const [envName, env] of Object.entries(envRecord)) {
    if (!isRecord(env)) continue;
    const holder: unknown = (env as EnvScope).durable_objects;
    if (holder === undefined) continue;
    if (!isRecord(holder)) continue;
    const bindings: unknown = (holder as { bindings?: unknown }).bindings;
    if (bindings === undefined) continue;
    if (!Array.isArray(bindings)) continue;
    warnings.push(
      ...checkDurableScope(bindings, `env "${envName}": `).warnings,
    );
  }
  return warnings;
}

function checkWorkflowList(
  list: unknown,
  envName: string | null,
): string[] {
  const prefix = envName ? `env "${envName}": ` : "";
  const problems: string[] = [];
  if (list !== undefined && !Array.isArray(list))
    return [`${prefix}workflows must be an array`];
  const seen = new Set<string>();
  const byName = new Map<string, WorkflowEntry>();
  for (const entry of ((list ?? []) as unknown[])) {
    if (!isRecord(entry)) {
      problems.push(`${prefix}invalid Workflow entry without a name`);
      continue;
    }
    const workflow = entry as WorkflowEntry;
    const name = workflow.name;
    if (typeof name !== "string" || name === "") {
      problems.push(`${prefix}invalid Workflow entry without a name`);
      continue;
    }
    if (seen.has(name)) {
      problems.push(`${prefix}duplicate Workflow ${name}`);
      continue;
    }
    seen.add(name);
    byName.set(name, workflow);
  }
  for (const expected of EXPECTED_WORKFLOWS) {
    const found = byName.get(expected.name);
    if (!found) {
      problems.push(`${prefix}missing Workflow ${expected.name}`);
      continue;
    }
    if (found.binding !== expected.binding)
      problems.push(
        `${prefix}Workflow ${expected.name} must use binding ${expected.binding} (found ${found.binding ?? "none"})`,
      );
    if (found.class_name !== expected.class_name)
      problems.push(
        `${prefix}Workflow ${expected.name} must use class ${expected.class_name} (found ${found.class_name ?? "none"})`,
      );
  }
  return problems;
}

function workflowProblems(config: TemplateConfig): string[] {
  const rawTop: unknown = isRecord(config as unknown)
    ? (config as TemplateConfig).workflows
    : "invalid";
  const problems = checkWorkflowList(
    rawTop === "invalid" ? rawTop : (rawTop ?? []),
    null,
  );
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  if (!isRecord(envRecord)) return problems;
  for (const [envName, env] of Object.entries(envRecord)) {
    if (!isRecord(env)) continue;
    const raw: unknown = (env as EnvScope).workflows;
    if (raw === undefined) continue;
    problems.push(...checkWorkflowList(raw, envName));
  }
  return problems;
}

function workflowWarningsForList(
  list: unknown,
  envName: string | null,
): string[] {
  const prefix = envName ? `env "${envName}": ` : "";
  const expectedNames: Set<string> = new Set(
    EXPECTED_WORKFLOWS.map((expected) => expected.name),
  );
  const warned = new Set<string>();
  const warnings: string[] = [];
  if (!Array.isArray(list)) return warnings;
  for (const entry of list as unknown[]) {
    if (!isRecord(entry)) continue;
    const name = (entry as WorkflowEntry).name;
    if (typeof name !== "string" || name === "") continue;
    if (expectedNames.has(name)) continue;
    if (warned.has(name)) continue;
    warned.add(name);
    warnings.push(
      `${prefix}unknown Workflow ${name} is not used by the Worker`,
    );
  }
  return warnings;
}

export function workflowWarnings(config: TemplateConfig): string[] {
  const rawTop: unknown = isRecord(config as unknown)
    ? (config as TemplateConfig).workflows
    : undefined;
  const warnings = workflowWarningsForList(rawTop ?? [], null);
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  if (!isRecord(envRecord)) return warnings;
  for (const [envName, env] of Object.entries(envRecord)) {
    if (!isRecord(env)) continue;
    const raw: unknown = (env as EnvScope).workflows;
    if (raw === undefined) continue;
    warnings.push(...workflowWarningsForList(raw, envName));
  }
  return warnings;
}

export function observabilityWarnings(config: TemplateConfig): string[] {
  const problems: string[] = [];
  const topObs: unknown = isRecord(config as unknown)
    ? (config as TemplateConfig).observability
    : undefined;
  if (
    topObs === undefined ||
    !isRecord(topObs) ||
    (topObs as { enabled?: unknown }).enabled !== true
  )
    problems.push("observability.enabled should be true");
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  if (!isRecord(envRecord)) return problems;
  for (const [envName, env] of Object.entries(envRecord)) {
    if (!isRecord(env)) continue;
    const raw: unknown = (env as EnvScope).observability;
    if (raw === undefined) continue;
    if (!isRecord(raw) || (raw as { enabled?: unknown }).enabled !== true)
      problems.push(`env "${envName}": observability.enabled should be true`);
  }
  return problems;
}

function headConfigProblems(config: TemplateConfig): string[] {
  const problems: string[] = [];
  if (!isRecord(config as unknown)) return ["wrangler.jsonc must define a Worker name"];
  if (typeof config.name !== "string" || config.name === "")
    problems.push("wrangler.jsonc must define a Worker name");
  const bucketsRaw: unknown = (config as TemplateConfig).r2_buckets;
  if (bucketsRaw !== undefined && !Array.isArray(bucketsRaw)) {
    problems.push("wrangler.jsonc r2_buckets must be an array");
  } else {
    const buckets = ((bucketsRaw ?? []) as unknown[]).filter((entry) =>
      isRecord(entry),
    ) as Array<{ binding?: unknown; bucket_name?: unknown }>;
    const cacheBucket = buckets.find(
      (bucket) => bucket.binding === "CACHE_BUCKET",
    );
    if (
      !cacheBucket ||
      typeof cacheBucket.bucket_name !== "string" ||
      cacheBucket.bucket_name === ""
    )
      problems.push(
        "wrangler.jsonc must define CACHE_BUCKET with a bucket_name",
      );
  }
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  if (envRecord !== undefined && !isRecord(envRecord)) {
    problems.push("wrangler.jsonc env must be an object");
    return problems;
  }
  if (!isRecord(envRecord)) return problems;
  for (const [envName, env] of Object.entries(envRecord)) {
    if (!isRecord(env)) {
      problems.push(`env "${envName}": must be an object`);
      continue;
    }
    const envBucketsRaw: unknown = (env as EnvScope).r2_buckets;
    if (envBucketsRaw === undefined) continue;
    if (!Array.isArray(envBucketsRaw)) {
      problems.push(`env "${envName}": r2_buckets must be an array`);
      continue;
    }
    const envCache = (envBucketsRaw as unknown[]).find(
      (entry) => isRecord(entry) && (entry as { binding?: unknown }).binding === "CACHE_BUCKET",
    ) as { binding?: unknown; bucket_name?: unknown } | undefined;
    if (
      !envCache ||
      typeof envCache.bucket_name !== "string" ||
      envCache.bucket_name === ""
    )
      problems.push(
        `env "${envName}": must define CACHE_BUCKET with a bucket_name`,
      );
  }
  return problems;
}

function varsProblems(config: TemplateConfig): string[] {
  const problems: string[] = [];
  if (!isRecord(config as unknown)) return problems;
  const topVarsRaw: unknown = (config as TemplateConfig).vars;
  if (topVarsRaw !== undefined && !isRecord(topVarsRaw)) {
    problems.push("wrangler.jsonc vars must be an object");
    return problems;
  }
  const topVars = (topVarsRaw ?? {}) as Record<string, unknown>;
  const topKey: unknown = topVars.NIX_SIGNING_KEY_NAME;
  if (
    topKey !== undefined &&
    (typeof topKey !== "string" || topKey === "")
  )
    problems.push("NIX_SIGNING_KEY_NAME must be a non-empty string");
  const resolvedTop =
    typeof topKey === "string" && topKey !== ""
      ? topKey
      : "cache.nix-signing";
  if (topVars.CF_NIX_CACHE_CONFIG_SCHEMA !== CONFIG_SCHEMA_VERSION)
    problems.push(
      `CF_NIX_CACHE_CONFIG_SCHEMA must be ${CONFIG_SCHEMA_VERSION}`,
    );
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  if (!isRecord(envRecord)) return problems;
  for (const [envName, env] of Object.entries(envRecord)) {
    if (!isRecord(env)) continue;
    const envVarsRaw: unknown = (env as EnvScope).vars;
    if (envVarsRaw === undefined) continue;
    if (!isRecord(envVarsRaw)) {
      problems.push(`env "${envName}": vars must be an object`);
      continue;
    }
    const envVars = envVarsRaw as Record<string, unknown>;
    if (
      envVars.CF_NIX_CACHE_CONFIG_SCHEMA !== undefined &&
      envVars.CF_NIX_CACHE_CONFIG_SCHEMA !== CONFIG_SCHEMA_VERSION
    )
      problems.push(
        `env "${envName}": CF_NIX_CACHE_CONFIG_SCHEMA must be ${CONFIG_SCHEMA_VERSION}`,
      );
    const envKey: unknown = envVars.NIX_SIGNING_KEY_NAME;
    if (envKey === undefined) continue;
    if (typeof envKey !== "string" || envKey === "")
      problems.push(
        `env "${envName}": NIX_SIGNING_KEY_NAME must be a non-empty string`,
      );
    else if (envKey !== resolvedTop)
      problems.push(
        `env "${envName}": NIX_SIGNING_KEY_NAME must match the top-level ` +
          `value ("${resolvedTop}"); per-environment signing keys are unsupported`,
      );
  }
  return problems;
}

function tailConfigProblems(config: TemplateConfig): string[] {
  const problems: string[] = [];
  const cpu = cpuLimitsProblem(config);
  if (cpu)
    problems.push(
      `wrangler.jsonc ${cpu}, or the upload workflow cannot verify large NARs`,
    );
  problems.push(...durableObjectProblems(config));
  problems.push(...workflowProblems(config));
  problems.push(...varsProblems(config));
  return problems;
}

export function configProblems(config: TemplateConfig): string[] {
  return [...headConfigProblems(config), ...tailConfigProblems(config)];
}

export function validateConfig(config: TemplateConfig): void {
  for (const problem of configProblems(config)) fail(problem);
}

export async function readValidConfig(): Promise<TemplateConfig> {
  const config = await readConfig();
  validateConfig(config);
  return config;
}
