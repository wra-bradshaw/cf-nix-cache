interface RpcFailure {
  code: string;
  message: string;
  status: number;
}

export type RpcResult<T> =
  { ok: true; value: T } | { ok: false; error: RpcFailure };

export function failure(
  code: string,
  message: string,
  status: number,
): RpcResult<never> {
  return { ok: false, error: { code, message, status } };
}

export function ok(): RpcResult<void>;
export function ok<T>(value: T): RpcResult<T>;
export function ok<T>(value?: T): RpcResult<T | undefined> {
  return { ok: true, value };
}

export function conflict(code: string, message: string): RpcResult<never> {
  return failure(code, message, 409);
}

export function namedStub<T extends Rpc.DurableObjectBranded>(
  namespace: DurableObjectNamespace<T> | undefined,
  name: string,
): DurableObjectStub<T> {
  if (!namespace)
    throw new Error(`missing durable object namespace for ${name}`);
  return namespace.getByName(name);
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

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiCallError && error.code === 'not_found';
}
