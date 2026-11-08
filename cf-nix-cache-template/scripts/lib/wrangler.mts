import { command, type CommandResult } from "./process.mts";
import { configPath } from "./paths.mts";

export function wrangler(
  args: string[],
  options: { input?: string; allowFailure?: boolean; quiet?: boolean } = {},
): Promise<CommandResult> {
  return command("wrangler", [...args, "--config", configPath], options);
}
