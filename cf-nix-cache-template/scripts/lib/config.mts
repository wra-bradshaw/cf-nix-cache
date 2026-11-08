import { readFile } from "node:fs/promises";
import { fail } from "./fail.mts";
import { parseJsonc } from "./jsonc.mts";
import { configPath } from "./paths.mts";

type DurableObjectBinding = { name?: string; class_name?: string };
type Container = { class_name?: string; [key: string]: unknown };
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
  containers?: Container[];
  durable_objects?: { bindings?: DurableObjectBinding[] };
  limits?: Limits;
  workflows?: WorkflowEntry[];
  observability?: { enabled?: boolean };
};

export type TemplateConfig = {
  name?: string;
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  containers?: Container[];
  durable_objects?: { bindings?: DurableObjectBinding[] };
  limits?: Limits;
  env?: Record<string, EnvScope>;
  migrations?: Array<{ tag?: string; deleted_classes?: string[] }>;
  workflows?: WorkflowEntry[];
  observability?: { enabled?: boolean };
  vars?: Record<string, string>;
  [key: string]: unknown;
};

/**
 * Plain-object guard for values decoded from wrangler.jsonc. The config is
 * untrusted JSON, so every nested scope is validated at runtime: a wrong
 * type (string `cpu_ms`, numeric `bucket_name`, non-array `bindings`, null
 * `limits`/`vars`) is reported as a config problem instead of throwing a
 * TypeError or passing silently.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The name the Worker signs narinfo with, which clients must trust.
 *
 * Only the top-level `vars.NIX_SIGNING_KEY_NAME` is used: `setup`, `doctor`,
 * and `rotate-nix-key` all resolve the key name from the top level.
 * Per-environment overrides are rejected by `configProblems`, so a config
 * that passes `check` never diverges per env.
 */
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

/**
 * The wrangler.jsonc shape version this template understands, stored in
 * `vars.CF_NIX_CACHE_CONFIG_SCHEMA`. This is independent of the release
 * manifest's `schemaVersion` (currently 2, checked in `release.mts`), which
 * versions the published `cf-nix-cache` npm metadata rather than the
 * deployment config.
 */
export const CONFIG_SCHEMA_VERSION = "1";

export async function readConfig(): Promise<TemplateConfig> {
  const source = await readFile(configPath, "utf8");
  try {
    return parseJsonc(source) as TemplateConfig;
  } catch {
    fail(`could not parse ${configPath}`);
  }
}

/**
 * The upload workflow verifies NARs of up to 10 GiB in one step, which needs
 * this much CPU. Above 30 s only Workers Paid allows it.
 */
export const MIN_CPU_MS = 300000;

/**
 * Describes the cpu_ms shortfall, or returns undefined when the top level and
 * every environment allow the upload workflow enough CPU.
 *
 * Wrangler inherits the top-level `limits` only when an environment does not
 * define `limits` at all; an environment that sets `limits` must repeat
 * `cpu_ms` explicitly (`cpu_ms` is required when the `limits` key is present,
 * and the env object replaces rather than merges). An env `limits` without
 * `cpu_ms` is therefore a problem even when the top level sets it.
 * See https://github.com/cloudflare/workers-sdk/issues/8756.
 */
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

/**
 * Intro line for the processor-container upgrade, shared by `doctor` (which
 * prints it once followed by bulleted remedies) and the per-remediation
 * `problems` below (which `validateConfig` fails on one at a time).
 */
export const CONTAINER_UPGRADE_INTRO = `wrangler.jsonc is from a template release that ran the processor container, which has been removed: uploads are now verified in the Worker. Upgrade wrangler.jsonc from the template together with the cf-nix-cache package (see "Upgrading from a release with the processor container" in README.md)`;

/**
 * One finding per remediation for a wrangler.jsonc from a template release
 * that still ran the processor container, or an empty list when it is
 * current. Uploads are now verified in the Worker, and the package no longer
 * exports ProcessorContainer.
 *
 * `problems` keeps one self-contained entry per remediation so `validateConfig`
 * fails fast on the first one; `doctor` instead prints `intro` once followed
 * by `remedies` as bullets to avoid repeating the intro per line.
 *
 * The result carries an explicit `includesCpuRemedy` flag so callers that
 * need to deduplicate the standalone cpu_ms failure do not have to match on
 * the problem text.
 */
export type ContainerUpgradeResult = {
  intro: string;
  remedies: string[];
  problems: string[];
  includesCpuRemedy: boolean;
};

