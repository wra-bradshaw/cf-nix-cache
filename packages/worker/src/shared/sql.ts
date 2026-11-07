export type SqlRow = Record<string, string | number | null>;

/** The first row of a SQL cursor, without materializing the rest. */
export function first<T>(cursor: Iterable<T>): T | undefined {
  for (const row of cursor) return row;
  return undefined;
}
