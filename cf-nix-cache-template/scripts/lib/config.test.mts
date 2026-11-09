import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_SCHEMA_VERSION,
  CONTAINER_UPGRADE_INTRO,
  EXPECTED_WORKFLOWS,
  MIN_CPU_MS,
  REQUIRED_DURABLE_BINDINGS,
  configProblems,
  containerUpgradeProblems,
  containerUpgradeResult,
  cpuLimitsProblem,
  durableObjectWarnings,
  observabilityWarnings,
  readConfig,
  signingKeyName,
  validateConfig,
  workflowWarnings,
  type TemplateConfig,
} from "./config.mts";
import { cacheBuckets } from "./r2.mts";
import { templateDirectory } from "./paths.mts";

function validConfig(): TemplateConfig {
  return {
    name: "cf-nix-cache",
    r2_buckets: [{ binding: "CACHE_BUCKET", bucket_name: "cf-nix-cache" }],
    durable_objects: {
      bindings: [
        { name: "SYSTEM_CONTROL", class_name: "SystemControl" },
        { name: "TOKEN_CATALOG", class_name: "TokenCatalog" },
        { name: "AUDIT_LOG", class_name: "AuditLog" },
        { name: "CACHE_COORDINATOR", class_name: "CacheCoordinator" },
        { name: "CACHE_INDEX", class_name: "CacheIndexShard" },
        { name: "UPLOAD_JOB", class_name: "UploadJob" },
        { name: "GC_CONTROL", class_name: "GcControl" },
      ],
    },
    migrations: [
      { tag: "v1" },
      { tag: "v2" },
      { tag: "v3", deleted_classes: ["ProcessorContainer"] },
    ],
    workflows: [
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
    ],
    vars: { CF_NIX_CACHE_CONFIG_SCHEMA: CONFIG_SCHEMA_VERSION },
    observability: { enabled: true },
    limits: { cpu_ms: MIN_CPU_MS },
  };
}

test("a current config has no problems and validates", () => {
  assert.deepEqual(configProblems(validConfig()), []);
  assert.doesNotThrow(() => validateConfig(validConfig()));
});

test("cpu_ms below the minimum is a problem", () => {
  const short = validConfig();
  short.limits = { cpu_ms: MIN_CPU_MS - 1 };
  assert.match(cpuLimitsProblem(short) ?? "", /cpu_ms/);
  assert.match(configProblems(short).join("\n"), /cpu_ms/);
  assert.throws(() => validateConfig(short), /cpu_ms/);
});

test("a missing limit counts as short", () => {
  const { limits: _removed, ...withoutLimits } = validConfig();
  assert.match(cpuLimitsProblem(withoutLimits) ?? "", /cpu_ms/);
  assert.match(configProblems(withoutLimits).join("\n"), /cpu_ms/);
  assert.throws(() => validateConfig(withoutLimits), /cpu_ms/);
});

test("environments inherit the top-level limit unless they override it", () => {
  const inherited = validConfig();
  inherited.env = { preview: {} };
  assert.equal(cpuLimitsProblem(inherited), undefined);

  const overridden = validConfig();
  overridden.env = { preview: { limits: { cpu_ms: 1000 } } };
  assert.match(cpuLimitsProblem(overridden) ?? "", /cpu_ms/);
});

test("a low top-level limit is short even when an environment overrides it", () => {
  const config = validConfig();
  config.limits = { cpu_ms: 1000 };
  config.env = { preview: { limits: { cpu_ms: MIN_CPU_MS } } };
  assert.match(cpuLimitsProblem(config) ?? "", /cpu_ms/);
});

test("an environment that sets limits without cpu_ms must set it explicitly", () => {
  const config = validConfig();
  config.env = { preview: { limits: { subrequests: 100 } } };
  assert.match(cpuLimitsProblem(config) ?? "", /preview/);
  assert.match(cpuLimitsProblem(config) ?? "", /cpu_ms/);
  assert.match(configProblems(config).join("\n"), /preview/);
  assert.throws(() => validateConfig(config), /preview/);
});

test("an environment limit override names the environment", () => {
  const config = validConfig();
  config.env = { preview: { limits: { cpu_ms: 1000 } } };
  assert.match(cpuLimitsProblem(config) ?? "", /preview/);
});

