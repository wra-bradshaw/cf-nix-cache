import { describe, expect, it } from 'vitest';
import { parseRange, planRange, RangeRequestError } from './range';

const chunks = [
  {
    raw_hash: 'a',
    raw_size: 1,
    compressed_hash: 'a',
    compressed_size: 5,
    key: 'a',
  },
  {
    raw_hash: 'b',
    raw_size: 1,
    compressed_hash: 'b',
    compressed_size: 7,
    key: 'b',
  },
  {
    raw_hash: 'c',
    raw_size: 1,
    compressed_hash: 'c',
    compressed_size: 3,
    key: 'c',
  },
];

describe('compressed range planning', () => {
  it('plans a range crossing chunk boundaries', () => {
    expect(planRange(chunks, { start: 3, end: 9 })).toEqual([
      { chunk: chunks[0], offset: 3, length: 2, output_offset: 0 },
      { chunk: chunks[1], offset: 0, length: 5, output_offset: 2 },
    ]);
  });

  it('handles suffix ranges', () => {
    expect(parseRange('bytes=-4', 15)).toEqual({ start: 11, end: 14 });
  });

  it('rejects multi-range requests', () => {
    expect(() => parseRange('bytes=0-1,4-5', 10)).toThrow(RangeRequestError);
  });
});
