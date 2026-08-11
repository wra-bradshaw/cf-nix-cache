import type { RpcResult } from '../../rpc';
import { PublicationError } from './application';

export function unwrapPublication<T>(result: RpcResult<T>, cache: string): T {
  if (!result.ok)
    throw new PublicationError(
      `${cache}: ${result.error.message}`,
      result.error.status >= 500,
    );
  return result.value;
}
