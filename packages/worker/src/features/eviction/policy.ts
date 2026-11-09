// When a cache passes HIGH_WATERMARK of its quota, an eviction run removes
// least recently used paths until it is back under TARGET. The gap is what
// pushes fill while a run is under way, so a push never waits for one.
const HIGH_WATERMARK = 0.9;
const TARGET = 0.8;
export const DEFAULT_MIN_AGE_DAYS = 30;
export const DAY_SECONDS = 24 * 60 * 60;
export const HOUR_SECONDS = 60 * 60;

export function overHighWatermark(logical: number, quota: number): boolean {
  return logical > quota * HIGH_WATERMARK;
}

export function bytesToFree(logical: number, quota: number): number {
  return Math.max(0, Math.ceil(logical - quota * TARGET));
}

// The cutoff that frees at least `target` bytes, from the bytes of evictable
// paths by hour of last use. Paths used at or after the cutoff stay. If all
// of them together are not enough, everything evictable goes and the floor is
// reached.
export function cutoffFor(
  buckets: Iterable<readonly [hour: number, bytes: number]>,
  target: number,
  floor: number,
): { cutoff: number | null; floor_reached: boolean } {
  if (target <= 0) return { cutoff: null, floor_reached: false };
  const byHour = new Map<number, number>();
  for (const [hour, bytes] of buckets)
    byHour.set(hour, (byHour.get(hour) ?? 0) + bytes);
  let freed = 0;
  for (const hour of [...byHour.keys()].sort((a, b) => a - b)) {
    freed += byHour.get(hour)!;
    const cutoff = (hour + 1) * HOUR_SECONDS;
    if (freed >= target && cutoff <= floor)
      return { cutoff, floor_reached: false };
  }
  return { cutoff: freed > 0 ? floor : null, floor_reached: true };
}

// Years of history would be too many hours for one step output, so past
// MAX_BUCKETS the oldest buckets are coarsened to days. Each is filed under
// the day's last hour, so a cutoff at it frees at least the bytes counted.
const MAX_BUCKETS = 20_000;

export function mergeBuckets(
  buckets: readonly (readonly [number, number])[],
): [number, number][] {
  const byHour = new Map<number, number>();
  for (const [hour, bytes] of buckets)
    byHour.set(hour, (byHour.get(hour) ?? 0) + bytes);
  const merged = [...byHour].sort(([left], [right]) => left - right);
  if (merged.length <= MAX_BUCKETS) return merged;
  const recent = merged.slice(-MAX_BUCKETS / 2);
  const byDay = new Map<number, number>();
  for (const [hour, bytes] of merged.slice(0, -MAX_BUCKETS / 2)) {
    const day = Math.floor(hour / 24) * 24 + 23;
    byDay.set(day, (byDay.get(day) ?? 0) + bytes);
  }
  return [...byDay, ...recent];
}
