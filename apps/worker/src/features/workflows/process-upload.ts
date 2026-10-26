import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { ProcessJob, ProcessResult } from '../../types';
import { idStub } from '../../rpc';

class PermanentWorkflowError extends Error {}

export class ProcessUploadWorkflow extends WorkflowEntrypoint<Env, ProcessJob> {
  async run(
    event: WorkflowEvent<ProcessJob>,
    step: WorkflowStep,
  ): Promise<ProcessResult> {
    const job = event.payload;
    const upload = idStub(this.env.UPLOAD_JOB, job.job_id);
    try {
      await step.do('claim upload', async () => {
        const result = await upload.processing();
        if (!result.ok)
          throw new (
            result.error.status >= 500 ? Error : PermanentWorkflowError
          )(`${result.error.code}: ${result.error.message}`);
        return { ok: true };
      });
      const processed = await step.do(
        'process NAR',
        { retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' } },
        async () => {
          const response = await this.env
            .PROCESSOR!.getByName(job.job_id)
            .fetch('https://processor/process', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(job),
            });
          if (response.status === 503)
            throw new Error(
              `processor temporary failure: ${await response.text()}`,
            );
          if (!response.ok)
            return {
              permanent_error: `processor rejected input with ${response.status}: ${await response.text()}`,
            } as const;
          return { result: await response.json<ProcessResult>() } as const;
        },
      );
      if ('permanent_error' in processed)
        throw new PermanentWorkflowError(processed.permanent_error);
      const publication = await step.do(
        'publish authoritative manifest',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } },
        async () => {
          const result = await upload.publish(processed.result);
          if (!result.ok) {
            if (result.error.status >= 500)
              throw new Error(`${result.error.code}: ${result.error.message}`);
            return {
              permanent_error: `${result.error.code}: ${result.error.message}`,
            } as const;
          }
          return { published: true } as const;
        },
      );
      if ('permanent_error' in publication)
        throw new PermanentWorkflowError(publication.permanent_error);
      return processed.result;
    } catch (caught) {
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
}
