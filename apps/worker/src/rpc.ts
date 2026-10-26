interface RpcFailure {
  code: string;
  message: string;
  status: number;
}

export type RpcResult<T> =
  { ok: true; value: T } | { ok: false; error: RpcFailure };

export function namedStub<T extends Rpc.DurableObjectBranded>(
  namespace: DurableObjectNamespace<T> | undefined,
  name: string,
): DurableObjectStub<T> {
  if (!namespace)
    throw new Error(`missing durable object namespace for ${name}`);
  return namespace.getByName(name);
}

/** The cache index shard owning a store hash (or a two-character prefix). */
export function indexShard(
  env: Env,
  incarnation: string,
  hashOrPrefix: string,
) {
  return namedStub(
    env.CACHE_INDEX,
    `${incarnation}:${hashOrPrefix.slice(0, 2)}`,
  );
}

export function idStub<T extends Rpc.DurableObjectBranded>(
  namespace: DurableObjectNamespace<T> | undefined,
  id: DurableObjectId | string,
): DurableObjectStub<T> {
  if (!namespace) throw new Error('missing durable object namespace');
  return namespace.get(
    typeof id === 'string' ? namespace.idFromString(id) : id,
  );
}

/** An RPC failure rethrown in the Worker so `handleError` can render it. */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function unwrapRpc<T>(result: RpcResult<T>): T {
  if (!result.ok)
    throw new ApiCallError(
      result.error.status,
      result.error.code,
      result.error.message,
    );
  return result.value;
}
