import { describe, expect, it, vi } from 'vitest';
import { shardPrefixes } from '../domain/identifiers';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const { DeleteCacheWorkflow } = await import('./delete-cache');

describe('cache deletion', () => {
  it('clears every index shard, and adds up what they held', async () => {
    const cleared: string[] = [];
    const ok = (value?: unknown) => ({ ok: true, value });
    const quota = {
      reconcile: async () => ok(),
      clearDelta: async () => ok(),
      flushAudit: async () => ok(),
      remove: async () => ok(),
    };
    const env = {
      CACHE_INDEX: {
        getByName: (name: string) => ({
          clear: async () => {
            cleared.push(name);
            return ok({ deleted: 1, bytes: 1, reconcile_operation_ids: [] });
          },
        }),
      },
      CACHE_COORDINATOR: { get: () => quota, idFromString: (id: string) => id },
      SYSTEM_CONTROL: { getByName: () => ({ removeCache: async () => ok() }) },
    } as unknown as Env;
    const step = {
      do: (_name: string, body: () => Promise<unknown>) => body(),
    };
    const workflow = new DeleteCacheWorkflow({} as ExecutionContext, env);

    const result = await workflow.run(
      {
        payload: {
          cache: 'cache',
          cache_id: 'id',
          incarnation: 'inc',
          coordinator_id: 'coordinator',
          operation_id: 'op',
        },
      } as never,
      step as never,
    );

    expect(cleared).toEqual(shardPrefixes().map((prefix) => `inc:${prefix}`));
    expect(cleared).toContain('inc:zz');
    expect(result.deleted).toBe(1024);
  });
});
