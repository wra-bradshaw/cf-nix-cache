import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { ProcessJob, ProcessResult } from './types';
import { idStub } from '../../shared/rpc';
import { gcControl } from '../gc/gc-adapters';
import { processUpload } from './verify-stored';
import { InvalidEncodingError } from './verifier';

class PermanentWorkflowError extends Error {}

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
        const token = await this.acquireLease(step, job.job_id, attempt);
        leaseToken = token;
        const suffix = attempt === 0 ? '' : ` (attempt ${attempt + 1})`;
        const processed = await step.do(
          `process NAR${suffix}`,
          {
            retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' },
            timeout: '30 minutes',
          },
          async () => {
            try {
              return {
                result: await processUpload(this.env.CACHE_BUCKET, job),
              } as const;
            } catch (error) {
              if (error instanceof InvalidEncodingError)
                return { permanent_error: error.message } as const;
              throw error;
            }
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
