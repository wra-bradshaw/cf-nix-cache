import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { gcPorts } from '../gc/adapters';
import { runGarbageCollection } from '../gc/application';
import type { GcJob } from '../gc/model';

/** Runs on the configured schedule, or on request through `POST /api/gc`. */
export class GarbageCollectWorkflow extends WorkflowEntrypoint<Env, GcJob> {
  async run(event: WorkflowEvent<GcJob>, step: WorkflowStep) {
    const result = await runGarbageCollection(
      {
        run_id: event.instanceId,
        now: Math.floor(event.timestamp.getTime() / 1000),
        // A scheduled instance has no payload.
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
