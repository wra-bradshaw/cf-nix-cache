export async function ensureWorkflow<T>(
  workflow: Workflow<T>,
  id: string,
  params: T,
): Promise<void> {
  let createFailure: unknown;
  try {
    const { errors } = await workflow.createBatch({
      instances: [{ id, params }],
    });
    if (!errors.length) return;
    createFailure = errors[0].message;
  } catch (error) {
    createFailure = error;
  }
  try {
    const instance = await workflow.get(id);
    const status = await instance.status();
    if (status.status === 'errored' || status.status === 'terminated')
      await instance.restart();
  } catch (lookupError) {
    throw new Error(
      `workflow enqueue failed for ${id}: ${createFailure instanceof Error ? createFailure.message : String(createFailure)}; reconciliation failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`,
      { cause: lookupError },
    );
  }
}