export function containerUpgradeResult(
  config: TemplateConfig,
): ContainerUpgradeResult {
  // Upgrade detection must never throw on malformed JSON: non-array
  // `containers`/`bindings`/`migrations` simply count as "no stale entry
  // here". Malformed shapes are reported as problems by the dedicated
  // checks; this function only looks for known stale entries.
  const envRecord: unknown = (config as Record<string, unknown>)?.env;
  const scopes: unknown[] = [
    config,
    ...(isRecord(envRecord) ? Object.values(envRecord) : []),
  ];
  const containersOf = (scope: unknown): Container[] => {
    const raw: unknown = isRecord(scope as unknown)
      ? (scope as EnvScope).containers
      : undefined;
    return Array.isArray(raw) ? (raw as Container[]) : [];
  };
  const bindingsOf = (scope: unknown): DurableObjectBinding[] => {
    const holder: unknown = isRecord(scope as unknown)
      ? (scope as EnvScope).durable_objects
      : undefined;
    const raw: unknown =
      isRecord(holder) || Array.isArray(holder)
        ? (holder as { bindings?: unknown }).bindings
        : undefined;
    return Array.isArray(raw) ? (raw as DurableObjectBinding[]) : [];
  };
  const remedies: string[] = [];
  if (
    scopes.some((scope) =>
      containersOf(scope).some(
        (container) =>
          isRecord(container as unknown) &&
          (container as Container).class_name === "ProcessorContainer",
      ),
    )
  )
    remedies.push("remove the ProcessorContainer entry from `containers`");
  if (
    scopes.some((scope) =>
      bindingsOf(scope).some(
        (binding) =>
          isRecord(binding as unknown) &&
          ((binding as DurableObjectBinding).name === "PROCESSOR" ||
            (binding as DurableObjectBinding).class_name ===
              "ProcessorContainer"),
      ),
    )
  )
    remedies.push("remove the PROCESSOR Durable Object binding");
  const migrationsRaw: unknown = (config as Record<string, unknown>)
    ?.migrations;
  const migrations: Array<{ tag?: string; deleted_classes?: string[] }> =
    Array.isArray(migrationsRaw)
      ? (migrationsRaw as Array<{
          tag?: string;
          deleted_classes?: string[];
        }>)
      : [];
  if (
    !migrations.some(
      (migration) =>
        isRecord(migration as unknown) &&
        Array.isArray(
          (migration as { deleted_classes?: unknown }).deleted_classes,
        ) &&
        (
          (migration as { deleted_classes?: string[] }).deleted_classes ?? []
        ).includes("ProcessorContainer"),
    )
  )
    remedies.push(
      'append the migration { "tag": "v3", "deleted_classes": ["ProcessorContainer"] }',
    );
  // The upgrade also raised the CPU limit for in-Worker verification. Include
  // that remediation here only when the config is otherwise stale: a current
  // config with a lowered limit gets the dedicated cpu_ms failure instead.
  const cpu = cpuLimitsProblem(config);
  const includesCpuRemedy = cpu !== undefined && remedies.length > 0;
  if (includesCpuRemedy) remedies.push(`set ${cpu}`);
  if (!remedies.length)
    return {
      intro: CONTAINER_UPGRADE_INTRO,
      remedies: [],
      problems: [],
      includesCpuRemedy: false,
    };
  return {
    intro: CONTAINER_UPGRADE_INTRO,
    remedies,
    problems: remedies.map((remedy) => `${CONTAINER_UPGRADE_INTRO}: ${remedy}`),
    includesCpuRemedy,
  };
}

export function containerUpgradeProblems(config: TemplateConfig): string[] {
  return containerUpgradeResult(config).problems;
}

/**
 * The Workflows the Worker serves, with the binding and class the Worker
 * code expects. A renamed binding or class leaves the workflow entrypoint
 * unreachable, so the check fails on those too, not just on a missing
 * workflow name.
 */
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

/**
 * Missing Durable Object bindings, checked per scope. An environment without
 * its own `durable_objects.bindings` inherits the top level, so it is covered
 * by the top-level check; an environment that overrides bindings must still
 * define every required binding. Bindings without a name are invalid entries
 * (they can never match a required binding), reported here rather than as a
 * generic missing binding.
 */
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
    // Mirror the Workflow duplicate check below: a repeated name would
    // otherwise collapse silently in `byName` and only the last entry
    // would be checked.
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

/**
 * Extra Durable Object bindings the Worker never uses, checked per scope.
 * Unknown bindings deploy harmlessly, so these stay doctor-only warnings:
 * `configProblems` (used by `pnpm run check` and `pnpm run deploy`) omits
 * them while `doctor` surfaces them via this function.
 */
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

/**
 * Missing, duplicate, or misconfigured Workflows, checked per scope. Like
 * Durable Objects, an environment without its own `workflows` inherits the
 * top level; an environment that overrides `workflows` must still define
 * every expected workflow exactly once.
 *
 * Extra workflows are intentionally not problems here: they deploy
 * harmlessly. `workflowWarnings` surfaces them as doctor-only warnings so
 * an unused workflow entrypoint does not fail `check`/`deploy`.
 */
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

