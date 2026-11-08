import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { ProcessJob, ProcessResult } from './types';
import { idStub } from '../../shared/rpc';
import { gcControl } from '../gc/gc-adapters';
import { processorFor } from '../processing/durable/container';

class PermanentWorkflowError extends Error {}

// Reprocessing only follows a lease that outlived its long TTL, so repeating
// this often means something is wrong. Leave the job restartable.
const MAX_LEASE_ATTEMPTS = 5;

export class ProcessUploadWorkflow extends WorkflowEntrypoint<Env, ProcessJob> {
  async run(
    event: WorkflowEvent<ProcessJob>,
    step: WorkflowStep,
  ): Promise<ProcessResult> {
    const job = event.payload;
    const upload = idStub(this.env.UPLOAD_JOB, job.job_id);
    const gc = gcControl(this.env);
    let leaseToken: string | null = null;
    try {
      await step.do('claim upload', async () => {
        const result = await upload.processing();
        if (!result.ok)
          throw new (
            result.error.status >= 500 ? Error : PermanentWorkflowError
          )(`${result.error.code}: ${result.error.message}`);
        return { ok: true };
      });
      for (let attempt = 0; attempt < MAX_LEASE_ATTEMPTS; attempt += 1) {
        // Processing may reuse existing objects, so garbage collection has to
        // know about this upload before the first one is looked at.
        const token = await this.acquireLease(step, job.job_id, attempt);
        leaseToken = token;
        const suffix = attempt === 0 ? '' : ` (attempt ${attempt + 1})`;
        const processed = await step.do(
          `process NAR${suffix}`,
          {
            retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' },
            // Containers are pooled, so a job may queue behind others.
            timeout: '30 minutes',
          },
          async () => {
            const processor = await processorFor(
              this.env.PROCESSOR!,
              job.job_id,
            );
            const response = await processor.fetch(
              'https://processor/process',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(job),
              },
            );
            // Only a client error says the input itself is bad. Anything else
            // is infrastructure, and may be a proxy's response, not the
            // processor's.
            if (response.status >= 500)
              throw new Error(
                `processor temporary failure (${response.status}): ${await response.text()}`,
              );
            if (!response.ok)
              return {
                permanent_error: `processor rejected input with ${response.status}: ${await response.text()}`,
              } as const;
            // The processor also returns the whole manifest, which can exceed
            // a step's result limit. Publication re-reads it from R2.
            const { manifest_key, deduplicated } =
              await response.json<ProcessResult>();
            return { result: { manifest_key, deduplicated } } as const;
          },
        );
        if ('permanent_error' in processed)
          throw new PermanentWorkflowError(processed.permanent_error);
        const publication = await step.do(
          `publish authoritative manifest${suffix}`,
          {
            retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
          },
          async () => {
            const lease = await gc.prepublish({
              job_id: job.job_id,
              token,
              manifest_key: processed.result.manifest_key,
            });
            if (!lease.ok)
              throw new Error(`${lease.error.code}: ${lease.error.message}`);
            if (!lease.value.valid) {
              // This may be a retry after a publication whose response was
              // lost, in which case there is nothing left to redo.
              const current = await upload.state();
              if (current.ok && current.value.status === 'READY')
                return { published: true } as const;
              return { lease_lost: true } as const;
            }
            const result = await upload.publish(processed.result);
            if (!result.ok) {
              if (result.error.status >= 500)
                throw new Error(
                  `${result.error.code}: ${result.error.message}`,
                );
              return {
                permanent_error: `${result.error.code}: ${result.error.message}`,
              } as const;
            }
            return { published: true } as const;
          },
        );
        if ('permanent_error' in publication)
          throw new PermanentWorkflowError(publication.permanent_error);
        if ('lease_lost' in publication) continue;
        await this.releaseLease(
          step,
          job.job_id,
          token,
          `release gc lease${suffix}`,
        );
        leaseToken = null;
        return processed.result;
      }
      throw new Error('upload repeatedly lost its garbage collection lease');
    } catch (caught) {
      if (leaseToken)
        await this.releaseLease(
          step,
          job.job_id,
          leaseToken,
          'release gc lease after failure',
        );
      // Transient failures leave the job in its current state so the workflow
      // can be restarted; only permanent ones are recorded as FAILED.
      if (caught instanceof PermanentWorkflowError)
        await step.do('mark failed', async () => {
          const result = await upload.fail(caught.message);
          if (!result.ok)
            throw new Error(
              `unable to mark upload failed: ${result.error.message}`,
            );
          return { failed: true };
        });
      throw caught;
    }
  }

  /** Waits out a closed upload gate, which garbage collection holds briefly. */
  private async acquireLease(
    step: WorkflowStep,
    jobId: string,
    attempt: number,
  ): Promise<string> {
    for (let poll = 0; ; poll += 1) {
      const { token } = await step.do(
        `acquire gc lease ${attempt}.${poll}`,
        async () => {
          const lease = await gcControl(this.env).acquireLease({
            job_id: jobId,
          });
          if (!lease.ok)
            throw new Error(`${lease.error.code}: ${lease.error.message}`);
          return lease.value;
        },
      );
      if (token) return token;
      await step.sleep(`wait for gc ${attempt}.${poll}`, '30 seconds');
    }
  }

  /** Best-effort: an unreleased lease only delays a sweep until it expires. */
  private async releaseLease(
    step: WorkflowStep,
    jobId: string,
    token: string,
    name: string,
  ): Promise<void> {
    await step.do(name, async () => {
      try {
        await gcControl(this.env).releaseLease({ job_id: jobId, token });
      } catch (error) {
        console.error('gc lease release failed', error);
      }
      return { released: true };
    });
  }
}
