export type SqlRow = Record<
  string,
  string | number | ArrayBuffer | null | undefined
>;

declare global {
  interface SqlStorage {
    exec<T extends Record<string, SqlStorageValue | undefined>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursor<T & Record<string, SqlStorageValue>>;
  }
}

// SQLite has no ADD COLUMN IF NOT EXISTS, so schema changes to existing
// tables check which columns are already there.
export function addMissingColumns(
  ctx: DurableObjectState,
  table: string,
  columns: Record<string, string>,
): void {
  let present: Set<string>;
  try {
    present = new Set(
      [...ctx.storage.sql.exec<SqlRow>(`PRAGMA table_info(${table})`)].map(
        (column) => text(column, 'name'),
      ),
    );
  } catch (error) {
    throw new Error(`corrupt_schema: ${table} schema record is corrupt`, {
      cause: error,
    });
  }
  for (const [name, definition] of Object.entries(columns))
    if (!present.has(name))
      ctx.storage.sql.exec(
        `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,
      );
}

export function first<T>(cursor: Iterable<T>): T | undefined {
  for (const row of cursor) return row;
  return undefined;
}

export function text(row: SqlRow, column: string): string {
  const value: unknown = row[column];
  if (typeof value !== 'string')
    throw new Error(`column ${column} is not text`);
  return value;
}

// Rejects beyond MAX_SAFE_INTEGER so totals never lose precision.
export function integer(row: SqlRow, column: string): number {
  const value: unknown = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`column ${column} is not an integer`);
  return value;
}

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

// Callers must query LIMIT limit + 1; the cursor is set only when a probe row exists.
export function pageCursor<T>(
  probeRows: T[],
  limit: number,
  key: (row: T) => string,
): string | null {
  return probeRows.length > limit ? key(probeRows[limit - 1]!) : null;
}