test("a stale processor-container config names every remediation", () => {
  const stale = validConfig();
  stale.containers = [{ class_name: "ProcessorContainer" }];
  stale.durable_objects?.bindings?.push({
    name: "PROCESSOR",
    class_name: "ProcessorContainer",
  });
  stale.migrations = [{ tag: "v1" }];
  stale.limits = { cpu_ms: 1000 };
  const problems = containerUpgradeProblems(stale);
  const joined = problems.join("\n");
  assert.match(joined, /ProcessorContainer/);
  assert.match(joined, /PROCESSOR/);
  assert.match(joined, /v3/);
  assert.match(joined, /cpu_ms/);
  assert.equal(problems.length, 4);
  assert.throws(() => validateConfig(stale), /processor container/i);
});

test("a stale config with enough CPU does not mention cpu_ms", () => {
  const stale = validConfig();
  stale.containers = [{ class_name: "ProcessorContainer" }];
  stale.migrations = [{ tag: "v1" }];
  const joined = containerUpgradeProblems(stale).join("\n");
  assert.match(joined, /ProcessorContainer/);
  assert.doesNotMatch(joined, /cpu_ms/);
});

test("a stale config reports cpu_ms once, not bundled and standalone", () => {
  const stale = validConfig();
  stale.containers = [{ class_name: "ProcessorContainer" }];
  stale.migrations = [{ tag: "v1" }];
  stale.limits = { cpu_ms: 1000 };
  const matches = configProblems(stale).filter((problem) =>
    problem.includes("cpu_ms"),
  );
  assert.equal(matches.length, 1);
});

test("the upgrade result flags the cpu_ms remediation explicitly", () => {
  const stale = validConfig();
  stale.containers = [{ class_name: "ProcessorContainer" }];
  stale.migrations = [{ tag: "v1" }];
  stale.limits = { cpu_ms: 1000 };
  const result = containerUpgradeResult(stale);
  assert.equal(result.includesCpuRemedy, true);
  assert.deepEqual(result.problems, containerUpgradeProblems(stale));

  const enoughCpu = validConfig();
  enoughCpu.containers = [{ class_name: "ProcessorContainer" }];
  enoughCpu.migrations = [{ tag: "v1" }];
  assert.equal(containerUpgradeResult(enoughCpu).includesCpuRemedy, false);

  assert.equal(containerUpgradeResult(validConfig()).includesCpuRemedy, false);
  assert.deepEqual(containerUpgradeResult(validConfig()).problems, []);
});

test("a missing workflow name is a problem", () => {
  const config = validConfig();
  config.workflows = (config.workflows ?? []).filter(
    (workflow) => workflow.name !== "process-upload",
  );
  assert.ok(
    configProblems(config).some((problem) =>
      problem.includes("missing Workflow process-upload"),
    ),
  );
  assert.throws(() => validateConfig(config), /missing Workflow process-upload/);
});

test("a workflow entry without a name is a problem", () => {
  const config = validConfig();
  config.workflows = [...(config.workflows ?? []), {}];
  assert.ok(
    configProblems(config).some((problem) =>
      problem.includes("invalid Workflow entry without a name"),
    ),
  );
  assert.throws(
    () => validateConfig(config),
    /invalid Workflow entry without a name/,
  );
});

test("a workflow with the wrong binding or class is a problem", () => {
  const wrongBinding = validConfig();
  wrongBinding.workflows = (wrongBinding.workflows ?? []).map((workflow) =>
    workflow.name === "process-upload"
      ? { ...workflow, binding: "WRONG" }
      : workflow,
  );
  assert.ok(
    configProblems(wrongBinding).some((problem) =>
      problem.includes("PROCESS_UPLOAD"),
    ),
  );
  assert.throws(() => validateConfig(wrongBinding), /PROCESS_UPLOAD/);

  const wrongClass = validConfig();
  wrongClass.workflows = (wrongClass.workflows ?? []).map((workflow) =>
    workflow.name === "delete-cache"
      ? { ...workflow, class_name: "WrongWorkflow" }
      : workflow,
  );
  assert.ok(
    configProblems(wrongClass).some((problem) =>
      problem.includes("DeleteCacheWorkflow"),
    ),
  );
  assert.throws(() => validateConfig(wrongClass), /DeleteCacheWorkflow/);
});

