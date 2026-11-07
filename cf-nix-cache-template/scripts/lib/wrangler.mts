import { command, type CommandResult } from "./process.mts";
import { configPath } from "./paths.mts";

function wranglerArgs(args: string[], config = configPath): string[] {
  return [...args, "--config", config];
}

export function wrangler(
  args: string[],
  options: { input?: string; allowFailure?: boolean; quiet?: boolean } = {},
  config = configPath,
): Promise<CommandResult> {
  return command("wrangler", wranglerArgs(args, config), options);
}
