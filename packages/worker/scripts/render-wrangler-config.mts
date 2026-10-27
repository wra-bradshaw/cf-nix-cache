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
type ContainerConfig = {
  class_name?: string;
  images?: {
    processor?: { dockerfile?: string; build_vars?: Record<string, string> };
  };
};
const config = parse(source, errors, { allowTrailingComma: true }) as {
  containers?: ContainerConfig[];
  env?: Record<string, { containers?: ContainerConfig[] }>;
};

if (errors.length > 0) {
  throw new Error(
    `could not parse ${input}: ${errors
      .map((error) => printParseErrorCode(error.error))
      .join(', ')}`,
  );
}

// The Dockerfile takes the base image as the PROCESSOR_IMAGE build argument.
function replaceProcessorImage(
  containerConfig: ContainerConfig[] | undefined,
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
  const processorImage = processorContainers[0].images?.processor;
  if (!processorImage?.dockerfile) {
    throw new Error(
      `${location}.containers ProcessorContainer must build images.processor from a dockerfile`,
    );
  }
  processorImage.build_vars = {
    ...processorImage.build_vars,
    PROCESSOR_IMAGE: image,
  };
}

replaceProcessorImage(config.containers, 'top-level');
for (const [environment, values] of Object.entries(config.env ?? {})) {
  if (values.containers !== undefined) {
    replaceProcessorImage(values.containers, `env.${environment}`);
  }
}

await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
