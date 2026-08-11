export async function ensureWorkflow<T>(
  workflow: Workflow<T>,
  id: string,
  params: T,
): Promise<void> {
  try {
    await workflow.createBatch([{ id, params }]);
    return;
  } catch (createError) {
    try {
      const instance = await workflow.get(id);
      const status = await instance.status();
      if (status.status === 'errored' || status.status === 'terminated')
        await instance.restart();
      return;
    } catch (lookupError) {
      throw new Error(
        `workflow enqueue failed for ${id}: ${createError instanceof Error ? createError.message : String(createError)}; reconciliation failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`,
        { cause: lookupError },
      );
    }
  }
}
