import { describe, expect, it, vi } from 'vitest';
import { ensureWorkflow } from './workflows';

function workflow(
  errors: { index: number; code: number; message: string }[],
  status: string,
) {
  const restart = vi.fn(async () => undefined);
  return {
    restart,
    binding: {
      createBatch: vi.fn(async () => ({ created: [], errors })),
      get: vi.fn(async () => ({
        status: async () => ({ status }),
        restart,
      })),
    } as unknown as Workflow<unknown>,
  };
}

const exists = [{ index: 0, code: 1, message: 'instance already exists' }];

describe('ensureWorkflow', () => {
  it('does not look up an instance it just created', async () => {
    const { binding, restart } = workflow([], 'queued');
    await ensureWorkflow(binding, 'id', {});
    expect(binding.get).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it.each(['errored', 'terminated'])(
    'restarts an existing %s instance',
    async (status) => {
      const { binding, restart } = workflow(exists, status);
      await ensureWorkflow(binding, 'id', {});
      expect(restart).toHaveBeenCalledOnce();
    },
  );

  it.each(['queued', 'running', 'complete'])(
    'leaves an existing %s instance alone',
    async (status) => {
      const { binding, restart } = workflow(exists, status);
      await ensureWorkflow(binding, 'id', {});
      expect(restart).not.toHaveBeenCalled();
    },
  );

  it('reports both failures when reconciliation fails too', async () => {
    const { binding } = workflow(exists, 'errored');
    vi.mocked(binding.get).mockRejectedValue(new Error('lookup down'));
    await expect(ensureWorkflow(binding, 'id', {})).rejects.toThrow(
      /instance already exists.*lookup down/,
    );
  });
});
