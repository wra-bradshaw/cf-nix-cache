import { NIX_BASE32 } from '../../shared/identifiers';

/** Every two-character store hash prefix, and so every index shard of a cache. */
export function shardPrefixes(): string[] {
  return [...NIX_BASE32].flatMap((first) =>
    [...NIX_BASE32].map((second) => `${first}${second}`),
  );
}
