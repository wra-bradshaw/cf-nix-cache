import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { evictionPorts } from './eviction-adapters';
import { runEviction } from './eviction';
import type { EvictionJob } from './types';

export class EvictCacheWorkflow extends WorkflowEntrypoint<
  Env,
  EvictionJob | Record<string, never>
> {
  async run(
    event: WorkflowEvent<EvictionJob | Record<string, never>>,
    step: WorkflowStep,
  ) {
    const payload = event.payload;
    const result = await runEviction(
      {
        run_id: event.instanceId,
        now: Math.floor(event.timestamp.getTime() / 1000),
        job: payload && 'cache' in payload ? (payload as EvictionJob) : null,
      },
      evictionPorts(this.env),
      {
        do: <T>(name: string, body: () => Promise<T>) =>
          step.do(
            name,
            {
              retries: {
                limit: 5,
                delay: '10 seconds',
                backoff: 'exponential',
              },
            },
            body as never,
          ) as Promise<T>,
      },
      () => Math.floor(Date.now() / 1000),
    );
    return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  }
}
