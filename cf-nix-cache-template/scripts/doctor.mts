import {
  configProblemsWithoutUpgrade,
  containerUpgradeResult,
  durableObjectWarnings,
  observabilityWarnings,
  readConfig,
  workflowWarnings,
} from "./lib/config.mts";
import {
  bucketExists,
  cacheBuckets,
  lifecycleIsConfigured,
} from "./lib/r2.mts";
import {
  installedPackageVersion,
  releaseManifest,
  type ReleaseManifest,
} from "./lib/release.mts";
import {
  missingSecrets,
  secretNamesFromWrangler,
  secretState,
} from "./lib/secrets.mts";

export async function doctor(): Promise<void> {
  const config = await readConfig();
  const findings: string[] = [];
  let manifest: ReleaseManifest | undefined;
  try {
    manifest = await releaseManifest();
  } catch (error) {
    findings.push(
      error instanceof Error
        ? error.message
        : "could not inspect the installed release manifest",
    );
  }
  // Report every config problem `pnpm run check` and `pnpm run deploy`
  // would fail on (Worker name, R2 binding, Durable Object bindings,
  // workflow names/bindings/classes, CPU limit, upgrade state, config
  // schema). Upgrade remediations share one intro, so print it once with
  // bulleted remedies instead of repeating it per line; `validateConfig`
  // still fails fast on the first per-remediation entry. The non-upgrade
  // problems come from `configProblemsWithoutUpgrade`, which reuses the
  // `includesCpuRemedy` flag instead of matching on problem text.
  const upgrades = containerUpgradeResult(config);
  if (upgrades.remedies.length)
    findings.push(
      `${upgrades.intro}:\n${upgrades.remedies.map((remedy) => `- ${remedy}`).join("\n")}`,
    );
  for (const problem of configProblemsWithoutUpgrade(config))
    findings.push(problem);
  if (manifest !== undefined) {
    try {
      const installedVersion = await installedPackageVersion();
      if (installedVersion !== manifest.version)
        findings.push(
          `installed Worker package version ${installedVersion} differs from release manifest version ${manifest.version}`,
        );
    } catch (error) {
      findings.push(
        error instanceof Error
          ? error.message
          : "could not inspect the installed Worker package version",
      );
    }
  }
  try {
    const names = await secretNamesFromWrangler();
    const state = secretState(names);
    if (state === "partial")
      findings.push(
        `partial secret set (missing ${missingSecrets(names).join(", ")})`,
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

  // The missing-bucket problems are already reported above via
  // configProblems; only run the live R2 checks for buckets that are
  // configured. Environments without their own `r2_buckets` inherit the top
  // level, so `cacheBuckets` returns just the top level for them; an
  // environment that overrides CACHE_BUCKET gets its own live check.
  for (const { envName, bucket } of cacheBuckets(config)) {
    const prefix = envName ? `env "${envName}": ` : "";
    try {
      if (!(await bucketExists(bucket)))
        findings.push(
          `${prefix}R2 bucket ${bucket} is not listed by \`wrangler r2 bucket list\` for this account`,
        );
      const lifecycle = await lifecycleIsConfigured(bucket);
      if (lifecycle === false)
        findings.push(`${prefix}the R2 staging lifecycle rule is missing`);
      if (lifecycle === undefined)
        findings.push(
          `${prefix}cannot verify R2 lifecycle rules; check Wrangler authentication`,
        );
    } catch (error) {
      findings.push(
        error instanceof Error
          ? `${prefix}${error.message}`
          : `${prefix}could not inspect R2`,
      );
    }
  }

  // Observability, unknown extra bindings, and unknown extra workflows are
  // intentionally doctor-only: disabling observability or adding an unused
  // binding or workflow does not make wrangler.jsonc undeployable, so
  // configProblems (used by `pnpm run check` and `pnpm run deploy`) omits
  // them while doctor still warns. This keeps the warning-vs-error split
  // explicit: doctor may fail when check passes.
  // Environments without their own `observability` inherit the top level;
  // an environment that overrides it must still enable it. Likewise, an
  // environment without its own `durable_objects.bindings` or `workflows`
  // inherits the top level; an environment that overrides either is warned
  // per env.
  for (const problem of observabilityWarnings(config)) findings.push(problem);
  for (const warning of durableObjectWarnings(config)) findings.push(warning);
  for (const warning of workflowWarnings(config)) findings.push(warning);

  if (findings.length) {
    console.error("doctor found issues:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  // When `manifest` is undefined the failure was already recorded above, so
  // `findings` is non-empty and this function has returned. The non-null
  // assertion documents that invariant for the success path.
  console.log(
    `doctor: ${config.name} is compatible with cf-nix-cache@${manifest!.version}`,
  );
  console.log(
    "doctor: package version, secrets, R2 binding, lifecycle configuration, CPU limit, workflow and durable binding, observability, and config schema checks passed",
  );
}
