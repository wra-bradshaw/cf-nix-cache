import path from "node:path";
import { fileURLToPath } from "node:url";

export const templateDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const configPath = path.join(templateDirectory, "wrangler.jsonc");
