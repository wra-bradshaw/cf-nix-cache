import {
  configProblems,
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
  for (const problem of configProblems(config)) findings.push(problem);
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

  for (const problem of observabilityWarnings(config)) findings.push(problem);
  for (const warning of durableObjectWarnings(config)) findings.push(warning);
  for (const warning of workflowWarnings(config)) findings.push(warning);

  if (findings.length) {
    console.error("doctor found issues:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `doctor: ${config.name} is compatible with cf-nix-cache@${manifest!.version}`,
  );
  console.log(
    "doctor: package version, secrets, R2 binding, lifecycle configuration, CPU limit, workflow and durable binding, observability, and config schema checks passed",
  );
}