test("duplicate workflow names are a problem", () => {
  const config = validConfig();
  config.workflows = [
    ...(config.workflows ?? []),
    {
      name: "process-upload",
      binding: "PROCESS_UPLOAD",
      class_name: "ProcessUploadWorkflow",
    },
  ];
  assert.ok(
    configProblems(config).some((problem) =>
      problem.includes("duplicate Workflow process-upload"),
    ),
  );
  assert.throws(
    () => validateConfig(config),
    /duplicate Workflow process-upload/,
  );
});

test("an environment that overrides workflows is checked per env", () => {
  const empty = validConfig();
  empty.env = { preview: { workflows: [] } };
  assert.ok(
    configProblems(empty).some(
      (problem) =>
        problem.includes('env "preview"') &&
        problem.includes("missing Workflow process-upload"),
    ),
  );
  assert.throws(() => validateConfig(empty), /env "preview"/);

  const duplicate = validConfig();
  duplicate.env = {
    preview: {
      workflows: [
        {
          name: "process-upload",
          binding: "PROCESS_UPLOAD",
          class_name: "ProcessUploadWorkflow",
        },
        {
          name: "process-upload",
          binding: "PROCESS_UPLOAD",
          class_name: "ProcessUploadWorkflow",
        },
      ],
    },
  };
  assert.ok(
    configProblems(duplicate).some(
      (problem) =>
        problem.includes('env "preview"') &&
        problem.includes("duplicate Workflow process-upload"),
    ),
  );

  const inherited = validConfig();
  inherited.env = { preview: {} };
  assert.deepEqual(configProblems(inherited), []);
});

test("duplicate durable binding names are a problem", () => {
  const config = validConfig();
  config.durable_objects = {
    bindings: [
      ...(config.durable_objects?.bindings ?? []),
      { name: "SYSTEM_CONTROL", class_name: "SystemControl" },
    ],
  };
  assert.ok(
    configProblems(config).some((problem) =>
      problem.includes("duplicate Durable Object binding SYSTEM_CONTROL"),
    ),
  );
  assert.throws(
    () => validateConfig(config),
    /duplicate Durable Object binding SYSTEM_CONTROL/,
  );

  const envDuplicate = validConfig();
  envDuplicate.env = {
    preview: {
      durable_objects: {
        bindings: [
          ...(validConfig().durable_objects?.bindings ?? []),
          { name: "AUDIT_LOG", class_name: "AuditLog" },
        ],
      },
    },
  };
  assert.ok(
    configProblems(envDuplicate).some(
      (problem) =>
        problem.includes('env "preview"') &&
        problem.includes("duplicate Durable Object binding AUDIT_LOG"),
    ),
  );
});

test("an environment that overrides durable bindings is checked per env", () => {
  const empty = validConfig();
  empty.env = { preview: { durable_objects: { bindings: [] } } };
  assert.ok(
    configProblems(empty).some(
      (problem) =>
        problem.includes('env "preview"') &&
        problem.includes("missing Durable Object binding SYSTEM_CONTROL"),
    ),
  );
  assert.throws(() => validateConfig(empty), /env "preview"/);

  const inherited = validConfig();
  inherited.env = { preview: {} };
  assert.deepEqual(configProblems(inherited), []);
});

test("a durable binding with the wrong class is a problem", () => {
  const wrongClass = validConfig();
  wrongClass.durable_objects = {
    bindings: (wrongClass.durable_objects?.bindings ?? []).map((binding) =>
      binding.name === "SYSTEM_CONTROL"
        ? { ...binding, class_name: "WrongClass" }
        : binding,
    ),
  };
  assert.ok(
    configProblems(wrongClass).some((problem) =>
      problem.includes(
        "Durable Object binding SYSTEM_CONTROL must use class SystemControl",
      ),
    ),
  );
  assert.throws(() => validateConfig(wrongClass), /SystemControl/);

  const envWrongClass = validConfig();
  envWrongClass.env = {
    preview: {
      durable_objects: {
        bindings: (validConfig().durable_objects?.bindings ?? []).map(
          (binding) =>
            binding.name === "AUDIT_LOG"
              ? { ...binding, class_name: "WrongClass" }
              : binding,
        ),
      },
    },
  };
  assert.ok(
    configProblems(envWrongClass).some(
      (problem) =>
        problem.includes('env "preview"') &&
        problem.includes(
          "Durable Object binding AUDIT_LOG must use class AuditLog",
        ),
    ),
  );
});

