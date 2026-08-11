import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import standaloneCode from 'ajv/dist/standalone/index.js';
import type { Plugin, ViteDevServer } from 'vite';

const generatedFileHeader =
  '// GENERATED FROM schemas/*.json. Do not edit by hand.\n' +
  '// @ts-nocheck\n';

type JsonSchema = {
  readonly $id?: string;
  readonly $defs?: Readonly<Record<string, JsonSchema>>;
  readonly title?: string;
  readonly [key: string]: unknown;
};

type DiscoveredSchema = {
  readonly name: string;
  readonly typeName: string;
  readonly ref: string;
};

function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function readSchemas(schemaDirectory: string): readonly JsonSchema[] {
  return globSync('**/*.json', { cwd: schemaDirectory })
    .sort()
    .map(
      (file) =>
        JSON.parse(
          readFileSync(resolve(schemaDirectory, file), 'utf8'),
        ) as JsonSchema,
    );
}

function discoverSchemas(
  schemas: readonly JsonSchema[],
): readonly DiscoveredSchema[] {
  const discovered: DiscoveredSchema[] = [];
  for (const schema of schemas) {
    if (!schema.$id) throw new Error('every JSON Schema must define $id');
    const title = schema.title ?? basename(schema.$id, '.json');
    const exportedTitle = title.replace(/^cf-nix-cache\s+/iu, '');
    discovered.push({
      name: `${pascalCase(exportedTitle)}Schema`,
      typeName: pascalCase(title),
      ref: schema.$id,
    });
    for (const [key] of Object.entries(schema.$defs ?? {})) {
      discovered.push({
        name: `${pascalCase(key)}Schema`,
        typeName: pascalCase(key),
        ref: `${schema.$id}#/$defs/${key}`,
      });
    }
  }
  const names = new Set<string>();
  for (const schema of discovered) {
    if (names.has(schema.name))
      throw new Error(`duplicate generated schema export: ${schema.name}`);
    names.add(schema.name);
  }
  return discovered;
}

function generateModule(schemaDirectory: string): string {
  const schemas = readSchemas(schemaDirectory);
  const discovered = discoverSchemas(schemas);

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
    code: { esm: true, source: true },
  });
  for (const schema of schemas) ajv.addSchema(schema);

  const validatorRefs = Object.fromEntries(
    discovered.map(({ name, ref }) => [name, ref]),
  );
  const validators = standaloneCode(ajv, validatorRefs);
  const descriptors = discovered
    .map(
      ({ name, ref, typeName }) =>
        `export const ${name} = {\n` +
        `  ref: ${JSON.stringify(ref)},\n` +
        `  validate: ${name}Validator as ContractSchema<${typeName}>['validate'],\n` +
        `} satisfies ContractSchema<${typeName}>;`,
    )
    .join('\n');

  const esmValidators = validators.replace(
    'const func1 = require("ajv/dist/runtime/ucs2length").default;',
    'const func1 = (value) => Array.from(value).length;',
  );
  const renamedValidators = esmValidators.replace(
    /export const ([A-Za-z0-9_$]+)\s*=/g,
    'const $1Validator =',
  );
  return (
    `${generatedFileHeader}\n` +
    `import type { ContractSchema } from '../contracts';\n` +
    `import type { ${[...new Set(discovered.map(({ typeName }) => typeName))].join(', ')} } from './contracts';\n\n` +
    `${renamedValidators}\n${descriptors}\n`
  );
}

export function writeJsonContracts(
  schemaDirectory = resolve(import.meta.dirname, '../../../schemas'),
  outputFile = resolve(
    import.meta.dirname,
    '../src/generated/json-contracts.ts',
  ),
): boolean {
  const generated = generateModule(schemaDirectory);
  if (existsSync(outputFile) && readFileSync(outputFile, 'utf8') === generated)
    return false;
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, generated);
  return true;
}

export function jsonContracts(
  schemaDirectory = resolve(import.meta.dirname, '../../../schemas'),
  outputFile = resolve(
    import.meta.dirname,
    '../src/generated/json-contracts.ts',
  ),
): Plugin {
  const schemaPath = resolve(schemaDirectory);
  const isSchemaFile = (file: string): boolean =>
    resolve(file).startsWith(`${schemaPath}/`) && file.endsWith('.json');
  const regenerate = (): boolean =>
    writeJsonContracts(schemaDirectory, outputFile);

  return {
    name: 'cf-nix-cache-json-contracts',
    buildStart() {
      regenerate();
      for (const file of globSync('**/*.json', { cwd: schemaDirectory }))
        this.addWatchFile(resolve(schemaDirectory, file));
    },
    configureServer(server: ViteDevServer) {
      const onSchemaChange = (file: string): void => {
        if (!isSchemaFile(file) || !regenerate()) return;
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('add', onSchemaChange);
      server.watcher.on('change', onSchemaChange);
      server.watcher.on('unlink', onSchemaChange);
      server.httpServer?.once('close', () => {
        server.watcher.off('add', onSchemaChange);
        server.watcher.off('change', onSchemaChange);
        server.watcher.off('unlink', onSchemaChange);
      });
    },
  };
}
