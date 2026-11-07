import { describe, expect, it } from 'vitest';
import { InvalidNarError, NarValidator } from './nar-validator';

const encoder = new TextEncoder();

/** Serializes NAR tokens; strings and byte arrays are length-prefixed. */
function nar(...fields: (string | Uint8Array)[]): Uint8Array {
  const parts: number[] = [];
  for (const field of fields) {
    const bytes = typeof field === 'string' ? encoder.encode(field) : field;
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length), true);
    parts.push(
      ...length,
      ...bytes,
      ...new Array((8 - (bytes.length % 8)) % 8).fill(0),
    );
  }
  return new Uint8Array(parts);
}

const file = (contents: string, executable = false) => [
  '(',
  'type',
  'regular',
  ...(executable ? ['executable', ''] : []),
  'contents',
  contents,
  ')',
];

const entry = (name: string, node: string[]) => [
  'entry',
  '(',
  'name',
  name,
  'node',
  ...node,
  ')',
];

const tree = nar(
  'nix-archive-1',
  '(',
  'type',
  'directory',
  ...entry('bin', [
    '(',
    'type',
    'directory',
    ...entry('hello', file('#!/bin/sh\necho hi\n', true)),
    ')',
  ]),
  ...entry('link', ['(', 'type', 'symlink', 'target', 'bin/hello', ')']),
  ...entry('share', file('')),
  ')',
);

function validate(bytes: Uint8Array, split = bytes.length): void {
  const validator = new NarValidator();
  for (let offset = 0; offset < bytes.length; offset += split)
    validator.push(bytes.subarray(offset, offset + split));
  validator.finish();
}

describe('NAR validation', () => {
  it('accepts files, executables, symlinks and directories in any split', () => {
    for (const split of [1, 3, 8, 13, tree.length]) validate(tree, split);
    validate(nar('nix-archive-1', ...file('hello')));
  });

  it('rejects truncated archives and trailing bytes', () => {
    expect(() => validate(tree.subarray(0, tree.length - 8))).toThrow(
      'truncated',
    );
    expect(() =>
      validate(new Uint8Array([...tree, ...new Uint8Array(8)])),
    ).toThrow('trailing');
  });

  it('rejects unsorted or invalid entry names', () => {
    const unsorted = nar(
      'nix-archive-1',
      '(',
      'type',
      'directory',
      ...entry('b', file('')),
      ...entry('a', file('')),
      ')',
    );
    expect(() => validate(unsorted)).toThrow('not sorted');
    for (const name of ['', '.', '..', 'a/b'])
      expect(() =>
        validate(
          nar(
            'nix-archive-1',
            '(',
            'type',
            'directory',
            ...entry(name, file('')),
            ')',
          ),
        ),
      ).toThrow(InvalidNarError);
  });

  it('rejects non-zero padding and unknown tokens', () => {
    const padded = nar('nix-archive-1', ...file('abc'));
    // The byte after "abc" is padding.
    const index = padded.lastIndexOf(0x63) + 1;
    padded[index] = 1;
    expect(() => validate(padded)).toThrow('padding');
    expect(() => validate(nar('nix-archive-2', ...file('')))).toThrow(
      InvalidNarError,
    );
    expect(() =>
      validate(nar('nix-archive-1', '(', 'type', 'fifo', ')')),
    ).toThrow('unknown NAR node type');
  });
});
