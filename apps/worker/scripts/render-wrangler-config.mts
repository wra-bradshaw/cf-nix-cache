import { readFile, writeFile } from 'node:fs/promises';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`missing ${name}`);
  }
  return process.argv[index + 1];
}

const input = option('--input');
const output = option('--output');
const image = option('--image');
const source = await readFile(input, 'utf8');
const errors: ParseError[] = [];
const config = parse(source, errors, { allowTrailingComma: true }) as {
  containers?: Array<{ class_name?: string; image?: string }>;
  env?: Record<
    string,
    { containers?: Array<{ class_name?: string; image?: string }> }
  >;
};

if (errors.length > 0) {
  throw new Error(
    `could not parse ${input}: ${errors
      .map((error) => printParseErrorCode(error.error))
      .join(', ')}`,
  );
}

function replaceProcessorImage(
  containerConfig: Array<{ class_name?: string; image?: string }> | undefined,
  location: string,
): void {
  if (!Array.isArray(containerConfig)) {
    throw new Error(`${location}.containers must be an array`);
  }
  const processorContainers = containerConfig.filter(
    (container) => container.class_name === 'ProcessorContainer',
  );
  if (processorContainers.length !== 1) {
    throw new Error(
      `${location}.containers must contain exactly one ProcessorContainer`,
    );
  }
  processorContainers[0].image = image;
}

replaceProcessorImage(config.containers, 'top-level');
for (const [environment, values] of Object.entries(config.env ?? {})) {
  if (values.containers !== undefined) {
    replaceProcessorImage(values.containers, `env.${environment}`);
  }
}

await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
