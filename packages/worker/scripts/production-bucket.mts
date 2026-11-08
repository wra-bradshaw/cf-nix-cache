// Prints the production CACHE_BUCKET name from a Wrangler JSONC config, so the
// deploy app (nix/apps.nix) cannot drift from the Worker binding. A real JSONC
// parser handles comment markers inside strings, such as "cache.example.com/*".
import { readFile } from 'node:fs/promises';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

const input = process.argv[2];
if (!input) throw new Error('usage: production-bucket.mts <wrangler.jsonc>');

const errors: ParseError[] = [];
const config = parse(await readFile(input, 'utf8'), errors, {
  allowTrailingComma: true,
}) as {
  env?: {
    production?: {
      r2_buckets?: { binding?: string; bucket_name?: string }[];
    };
  };
};
if (errors.length > 0) {
  throw new Error(
    `could not parse ${input}: ${errors
      .map((error) => printParseErrorCode(error.error))
      .join(', ')}`,
  );
}

const bucket = config.env?.production?.r2_buckets?.find(
  (binding) => binding.binding === 'CACHE_BUCKET',
)?.bucket_name;
if (!bucket) {
  console.error(`CACHE_BUCKET is not configured in env.production of ${input}`);
  process.exit(1);
}
process.stdout.write(bucket);