/**
 * Extra Workflows the Worker never serves, checked per scope. Like extra
 * Durable Object bindings, unknown workflows deploy harmlessly, so these
 * stay doctor-only warnings: `configProblems` (used by `pnpm run check` and
 * `pnpm run deploy`) omits them while `doctor` surfaces them via this
 * function. An environment without its own `workflows` inherits the top
 * level and needs no extra check.
 */
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

/**
 * Observability warnings, checked per scope. An environment without its own
 * `observability` inherits the top level, so it is covered by the top-level
 * warning; an environment that overrides `observability` must still enable
 * it. This stays doctor-only: disabling observability does not make
 * wrangler.jsonc undeployable, so `configProblems` (used by `pnpm run check`
 * and `pnpm run deploy`) omits it while `doctor` warns.
 */
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

/**
 * Every problem that makes wrangler.jsonc undeployable. `validateConfig`
 * fails on the first of these, while `doctor` reports all of them, so
 * `pnpm run doctor` cannot pass a config that `pnpm run check` or
 * `pnpm run deploy` rejects.
 *
 * `observability.enabled`, unknown extra Durable Object bindings, and
 * unknown extra Workflows are intentionally absent here: they do not block
 * deploys, so `doctor` warns about them via `observabilityWarnings`,
 * `durableObjectWarnings`, and `workflowWarnings` (top level and per-env
 * overrides) while `check` stays green.
 *
 * `limits.subrequests`, the `v1`/`v2` migrations, and `TOKEN_ISSUER`/
 * `TOKEN_AUDIENCE` are also intentionally absent: only presence is required
 * for deploy, and a lowered subrequests budget or a changed issuer/audience
 * still deploys and fails at runtime rather than at config time. Wrangler
 * itself validates the migration history on `deploy --dry-run`. `doctor`
 * live-checks secrets, bucket, and lifecycle instead of duplicating those
 * runtime checks here; it does not validate these values.
 */
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
  // An environment without its own `r2_buckets` inherits the top level; an
  // environment that overrides buckets must still define CACHE_BUCKET.
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

/**
 * `vars` entries that make wrangler.jsonc undeployable. The top level must
 * carry the current config-schema marker, and `NIX_SIGNING_KEY_NAME` must be
 * a non-empty string when present. Environments inherit top-level `vars`
 * unless they define their own `vars` object, so an environment that
 * overrides `vars` must repeat a matching schema marker and must not set a
 * divergent signing-key name: `setup`, `doctor`, and `rotate-nix-key`
 * resolve the key name from the top level only.
 */
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

function tailConfigProblems(
  config: TemplateConfig,
  includesCpuRemedy: boolean,
): string[] {
  const problems: string[] = [];
  // A stale config's upgrade findings already include the cpu_ms remediation
  // when the limit is short, so the standalone cpu_ms failure is only
  // reported for an otherwise current config.
  const cpu = cpuLimitsProblem(config);
  if (cpu && !includesCpuRemedy)
    problems.push(
      `wrangler.jsonc ${cpu}, or the upload workflow cannot verify large NARs`,
    );
  problems.push(...durableObjectProblems(config));
  problems.push(...workflowProblems(config));
  // Versions the wrangler.jsonc shape this template understands; independent
  // of the release manifest's `schemaVersion` (checked in `release.mts`),
  // which versions the published package metadata.
  problems.push(...varsProblems(config));
  return problems;
}

export function configProblems(config: TemplateConfig): string[] {
  const upgrades = containerUpgradeResult(config);
  return [
    ...headConfigProblems(config),
    ...upgrades.problems,
    ...tailConfigProblems(config, upgrades.includesCpuRemedy),
  ];
}

/**
 * Every entry of `configProblems` except the per-remediation upgrade
 * findings. `doctor` prints the upgrade as one bulleted finding (intro plus
 * remedies) and reports these individually, so it never matches on problem
 * text: the shared `includesCpuRemedy` flag decides whether the standalone
 * cpu_ms failure appears here (current config) or is already bundled into
 * the upgrade remedies (stale config).
 */
export function configProblemsWithoutUpgrade(
  config: TemplateConfig,
): string[] {
  const upgrades = containerUpgradeResult(config);
  return [
    ...headConfigProblems(config),
    ...tailConfigProblems(config, upgrades.includesCpuRemedy),
  ];
}

/**
 * Fails fast on the first problem. This is intentional: `doctor` reports
 * every entry of `configProblems` in one run, while `check` and `deploy`
 * surface one problem per run through this function.
 */
export function validateConfig(config: TemplateConfig): void {
  for (const problem of configProblems(config)) fail(problem);
}

/** Reads wrangler.jsonc and fails unless it is deployable. */
export async function readValidConfig(): Promise<TemplateConfig> {
  const config = await readConfig();
  validateConfig(config);
  return config;
}
