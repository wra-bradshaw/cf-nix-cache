import type { RpcResult } from '../../rpc';

export type SqlRow = Record<string, string | number | null>;

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

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

/** The first row of a SQL cursor, without materializing the rest. */
export function first<T>(cursor: Iterable<T>): T | undefined {
  for (const row of cursor) return row;
  return undefined;
}
