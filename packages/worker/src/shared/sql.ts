/**
 * A row from `ctx.storage.sql`. At runtime a column absent from the SELECT
 * list reads as `undefined`, and a BLOB reads as a binary buffer: both are
 * part of the union so the type does not lie. Reads of `undefined` are
 * rejected by text()/integer()/json() as corrupt. Nullable columns with a
 * default (retention_days, previous/next_record) intentionally use `== null`
 * to coalesce both NULL and a missing column to absent; required columns
 * must go through text()/integer()/json().
 */
export type SqlRow = Record<
  string,
  string | number | ArrayBuffer | null | undefined
>;

declare global {
  /**
   * The generated `SqlStorage.exec<T>` constrains rows to
   * `SqlStorageValue`, which excludes the `undefined` a missing column
   * reads as, so `exec<SqlRow>` does not satisfy that overload. This
   * overload accepts the honest `SqlRow` shape; explicit-`<SqlRow>` calls
   * fall through to it. The cursor stays the same runtime object, typed
   * with the stored (non-undefined) columns so `one()`/`rowsWritten` and
   * iteration keep their types.
   *
   * Bindings stay `unknown[]` rather than `SqlStorageValue[]` on purpose:
   * callers pass validated RPC and workflow inputs (strings, numbers, null)
   * without narrowing to `SqlStorageValue` first, and the overload must not
   * reject those call sites. SQLite still rejects unsupported binding types
   * at runtime; `unknown[]` only widens the static check.
   */
  interface SqlStorage {
    exec<T extends Record<string, SqlStorageValue | undefined>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursor<T & Record<string, SqlStorageValue>>;
  }
}

/** The first row of a SQL cursor, without materializing the rest.
 *
 * COUNT(*) callers must fail closed on `undefined` (return corrupt_* 500),
 * not coerce to 0: SQLite always returns exactly one row, so a missing row
 * means the count itself is unreadable and proceeding would treat unknown
 * backlog as drained. Likewise `rowsWritten` may be `undefined` in the node
 * test fake (a bare array), so workerd call sites read it as
 * `(exec(...) as unknown as { rowsWritten?: unknown }).rowsWritten ?? 0`.
 */
export function first<T>(cursor: Iterable<T>): T | undefined {
  for (const row of cursor) return row;
  return undefined;
}

/**
 * Reads a TEXT column. Throws on null or a mistyped value instead of
 * producing strings like "null", which is what `String(row.column)` does.
 */
export function text(row: SqlRow, column: string): string {
  const value: unknown = row[column];
  if (typeof value !== 'string')
    throw new Error(`column ${column} is not text`);
  return value;
}

/**
 * Reads an INTEGER column. Throws on null, fractions and overflow instead of
 * silently coercing them, which is what `Number(row.column)` does.
 *
 * Fail-closed cap: SQLite stores integers up to 2^63-1, but JavaScript
 * arithmetic is exact only to `Number.MAX_SAFE_INTEGER` (2^53-1). A stored
 * value beyond that range (even a "valid" SQLite integer) is rejected here
 * as corrupt so quota/byte totals never silently lose precision; callers map
 * the throw to `corrupt_*` 500.
 *
 * Boolean flags stored as 0/1 must still be allow-listed by the caller
 * (`value === 1` alone coerces a corrupt 2/-1 to false): check `=== 0/1`
 * explicitly and throw on anything else so it maps to `corrupt_*` 500.
 */
export function integer(row: SqlRow, column: string): number {
  const value: unknown = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`column ${column} is not an integer`);
  return value;
}

/** Parses a JSON TEXT column, including the column name on syntax errors. */
export function json<T>(row: SqlRow, column: string): T {
  const raw = text(row, column);
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new SyntaxError(
      `column ${column} is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/**
 * Follows `next_after` pages until the cursor is null, collecting every item.
 * `next_after` is the raw ordering key of the last item on a full page (see
 * {@link pageCursor}); `fetch` must implement the limit+1 probe so a page
 * whose size is an exact multiple of the limit still terminates. Throws when
 * a page returns a cursor it already returned, which would otherwise loop
 * forever, and when an empty page still advances, which would otherwise
 * livelock on sparse data.
 */
export async function collectPages<T>(
  fetch: (
    after: string | null,
  ) => Promise<{ items: T[]; next_after: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  do {
    const previous: string | null = after;
    const page = await fetch(after);
    items.push(...page.items);
    if (page.next_after !== null) {
      if (page.next_after === previous || seen.has(page.next_after))
        throw new Error('collectPages cursor did not advance');
      seen.add(page.next_after);
      if (page.items.length === 0)
        throw new Error('collectPages made no progress');
    }
    after = page.next_after;
  } while (after);
  return items;
}

/**
 * Pagination idiom for `next_after` (raw ordering key) pages.
 *
 * Limit policy: user-reachable RPC methods (caller-supplied limits over HTTP
 * or workflow inputs) validate the limit and return `invalid_limit` 400 when
 * it is not an integer in range, so a mistyped limit surfaces as a usable
 * error instead of a `LIMIT` bind throw. Internal-only walks with fixed
 * limits chosen by the caller may clamp into range instead.
 *
 * Callers must query `LIMIT limit + 1` and pass all probe rows: items are
 * `rows.slice(0, limit)`, and the cursor is the key of the last item
 * (`rows[limit - 1]`) only when a probe row exists. Judging fullness by
 * `rows.length === limit` instead returns a cursor when the table holds an
 * exact multiple of `limit`, causing one extra empty fetch.
 *
 * This differs from the audit/token `next_cursor` shape, which encodes a
 * composite (timestamp/id) cursor opaquely because its ordering key is not a
 * single column value; both shapes still use the same fetch-limit+1 and
 * slice-to-limit probe.
 */
export function pageCursor<T>(
  probeRows: T[],
  limit: number,
  key: (row: T) => string,
): string | null {
  return probeRows.length > limit ? key(probeRows[limit - 1]!) : null;
}