test("an environment that overrides buckets must still define CACHE_BUCKET", () => {
  const empty = validConfig();
  empty.env = { preview: { r2_buckets: [] } };
  assert.ok(
    configProblems(empty).some(
      (problem) =>
        problem.includes('env "preview"') &&
        problem.includes("CACHE_BUCKET"),
    ),
  );
  assert.throws(() => validateConfig(empty), /env "preview"/);

  const renamed = validConfig();
  renamed.env = {
    preview: { r2_buckets: [{ binding: "OTHER", bucket_name: "other" }] },
  };
  assert.ok(
    configProblems(renamed).some((problem) =>
      problem.includes('env "preview"'),
    ),
  );

  const inheritedBuckets = validConfig();
  inheritedBuckets.env = { preview: {} };
  assert.deepEqual(configProblems(inheritedBuckets), []);
});

test("observability is warned per scope but stays out of check", () => {
  assert.deepEqual(observabilityWarnings(validConfig()), []);
  assert.deepEqual(configProblems(validConfig()), []);

  const disabled = validConfig();
  disabled.observability = { enabled: false };
  assert.ok(
    observabilityWarnings(disabled).some((problem) =>
      problem.includes("observability.enabled should be true"),
    ),
  );
  assert.deepEqual(configProblems(disabled), []);

  const inherited = validConfig();
  inherited.env = { preview: {} };
  assert.deepEqual(observabilityWarnings(inherited), []);

  const envDisabled = validConfig();
  envDisabled.env = { preview: { observability: { enabled: false } } };
  assert.ok(
    observabilityWarnings(envDisabled).some(
      (problem) =>
        problem.includes('env "preview"') &&
        problem.includes("observability.enabled should be true"),
    ),
  );
  assert.deepEqual(configProblems(envDisabled), []);
});

test("an environment-scoped stale container is still an upgrade", () => {
  const stale = validConfig();
  stale.env = { preview: { containers: [{ class_name: "ProcessorContainer" }] } };
  stale.migrations = [{ tag: "v1" }];
  const result = containerUpgradeResult(stale);
  assert.ok(result.remedies.length > 0);
  assert.ok(
    result.remedies.some((remedy) => remedy.includes("ProcessorContainer")),
  );
  assert.ok(
    result.problems.every((problem) =>
      problem.startsWith(CONTAINER_UPGRADE_INTRO),
    ),
  );
  assert.throws(() => validateConfig(stale), /processor container/i);
});

test("an environment-scoped stale binding is still an upgrade", () => {
  const stale = validConfig();
  stale.env = {
    preview: {
      durable_objects: {
        bindings: [
          ...(validConfig().durable_objects?.bindings ?? []),
          { name: "PROCESSOR", class_name: "ProcessorContainer" },
        ],
      },
    },
  };
  stale.migrations = [{ tag: "v1" }];
  assert.ok(
    containerUpgradeProblems(stale).some((problem) =>
      problem.includes("PROCESSOR"),
    ),
  );
  assert.throws(() => validateConfig(stale), /processor container/i);
});

test("signingKeyName honors NIX_SIGNING_KEY_NAME with a default", () => {
  assert.equal(signingKeyName(validConfig()), "cache.nix-signing");
  const custom = validConfig();
  custom.vars = {
    ...custom.vars,
    CF_NIX_CACHE_CONFIG_SCHEMA: CONFIG_SCHEMA_VERSION,
    NIX_SIGNING_KEY_NAME: "cache.custom",
  };
  assert.equal(signingKeyName(custom), "cache.custom");
  const noVars: TemplateConfig = { ...validConfig() };
  delete noVars.vars;
  assert.equal(signingKeyName(noVars), "cache.nix-signing");
});

test("the upgrade result exposes one intro with bulleted remedies", () => {
  const stale = validConfig();
  stale.containers = [{ class_name: "ProcessorContainer" }];
  stale.migrations = [{ tag: "v1" }];
  const result = containerUpgradeResult(stale);
  assert.equal(result.intro, CONTAINER_UPGRADE_INTRO);
  assert.ok(result.remedies.length > 0);
  assert.deepEqual(
    result.problems,
    result.remedies.map((remedy) => `${result.intro}: ${remedy}`),
  );
});

