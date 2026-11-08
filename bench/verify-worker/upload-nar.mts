/**
 * Uploads a NAR to the bench Worker for timing `/verify`.
 *
 *   node upload-nar.mts <worker-url> <name> /nix/store/<path>
 *   node upload-nar.mts <worker-url> <name> synthetic:<MiB>
 *   node upload-nar.mts <worker-url> <name> repetitive:<MiB>
 *
 * Chunks are cut at fixed 4 MiB; verification cost is the same.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setDefaultAutoSelectFamily } from 'node:net';
import { constants, zstdCompressSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
// Single cross-crate gate: fails on joint drift that per-crate tests miss.
const isDriftCheck = args.includes('--check-drift');
const positional = args.filter((arg) => arg !== '--check-drift');
const [base, name, source] = positional;
const token = process.env.BENCH_TOKEN;
if (isDriftCheck && positional.length > 0)
  throw new Error('--check-drift takes no other arguments');
if (isDriftCheck) {
} else if (!base || !name || !source || !token)
  throw new Error(
    'usage: BENCH_TOKEN=... node upload-nar.mts <url> <name> <path|synthetic:MiB>',
  );

// Happy-eyeballs' 250 ms attempts time out under parallel uploads.
setDefaultAutoSelectFamily(false);

const ENCODING_ID = 'fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1';
const CHUNK = 4 * 1024 * 1024;
const ZSTD_LEVEL = 3;
// Standalone copy of the canonical encoding parameters; drift-checked below.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const protocol = readFileSync(
  join(repoRoot, 'crates/cli/src/protocol/mod.rs'),
  'utf8',
);
const verifyLib = readFileSync(
  join(repoRoot, 'crates/verify/src/lib.rs'),
  'utf8',
);
const encodingTs = readFileSync(
  join(repoRoot, 'packages/worker/src/features/uploads/encoding.ts'),
  'utf8',
);
const verifierTs = readFileSync(
  join(repoRoot, 'packages/worker/src/features/uploads/verifier.ts'),
  'utf8',
);
const cacheTypes = readFileSync(
  join(repoRoot, 'packages/worker/src/features/cache/types.ts'),
  'utf8',
);
const matchOne = (source: string, pattern: RegExp, label: string) => {
  const found = source.match(pattern);
  if (!found) throw new Error(`${label} drifted: ${pattern}`);
  return found;
};
const productOf = (found: RegExpMatchArray): number =>
  found
    .slice(1)
    .map(Number)
    .reduce((a, b) => a * b, 1);
const driftString = (
  source: string,
  pattern: RegExp,
  label: string,
  want: string,
) => {
  const found = matchOne(source, pattern, label);
  if (found[1] !== want)
    throw new Error(`${label} drifted: want ${want}, found ${found[1]}`);
};
driftString(
  protocol,
  /ENCODING_ID:\s*&str\s*=\s*"([^"]+)"/,
  'ENCODING_ID in protocol/mod.rs',
  ENCODING_ID,
);
driftString(
  cacheTypes,
  /ENCODING_ID\s*=\s*'([^']+)'/,
  'ENCODING_ID in types.ts',
  ENCODING_ID,
);
if (CHUNK !== 4 * 1024 * 1024)
  throw new Error(
    `CHUNK drifted: want 4194304 (4 MiB, the required CHUNK_AVG_SIZE), found ${CHUNK}`,
  );
for (const [label, pattern, want] of [
  [
    'CHUNK_MIN_SIZE',
    /CHUNK_MIN_SIZE:\s*usize\s*=\s*(\d+)\s*\*\s*(\d+)/,
    1 * 1024 * 1024,
  ],
  [
    'CHUNK_AVG_SIZE',
    /CHUNK_AVG_SIZE:\s*usize\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/,
    CHUNK,
  ],
  [
    'CHUNK_MAX_SIZE',
    /CHUNK_MAX_SIZE:\s*usize\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/,
    16 * 1024 * 1024,
  ],
] as const) {
  const found = matchOne(
    protocol,
    pattern,
    `canonical encoding parameter ${label}`,
  );
  if (productOf(found) !== want)
    throw new Error(
      `canonical encoding parameter ${label} drifted: want ${want}, found ${found.slice(1).join(' * ')}`,
    );
}
driftString(
  protocol,
  /ZSTD_LEVEL:\s*i32\s*=\s*(\d+)/,
  'ZSTD_LEVEL',
  String(ZSTD_LEVEL),
);
for (const [sourceText, pattern, label, want] of [
  [
    verifyLib,
    /CHUNK_MAX_RAW_SIZE:\s*usize\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/,
    'CHUNK_MAX_RAW_SIZE in crates/verify/src/lib.rs',
    16 * 1024 * 1024,
  ],
  [
    verifyLib,
    /CHUNK_MAX_COMPRESSED_SIZE:\s*usize\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/,
    'CHUNK_MAX_COMPRESSED_SIZE in crates/verify/src/lib.rs',
    17 * 1024 * 1024,
  ],
  [
    encodingTs,
    /CHUNK_MAX_RAW_SIZE\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/,
    'CHUNK_MAX_RAW_SIZE in encoding.ts',
    16 * 1024 * 1024,
  ],
  [
    encodingTs,
    /CHUNK_MAX_COMPRESSED_SIZE\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/,
    'CHUNK_MAX_COMPRESSED_SIZE in encoding.ts',
    17 * 1024 * 1024,
  ],
  [
    verifierTs,
    /CHUNK_MAX_RAW_SIZE\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/,
    'CHUNK_MAX_RAW_SIZE in verifier.ts',
    16 * 1024 * 1024,
  ],
  [
    verifierTs,
    /CHUNK_MAX_COMPRESSED_SIZE\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/,
    'CHUNK_MAX_COMPRESSED_SIZE in verifier.ts',
    17 * 1024 * 1024,
  ],
] as const) {
  const found = matchOne(sourceText, pattern, label);
  if (productOf(found) !== want)
    throw new Error(
      `${label} drifted: want ${want}, found ${found.slice(1).join(' * ')}`,
    );
}
if (isDriftCheck) {
  console.log('encoding constants in sync');
  process.exit(0);
}
if (!base || !name || !source || !token)
  throw new Error(
    'usage: BENCH_TOKEN=... node upload-nar.mts <url> <name> <path|synthetic:MiB>',
  );
const NIX_BASE32 = '0123456789abcdfghijklmnpqrsvwxyz';

function nixBase32(bytes: Uint8Array): string {
  const length = Math.ceil((bytes.length * 8) / 5);
  let out = '';
  for (let n = length - 1; n >= 0; n -= 1) {
    const bit = n * 5;
    const index = Math.floor(bit / 8);
    const offset = bit % 8;
    const value =
      (bytes[index]! >> offset) |
      (index + 1 < bytes.length ? bytes[index + 1]! << (8 - offset) : 0);
    out += NIX_BASE32[value & 0x1f];
  }
  return out;
}
const sha256Nix = (bytes: Uint8Array) =>
  `sha256:${nixBase32(createHash('sha256').update(bytes).digest())}`;

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}
function str(value: string | Buffer): Buffer[] {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return [u64(bytes.length), bytes, Buffer.alloc((8 - (bytes.length % 8)) % 8)];
}

function* syntheticNar(mib: number, repetitive = false): Generator<Buffer> {
  const words =
    'the of and to in is was for on that with as by at from this be are or an have not which it'.split(
      ' ',
    );
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const text = (size: number) => {
    let out = '';
    while (out.length < size)
      out += `${words[Math.floor(random() * words.length)]}${random() < 0.1 ? '\n' : ' '}${random() < 0.12 ? Math.floor(random() * 2 ** 30).toString(36) : Math.floor(random() * 100)} `;
    return Buffer.from(out.slice(0, size));
  };
  // Repetitive NARs reuse 64 bodies: cheap to upload, costly to decode.
  const pool = Array.from({ length: 64 }, () =>
    text(512 + Math.floor(random() * 3584)),
  );
  const files = 1000;
  const dirs = Math.ceil((mib * 1024 * 1024) / (files * 2304));
  yield* ['nix-archive-1', '(', 'type', 'directory'].flatMap(str);
  for (let d = 0; d < dirs; d += 1) {
    yield* [
      'entry',
      '(',
      'name',
      `d${String(d).padStart(6, '0')}`,
      'node',
      '(',
      'type',
      'directory',
    ].flatMap(str);
    for (let f = 0; f < files; f += 1) {
      const body = repetitive
        ? pool[Math.floor(random() * pool.length)]!
        : text(512 + Math.floor(random() * 3584));
      yield* [
        'entry',
        '(',
        'name',
        `f${String(f).padStart(4, '0')}`,
        'node',
        '(',
        'type',
        'regular',
        'contents',
      ].flatMap(str);
      yield* str(body);
      yield* [')', ')'].flatMap(str);
    }
    yield* [')', ')'].flatMap(str);
  }
  yield* str(')');
}

async function* dumpNar(path: string): AsyncGenerator<Buffer> {
  const child = spawn('nix-store', ['--dump', path], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  for await (const data of child.stdout) yield data as Buffer;
}

async function put(key: string, body: Uint8Array): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${base}/put?key=${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}` },
      body,
    }).catch((error: unknown) => error as Error);
    if (!(response instanceof Error) && response.ok) return;
    if (attempt === 4)
      throw new Error(`upload of ${key} failed`, {
        cause: response instanceof Error ? response : response.status,
      });
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

const narHash = createHash('sha256');
const chunks: { raw_hash: string; raw_size: number; key: string }[] = [];
const pending = new Set<Promise<void>>();
let narSize = 0;
let compressedSize = 0;

async function emit(raw: Buffer): Promise<void> {
  const rawHash = sha256Nix(raw);
  const key = `chunks/${ENCODING_ID}/${rawHash}.zst`;
  const compressed = zstdCompressSync(raw, {
    params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
  });
  compressedSize += compressed.length;
  chunks.push({ raw_hash: rawHash, raw_size: raw.length, key });
  const upload = put(key, compressed).finally(() => pending.delete(upload));
  pending.add(upload);
  if (pending.size >= 8) await Promise.race(pending);
}

let buffer: Buffer[] = [];
let buffered = 0;
const [kind, size] = source.split(':');
const input =
  kind === 'synthetic' || kind === 'repetitive'
    ? syntheticNar(Number(size), kind === 'repetitive')
    : dumpNar(source);
for await (const part of input) {
  narHash.update(part);
  narSize += part.length;
  buffer.push(part);
  buffered += part.length;
  while (buffered >= CHUNK) {
    const all = Buffer.concat(buffer);
    await emit(all.subarray(0, CHUNK));
    buffer = [all.subarray(CHUNK)];
    buffered = all.length - CHUNK;
  }
}
if (buffered > 0) await emit(Buffer.concat(buffer));
await Promise.all(pending);

const manifest = {
  encoding_id: ENCODING_ID,
  nar_hash: `sha256:${nixBase32(narHash.digest())}`,
  nar_size: narSize,
  chunks,
};
await put(`bench/${name}.json`, Buffer.from(JSON.stringify(manifest)));
console.log(
  JSON.stringify({
    name,
    nar_size: narSize,
    compressed: compressedSize,
    chunks: chunks.length,
  }),
);
