/**
 * Streaming structural validation of a NAR, the check the processor makes with
 * `nix-nar` (verification level 3). Bytes are pushed in any split; file
 * contents are skipped without being buffered.
 */

const MAX_TOKEN_BYTES = 4096;
const MAX_NAME_BYTES = 255;
const MAX_DEPTH = 256;

type Need = { kind: 'read'; n: number } | { kind: 'skip'; n: number };
type Parser = Generator<Need, void, Uint8Array>;

export class InvalidNarError extends Error {}

const decoder = new TextDecoder();
const fail = (message: string): never => {
  throw new InvalidNarError(message);
};

function* readU64(): Generator<Need, number, Uint8Array> {
  const bytes = yield { kind: 'read', n: 8 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const value = view.getBigUint64(0, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('NAR length is too large');
  return Number(value);
}

function* readPadding(length: number): Generator<Need, void, Uint8Array> {
  const padding = (8 - (length % 8)) % 8;
  if (padding === 0) return;
  const bytes = yield { kind: 'read', n: padding };
  if (bytes.some((byte) => byte !== 0)) fail('NAR padding is not zero');
}

function* readBytes(max: number): Generator<Need, Uint8Array, Uint8Array> {
  const length = yield* readU64();
  if (length > max) fail('NAR string is too long');
  const bytes =
    length === 0 ? new Uint8Array() : yield { kind: 'read', n: length };
  yield* readPadding(length);
  return bytes;
}

function* readToken(): Generator<Need, string, Uint8Array> {
  return decoder.decode(yield* readBytes(MAX_TOKEN_BYTES));
}

function* expect(token: string): Generator<Need, void, Uint8Array> {
  const found = yield* readToken();
  if (found !== token) fail(`expected NAR token "${token}"`);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}

function validName(name: Uint8Array): boolean {
  if (name.length === 0) return false;
  if (name.includes(0) || name.includes(0x2f)) return false;
  const text = decoder.decode(name);
  return text !== '.' && text !== '..';
}

function* parseNode(depth: number): Parser {
  if (depth > MAX_DEPTH) fail('NAR is nested too deeply');
  yield* expect('(');
  yield* expect('type');
  const type = yield* readToken();
  if (type === 'regular') {
    let token = yield* readToken();
    if (token === 'executable') {
      if ((yield* readBytes(0)).length !== 0) fail('invalid executable flag');
      token = yield* readToken();
    }
    if (token !== 'contents') fail('expected NAR file contents');
    const length = yield* readU64();
    if (length > 0) yield { kind: 'skip', n: length };
    yield* readPadding(length);
    yield* expect(')');
  } else if (type === 'symlink') {
    yield* expect('target');
    if ((yield* readBytes(MAX_TOKEN_BYTES)).length === 0)
      fail('empty symlink target');
    yield* expect(')');
  } else if (type === 'directory') {
    let previous: Uint8Array | null = null;
    for (;;) {
      const token = yield* readToken();
      if (token === ')') break;
      if (token !== 'entry') fail('expected NAR directory entry');
      yield* expect('(');
      yield* expect('name');
      const name = yield* readBytes(MAX_NAME_BYTES);
      if (!validName(name)) fail('invalid NAR entry name');
      if (previous && compareBytes(previous, name) >= 0)
        fail('NAR directory entries are not sorted');
      previous = name;
      yield* expect('node');
      yield* parseNode(depth + 1);
      yield* expect(')');
    }
  } else fail(`unknown NAR node type "${type}"`);
}

function* parseNar(): Parser {
  yield* expect('nix-archive-1');
  yield* parseNode(0);
}

export class NarValidator {
  private readonly parser = parseNar();
  private need: Need | undefined;
  private parts: Uint8Array[] = [];
  private buffered = 0;

  constructor() {
    this.advance(new Uint8Array());
  }

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      const need = this.need;
      if (!need) fail('trailing bytes after NAR archive');
      if (need!.kind === 'skip') {
        const take = Math.min(need!.n, chunk.length - offset);
        need!.n -= take;
        offset += take;
        if (need!.n === 0) this.advance(new Uint8Array());
        continue;
      }
      const take = Math.min(need!.n - this.buffered, chunk.length - offset);
      // Copied, because the caller may reuse its buffer.
      this.parts.push(chunk.slice(offset, offset + take));
      this.buffered += take;
      offset += take;
      if (this.buffered === need!.n) {
        const bytes = concat(this.parts, this.buffered);
        this.parts = [];
        this.buffered = 0;
        this.advance(bytes);
      }
    }
  }

  finish(): void {
    if (this.need) fail('NAR archive is truncated');
  }

  private advance(value: Uint8Array): void {
    let input = value;
    for (;;) {
      const next = this.parser.next(input);
      if (next.done) {
        this.need = undefined;
        return;
      }
      if (next.value.n > 0) {
        this.need = next.value;
        return;
      }
      input = new Uint8Array();
    }
  }
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