test("a durable binding entry without a name is invalid", () => {
  const config = validConfig();
  config.durable_objects = {
    bindings: [
      ...(config.durable_objects?.bindings ?? []),
      { class_name: "SystemControl" },
    ],
  };
  assert.ok(
    configProblems(config).some((problem) =>
      problem.includes("invalid Durable Object binding entry without a name"),
    ),
  );
  assert.throws(
    () => validateConfig(config),
    /invalid Durable Object binding entry without a name/,
  );

  const envInvalid = validConfig();
  envInvalid.env = {
    preview: {
      durable_objects: {
        bindings: [
          ...(validConfig().durable_objects?.bindings ?? []),
          { class_name: "NoName" },
        ],
      },
    },
  };
  assert.ok(
    configProblems(envInvalid).some(
      (problem) =>
        problem.includes('env "preview"') &&
        problem.includes("invalid Durable Object binding entry without a name"),
    ),
  );
});

test("unknown extra durable bindings warn but stay out of check", () => {
  const config = validConfig();
  config.durable_objects = {
    bindings: [
      ...(config.durable_objects?.bindings ?? []),
      { name: "EXTRA", class_name: "Extra" },
    ],
  };
  assert.deepEqual(configProblems(config), []);
  assert.doesNotThrow(() => validateConfig(config));
  assert.ok(
    durableObjectWarnings(config).some((warning) =>
      warning.includes("unknown Durable Object binding EXTRA"),
    ),
  );

  const envExtra = validConfig();
  envExtra.env = {
    preview: {
      durable_objects: {
        bindings: [
          ...(validConfig().durable_objects?.bindings ?? []),
          { name: "EXTRA", class_name: "Extra" },
        ],
      },
    },
  };
  assert.deepEqual(configProblems(envExtra), []);
  assert.ok(
    durableObjectWarnings(envExtra).some(
      (warning) =>
        warning.includes('env "preview"') &&
        warning.includes("unknown Durable Object binding EXTRA"),
    ),
  );
  assert.deepEqual(durableObjectWarnings(validConfig()), []);
});

test("name, bucket, bindings, and schema are all enforced", () => {
  const noName = validConfig();
  delete noName.name;
  assert.throws(() => validateConfig(noName), /Worker name/);

  const noBucket = validConfig();
  noBucket.r2_buckets = [];
  assert.throws(() => validateConfig(noBucket), /CACHE_BUCKET/);

  const noBinding = validConfig();
  noBinding.durable_objects = { bindings: [] };
  assert.throws(
    () => validateConfig(noBinding),
    /missing Durable Object binding/,
  );

  const badSchema = validConfig();
  badSchema.vars = { CF_NIX_CACHE_CONFIG_SCHEMA: "999" };
  assert.ok(
    configProblems(badSchema).includes(
      `CF_NIX_CACHE_CONFIG_SCHEMA must be ${CONFIG_SCHEMA_VERSION}`,
    ),
  );
  assert.throws(
    () => validateConfig(badSchema),
    /CF_NIX_CACHE_CONFIG_SCHEMA must be/,
  );

  const missingSchema = validConfig();
  delete missingSchema.vars;
  assert.throws(
    () => validateConfig(missingSchema),
    /CF_NIX_CACHE_CONFIG_SCHEMA must be/,
  );
});

test("unknown extra workflows warn but stay out of check", () => {
  const config = validConfig();
  config.workflows = [
    ...(config.workflows ?? []),
    { name: "EXTRA", binding: "EXTRA", class_name: "Extra" },
  ];
  assert.deepEqual(configProblems(config), []);
  assert.doesNotThrow(() => validateConfig(config));
  assert.ok(
    workflowWarnings(config).some((warning) =>
      warning.includes("unknown Workflow EXTRA"),
    ),
  );

  const envExtra = validConfig();
  envExtra.env = {
    preview: {
      workflows: [
        ...(validConfig().workflows ?? []),
        { name: "EXTRA", binding: "EXTRA", class_name: "Extra" },
      ],
    },
  };
  assert.deepEqual(configProblems(envExtra), []);
  assert.ok(
    workflowWarnings(envExtra).some(
      (warning) =>
        warning.includes('env "preview"') &&
        warning.includes("unknown Workflow EXTRA"),
    ),
  );
  assert.deepEqual(workflowWarnings(validConfig()), []);

  const inherited = validConfig();
  inherited.env = { preview: {} };
  assert.deepEqual(workflowWarnings(inherited), []);
});

