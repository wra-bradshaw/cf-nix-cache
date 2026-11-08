import { processorContainers, readConfig } from "./lib/config.mts";
import { configPath } from "./lib/paths.mts";
import { bucketExists, bucketName, lifecycleIsConfigured } from "./lib/r2.mts";
import { installedPackageVersion, releaseImage } from "./lib/release.mts";
import {
  missingSecrets,
  secretNamesFromWrangler,
  secretState,
} from "./lib/secrets.mts";
import { wrangler } from "./lib/wrangler.mts";

export async function doctor(): Promise<void> {
  const config = await readConfig();
  const { manifest, image } = await releaseImage();
  const findings: string[] = [];
  if ((await installedPackageVersion()) !== manifest.version)
    findings.push(
      "installed Worker package and release manifest versions differ",
    );
  try {
    const names = await secretNamesFromWrangler(configPath);
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

  try {
    const bucket = bucketName(config);
    if (!(await bucketExists(bucket, configPath)))
      findings.push(
        `R2 bucket ${bucket} is not listed by \`wrangler r2 bucket list\` for this account`,
      );
    const lifecycle = await lifecycleIsConfigured(bucket, configPath);
    if (lifecycle === false)
      findings.push("the R2 staging lifecycle rule is missing");
    if (lifecycle === undefined)
      findings.push(
        "cannot verify R2 lifecycle rules; check Wrangler authentication",
      );
  } catch (error) {
    findings.push(
      error instanceof Error ? error.message : "could not inspect R2",
    );
  }

  const containerStatus = await wrangler(
    ["containers", "list"],
    { allowFailure: true, quiet: true },
    configPath,
  );
  if (containerStatus.status !== 0)
    findings.push(
      "could not inspect Container status (deploy once, then check Wrangler credentials and Container rollout)",
    );

  const containers = processorContainers(config);
  if (containers.length < 1)
    findings.push("ProcessorContainer binding is missing");
  if (config.observability?.enabled !== true)
    findings.push("observability.enabled should be true");
  if (config.vars?.CF_NIX_CACHE_CONFIG_SCHEMA !== "1")
    findings.push("CF_NIX_CACHE_CONFIG_SCHEMA must be 1");
  if (
    image !== manifest.processorImage &&
    !process.env.CF_NIX_CACHE_PROCESSOR_IMAGE
  )
    findings.push("rendered image does not match the package release manifest");
  if (manifest.platform !== "linux/amd64")
    findings.push("processor platform is not linux/amd64");

  if (findings.length) {
    console.error("doctor found issues:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `doctor: ${config.name} is compatible with cf-nix-cache@${manifest.version}`,
  );
  console.log(`doctor: processor ${image}`);
  console.log(
    "doctor: secrets, R2 binding, Container binding, lifecycle configuration, and schema checks passed",
  );
}
