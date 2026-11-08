import { NIX_BASE32 } from '../../shared/identifiers';

export function shardPrefixes(): string[] {
  return [...NIX_BASE32].flatMap((first) =>
    [...NIX_BASE32].map((second) => `${first}${second}`),
  );
}
