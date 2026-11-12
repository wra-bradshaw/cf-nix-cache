import { describe, expect, it, vi } from 'vitest';
import { shardPrefixes } from './shards';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

const { DeleteCacheWorkflow, deleteCacheWorkflowId } =
  await import('./delete-cache-workflow');

describe('cache deletion', () => {
  it('clears every index shard, and adds up what they held', async () => {
    const cleared: string[] = [];
    const ok = (value?: unknown) => ({ ok: true, value });
    const quota = {
      flushAudit: async () => ok(),
      remove: async () => ok(),
    };
    const env = {
      CACHE_INDEX: {
        getByName: (name: string) => ({
          clear: async () => {
            cleared.push(name);
            return ok({ deleted: 1, bytes: 1, revision: 1 });
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

describe('workflow instance ids', () => {
  it('uses the characters and length Cloudflare accepts', () => {
    const id = deleteCacheWorkflowId('67aea408-622d-4a82-ac6c-88aa4bfd092a');
    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/);
    expect(id.length).toBeLessThanOrEqual(100);
  });
});
