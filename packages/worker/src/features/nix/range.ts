import type { ChunkRef } from '../../types';

export interface PlannedRange {
  chunk: ChunkRef;
  offset: number;
  length: number;
  output_offset: number;
}

export interface ByteRange {
  start: number;
  end: number;
}

export class RangeRequestError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function parseRange(
  value: string | null,
  size: number,
): ByteRange | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0)
    throw new RangeRequestError('invalid range');
  const suffix = !match[1] && Boolean(match[2]);
  const start = suffix
    ? Math.max(0, size - Number(match[2]))
    : Number(match[1]);
  const end = suffix || !match[2] ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    throw new RangeRequestError('range not satisfiable');
  return { start, end: Math.min(end, size - 1) };
}

export function planRange(
  chunks: ChunkRef[],
  range: ByteRange | null,
): PlannedRange[] {
  const start = range?.start ?? 0;
  const end =
    range?.end ??
    chunks.reduce((total, chunk) => total + chunk.compressed_size, 0) - 1;
  let cursor = 0;
  const plan: PlannedRange[] = [];
  for (const chunk of chunks) {
    const chunkStart = cursor;
    const chunkEnd = cursor + chunk.compressed_size - 1;
    const overlapStart = Math.max(start, chunkStart);
    const overlapEnd = Math.min(end, chunkEnd);
    if (overlapStart <= overlapEnd) {
      plan.push({
        chunk,
        offset: overlapStart - chunkStart,
        length: overlapEnd - overlapStart + 1,
        output_offset: overlapStart - start,
      });
    }
    cursor += chunk.compressed_size;
  }
  return plan;
}
