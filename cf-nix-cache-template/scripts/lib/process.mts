import { spawn } from "node:child_process";
import { templateDirectory } from "./paths.mts";

export type CommandResult = { status: number; stdout: string; stderr: string };

export async function command(
  executable: string,
  args: string[],
  options: { input?: string; allowFailure?: boolean; quiet?: boolean } = {},
): Promise<CommandResult> {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: templateDirectory,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!options.quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({ status: status ?? 1, stdout, stderr }),
    );
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
  return result;
}
