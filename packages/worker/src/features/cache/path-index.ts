import { unwrapRpc } from '../../shared/rpc';
import { coordinator, indexShard } from './stubs';
import type { CacheReference, PathRecord } from './types';

interface PathIndexUsage {
  bytes: number;
  revision: number;
}

export function pathIndex(env: Env, reference: CacheReference) {
  const shard = (prefix: string) =>
    indexShard(env, reference.incarnation, prefix.slice(0, 2));

  const report = async (
    prefix: string,
    usage: PathIndexUsage,
  ): Promise<void> => {
    const shardName = prefix.slice(0, 2);
    try {
      const result = await coordinator(env, reference).reportUsage({
        prefix: shardName,
        bytes: usage.bytes,
        revision: usage.revision,
      });
      if (!result.ok)
        console.error({
          message: 'reporting shard usage failed',
          cache: reference.name,
          shard: shardName,
          code: result.error.code,
          error: result.error.message,
        });
    } catch (error) {
      console.error({
        message: 'reporting shard usage failed',
        cache: reference.name,
        shard: shardName,
        error: error instanceof Error ? error.message : error,
      });
    }
  };

  return {
    async upsert(record: PathRecord): Promise<PathIndexUsage> {
      const result = unwrapRpc(await shard(record.store_hash).upsert(record));
      const usage = { bytes: result.bytes, revision: result.revision };
      await report(record.store_hash, usage);
      return usage;
    },

    async delete(
      storeHash: string,
      options: { unusedBefore?: number } = {},
    ): Promise<{ freed: number; existed: boolean }> {
      const result = unwrapRpc(
        await shard(storeHash).delete({
          store_hash: storeHash,
          ...(options.unusedBefore === undefined
            ? {}
            : { unused_before: options.unusedBefore }),
        }),
      );
      await report(storeHash, result);
      return { freed: result.freed, existed: result.existed };
    },

    async clear(prefix: string): Promise<{ deleted: number }> {
      const result = unwrapRpc(await shard(prefix).clear());
      return { deleted: result.deleted };
    },

    async refresh(prefix: string): Promise<PathIndexUsage> {
      const usage = unwrapRpc(await shard(prefix).usage());
      await report(prefix, usage);
      return usage;
    },
  };
}
