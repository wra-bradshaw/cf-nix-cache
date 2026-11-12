import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { CacheReference, CacheWorkflowJob } from './types';
import { coordinator, system } from './stubs';
import { shardPrefixes } from './shards';
import { pathIndex } from './path-index';

export function deleteCacheWorkflowId(incarnation: string): string {
  return `delete-${incarnation}`;
}

export class DeleteCacheWorkflow extends WorkflowEntrypoint<
  Env,
  CacheWorkflowJob
> {
  async run(
    event: WorkflowEvent<CacheWorkflowJob>,
    step: WorkflowStep,
  ): Promise<{ deleted: number }> {
    const job = event.payload;
    const reference: CacheReference = {
      id: job.cache_id,
      name: job.cache,
      incarnation: job.incarnation,
      coordinator_id: job.coordinator_id,
      lifecycle: 'DELETING',
    };
    const cache = coordinator(this.env, reference);
    const index = pathIndex(this.env, reference);
    let deleted = 0;
    for (const value of shardPrefixes()) {
      const count = await step.do(`clear shard ${value}`, async () => {
        return (await index.clear(value)).deleted;
      });
      deleted += count;
    }
    await step.do('flush cache audit', async () => {
      const flushed = await cache.flushAudit();
      if (!flushed.ok)
        throw new Error(
          `unable to flush cache audit: ${flushed.error.message}`,
        );
      return { flushed: true };
    });
    await step.do('remove cache storage', async () => {
      const removed = await cache.remove();
      if (!removed.ok)
        throw new Error(
          `unable to remove cache coordinator: ${removed.error.message}`,
        );
      const catalog = await system(this.env).removeCache(reference);
      if (!catalog.ok)
        throw new Error(
          `unable to remove cache catalog: ${catalog.error.message}`,
        );
      return { removed: true };
    });
    return { deleted };
  }
}
