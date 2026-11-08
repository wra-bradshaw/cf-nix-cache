import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { gcPorts } from './gc-adapters';
import { runGarbageCollection } from './garbage-collection';
import type { GcJob } from './types';

export class GarbageCollectWorkflow extends WorkflowEntrypoint<Env, GcJob> {
  async run(event: WorkflowEvent<GcJob>, step: WorkflowStep) {
    const result = await runGarbageCollection(
      {
        run_id: event.instanceId,
        now: Math.floor(event.timestamp.getTime() / 1000),
        job: event.payload ?? {},
      },
      gcPorts(this.env, event.instanceId),
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
        sleep: (name, duration) => step.sleep(name, duration),
      },
      () => Math.floor(Date.now() / 1000),
    );
    return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  }
}
