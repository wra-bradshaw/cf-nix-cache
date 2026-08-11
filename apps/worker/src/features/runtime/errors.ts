import { DomainError } from '../domain/validation';
import type { RpcResult } from '../../rpc';

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new DomainError(
      'validation_failed',
      'request body must be valid JSON',
      400,
    );
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
