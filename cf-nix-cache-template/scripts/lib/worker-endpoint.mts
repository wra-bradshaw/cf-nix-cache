import { fail } from "./fail.mts";

export function workerUrl(deploymentOutput = ""): string | undefined {
  const configured = process.env.CF_NIX_CACHE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  // A workers.dev hostname contains the account subdomain, which only the
  // deployment output (or the operator, via CF_NIX_CACHE_URL) knows.
  return deploymentOutput.match(/https:\/\/[^\s'"`]+\.workers\.dev/)?.[0];
}

export async function healthCheck(url: string | undefined): Promise<void> {
  if (!url || process.env.CF_NIX_CACHE_SKIP_HEALTHCHECK === "1") return;
  const response = await fetch(`${url.replace(/\/$/, "")}/health`);
  if (!response.ok)
    fail(`Worker health check failed with HTTP ${response.status}`);
}

export function bootstrapCommand(url: string): string {
  return `curl -fsS '${url.replace(/\/$/, "")}/api/bootstrap' \\
  -H 'content-type: application/json' \\
  -H "Idempotency-Key: first-admin-$(date +%s)" \\
  --data @- <<EOF
{"subject":"admin","valid_for_seconds":31536000,"grants":[{"cache":"*","role":"admin"}],"secret":"$CF_NIX_CACHE_BOOTSTRAP_SECRET"}
EOF`;
}
