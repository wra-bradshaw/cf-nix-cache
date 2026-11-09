import { describe, expect, it } from 'vitest';
import {
  DAY_SECONDS,
  HOUR_SECONDS,
  bytesToFree,
  cutoffFor,
  mergeBuckets,
  overHighWatermark,
} from './policy';

const hour = (timestamp: number) => Math.floor(timestamp / HOUR_SECONDS);

describe('the eviction cutoff', () => {
  it('needs no cutoff when there is nothing to free', () => {
    expect(cutoffFor([[hour(1000), 500]], 0, 1000)).toEqual({
      cutoff: null,
      floor_reached: false,
    });
  });

  it('frees at least the target from the oldest hours', () => {
    const oldHour = hour(1000);
    const buckets: [number, number][] = [
      [oldHour, 100],
      [oldHour + 1, 100],
      [oldHour + 2, 100],
    ];
    const floor = (oldHour + 10) * HOUR_SECONDS;
    expect(cutoffFor(buckets, 150, floor)).toEqual({
      cutoff: (oldHour + 2) * HOUR_SECONDS,
      floor_reached: false,
    });
  });

  it('never cuts later than the floor', () => {
    const floor = 30 * DAY_SECONDS;
    const buckets: [number, number][] = [[hour(floor) + 5, 10_000]];
    expect(cutoffFor(buckets, 100, floor)).toEqual({
      cutoff: floor,
      floor_reached: true,
    });
  });

  it('reaches the floor when nothing evictable frees enough', () => {
    const floor = 30 * DAY_SECONDS;
    const buckets: [number, number][] = [
      [hour(floor) - 2, 100],
      [hour(floor) - 1, 100],
    ];
    expect(cutoffFor(buckets, 10_000, floor)).toEqual({
      cutoff: floor,
      floor_reached: true,
    });
  });

  it('reports the floor as reached when nothing is evictable', () => {
    expect(cutoffFor([], 100, 1000)).toEqual({
      cutoff: null,
      floor_reached: true,
    });
  });

  it('merges buckets from several shards that share an hour', () => {
    const oldHour = hour(1000);
    const buckets: [number, number][] = [
      [oldHour, 50],
      [oldHour, 60],
      [oldHour + 1, 10_000],
    ];
    const floor = (oldHour + 10) * HOUR_SECONDS;
    expect(cutoffFor(buckets, 100, floor)).toEqual({
      cutoff: (oldHour + 1) * HOUR_SECONDS,
      floor_reached: false,
    });
  });
});

describe('the eviction target', () => {
  it('frees nothing once the cache is under its target', () => {
    expect(bytesToFree(700, 1000)).toBe(0);
    expect(bytesToFree(800, 1000)).toBe(0);
  });

  it('frees the gap down to eighty percent of quota', () => {
    expect(bytesToFree(950, 1000)).toBe(150);
    expect(bytesToFree(801, 1000)).toBe(1);
  });

  it('rounds up a fractional target', () => {
    expect(bytesToFree(3, 3)).toBe(1);
  });
});

describe('the high watermark', () => {
  it('triggers only past ninety percent of quota', () => {
    expect(overHighWatermark(900, 1000)).toBe(false);
    expect(overHighWatermark(901, 1000)).toBe(true);
  });
});

describe('merging histogram buckets', () => {
  it('adds up the bytes of each hour, oldest first', () => {
    expect(
      mergeBuckets([
        [5, 1],
        [3, 2],
        [5, 4],
      ]),
    ).toEqual([
      [3, 2],
      [5, 5],
    ]);
  });

  it('coarsens the oldest of very many hours to days, keeping every byte', () => {
    const hours = Array.from(
      { length: 30_000 },
      (_, index) => [index, 1] as [number, number],
    );
    const merged = mergeBuckets(hours);
    expect(merged.length).toBeLessThan(20_000);
    expect(merged.reduce((sum, [, bytes]) => sum + bytes, 0)).toBe(30_000);
    // A day is filed under its last hour, so a cutoff there frees all of it.
    expect(merged[0]).toEqual([23, 24]);
    expect(merged.at(-1)).toEqual([29_999, 1]);
  });
});