test("upgrade findings deduplicate by exact problem, not intro prefix", () => {
  const stale = validConfig();
  stale.containers = [{ class_name: "ProcessorContainer" }];
  stale.migrations = [{ tag: "v1" }];
  const result = containerUpgradeResult(stale);
  const upgradeSet = new Set(result.problems);
  assert.equal(upgradeSet.size, result.problems.length);
  for (const problem of result.problems)
    assert.ok(configProblems(stale).includes(problem));
  const nonUpgrade = configProblems(stale).filter(
    (problem) => !upgradeSet.has(problem),
  );
  assert.deepEqual(nonUpgrade, []);
});

test("live bucket refs cover env overrides without duplicating the top level", () => {
  assert.deepEqual(cacheBuckets(validConfig()), [
    { envName: null, bucket: "cf-nix-cache" },
  ]);

  const inherited = validConfig();
  inherited.env = { preview: {} };
  assert.deepEqual(cacheBuckets(inherited), [
    { envName: null, bucket: "cf-nix-cache" },
  ]);

  const override = validConfig();
  override.env = {
    preview: {
      r2_buckets: [{ binding: "CACHE_BUCKET", bucket_name: "preview-bucket" }],
    },
  };
  assert.deepEqual(cacheBuckets(override), [
    { envName: null, bucket: "cf-nix-cache" },
    { envName: "preview", bucket: "preview-bucket" },
  ]);

  const sameBucket = validConfig();
  sameBucket.env = {
    preview: {
      r2_buckets: [{ binding: "CACHE_BUCKET", bucket_name: "cf-nix-cache" }],
    },
  };
  assert.deepEqual(cacheBuckets(sameBucket), [
    { envName: null, bucket: "cf-nix-cache" },
  ]);

  const missingTop: TemplateConfig = validConfig();
  missingTop.r2_buckets = [];
  missingTop.env = {
    preview: {
      r2_buckets: [{ binding: "CACHE_BUCKET", bucket_name: "preview-bucket" }],
    },
  };
  assert.deepEqual(cacheBuckets(missingTop), [
    { envName: "preview", bucket: "preview-bucket" },
  ]);
});

test("expected workflows and bindings match the template wrangler.jsonc", async () => {
  const config = await readConfig();
  for (const expected of EXPECTED_WORKFLOWS) {
    const found = (config.workflows ?? []).find(
      (workflow) => workflow.name === expected.name,
    );
    assert.ok(found, `wrangler.jsonc is missing Workflow ${expected.name}`);
    assert.equal(found.binding, expected.binding);
    assert.equal(found.class_name, expected.class_name);
  }
  const bindings = new Map(
    (config.durable_objects?.bindings ?? []).map((binding) => [
      binding.name,
      binding,
    ]),
  );
  for (const required of REQUIRED_DURABLE_BINDINGS) {
    const found = bindings.get(required.name);
    assert.ok(
      found,
      `wrangler.jsonc is missing Durable Object binding ${required.name}`,
    );
    assert.equal(found.class_name, required.class_name);
  }
});

const workerIndexPath = join(
  templateDirectory,
  "..",
  "packages",
  "worker",
  "src",
  "index.ts",
);
(existsSync(workerIndexPath) ? test : test.skip)(
  "expected workflow and durable classes are exported by the Worker source",
  async () => {
    const source = await readFile(workerIndexPath, "utf8");
    for (const expected of EXPECTED_WORKFLOWS) {
      assert.match(
        source,
        new RegExp(`export\\s*\\{[^}]*\\b${expected.class_name}\\b`),
        `Worker source does not export ${expected.class_name}`,
      );
    }
    for (const required of REQUIRED_DURABLE_BINDINGS) {
      assert.match(
        source,
        new RegExp(`export\\s*\\{[^}]*\\b${required.class_name}\\b`),
        `Worker source does not export ${required.class_name}`,
      );
    }
  },
);
