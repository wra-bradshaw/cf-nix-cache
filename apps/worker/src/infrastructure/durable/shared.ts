export type SqlRow = Record<string, string | number | null>;

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function initialize(ctx: DurableObjectState, sql: string): void {
  ctx.storage.sql.exec(sql);
}
