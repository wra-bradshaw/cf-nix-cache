import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { CacheWorkflowJob } from '../../types';
import { idStub } from '../../rpc';
import { coordinator, system } from '../cache/directory';

export class DeleteCacheWorkflow extends WorkflowEntrypoint<
  Env,
  CacheWorkflowJob
> {
  async run(
    event: WorkflowEvent<CacheWorkflowJob>,
    step: WorkflowStep,
  ): Promise<{ deleted: number }> {
    const job = event.payload;
    const cache = coordinator(this.env, {
      id: job.cache_id,
      name: job.cache,
      incarnation: job.incarnation,
      coordinator_id: job.coordinator_id,
    });
    let deleted = 0;
    for (let prefix = 0; prefix < 256; prefix += 1) {
      const value = prefix.toString(16).padStart(2, '0');
      const count = await step.do(`clear shard ${value}`, async () => {
        const shardId = this.env
          .CACHE_INDEX!.idFromName(`${job.incarnation}:${value}`)
          .toString();
        const shard = idStub(this.env.CACHE_INDEX, shardId);
        const cleared = await shard.clear(
          `clear:${job.incarnation}:${job.operation_id}:${value}`,
        );
        if (!cleared.ok)
          throw new Error(
            `unable to clear shard ${value}: ${cleared.error.message}`,
          );
        const reconciled = await cache.reconcile({
          operation_ids: cleared.value.reconcile_operation_ids,
        });
        if (!reconciled.ok)
          throw new Error(
            `unable to reconcile shard ${value} publications: ${reconciled.error.message}`,
          );
        const applied = await cache.clearDelta({
          operation_id: `clear:${job.incarnation}:${job.operation_id}:${value}`,
          delta: -cleared.value.bytes,
        });
        if (!applied.ok)
          throw new Error(
            `unable to apply shard ${value} quota delta: ${applied.error.message}`,
          );
        return cleared.value.deleted;
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
      const catalog = await system(this.env).removeCache({
        id: job.cache_id,
        name: job.cache,
        incarnation: job.incarnation,
        coordinator_id: job.coordinator_id,
      });
      if (!catalog.ok)
        throw new Error(
          `unable to remove cache catalog: ${catalog.error.message}`,
        );
      return { removed: true };
    });
    return { deleted };
  }
}
