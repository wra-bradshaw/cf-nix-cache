import { describe, expect, it } from 'vitest';
import type { AuditEvent } from './types';
import type { RpcResult } from '../../shared/rpc';
import { AuditOutbox } from './outbox';

type Row = { event_id: unknown; event: unknown; created_at: number };

function fakeState() {
  const rows = new Map<number, Row>();
  let nextRowId = 1;
  const alarms: number[] = [];
  const background: Promise<unknown>[] = [];
  const exec = (query: string, ...args: unknown[]): Iterable<unknown> => {
    if (query.startsWith('INSERT OR IGNORE INTO audit_outbox')) {
      const [event_id, event, created_at] = args as [string, string, number];
      if ([...rows.values()].some((row) => row.event_id === event_id))
        return [];
      rows.set(nextRowId++, { event_id, event, created_at });
      return [];
    }
    if (query.startsWith('SELECT rowid, event_id, event FROM audit_outbox'))
      return [...rows.entries()]
        .map(([rowid, row]) => ({ rowid, ...row }))
        .slice(0, Number(args[0]));
    if (query.startsWith('SELECT event_id, event FROM audit_outbox'))
      return [...rows.values()].slice(0, Number(args[0]));
    if (query.startsWith('DELETE FROM audit_outbox WHERE rowid = ?')) {
      rows.delete(Number(args[0]));
      return [];
    }
    if (query.startsWith('DELETE FROM audit_outbox')) {
      for (const [id, row] of rows)
        if (row.event_id === String(args[0])) rows.delete(id);
      return [];
    }
    if (query.startsWith('SELECT COUNT(*)')) return [{ count: rows.size }];
    throw new Error(`unexpected query ${query}`);
  };
  const ctx = {
    storage: {
      sql: { exec },
      setAlarm: async (time: number) => {
        alarms.push(time);
      },
    },
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  };
  return {
    ctx: ctx as unknown as DurableObjectState,
    rows,
    alarms,
    background,
  };
}

function fakeEnv(append: (event: AuditEvent) => Promise<RpcResult<void>>) {
  return {
    AUDIT_LOG: { getByName: () => ({ append }) },
  } as unknown as Env;
}

const event = (id: string): AuditEvent => ({
  id,
  timestamp: 1,
  actor: 'admin',
  action: 'token.issue',
  resource: 'token',
  outcome: 'success',
  metadata: {},
});

describe('audit outbox', () => {
  it('keeps events and schedules a retry when delivery throws', async () => {
    const state = fakeState();
    const outbox = new AuditOutbox(
      state.ctx,
      fakeEnv(async () => {
        throw new Error('audit log unreachable');
      }),
    );
    outbox.enqueue(event('a'));
    await expect(Promise.all(state.background)).resolves.toEqual([false]);
    expect(state.rows.size).toBe(1);
    expect(state.alarms).toHaveLength(1);
  });

  it('drains the backlog from its alarm once the log recovers', async () => {
    const state = fakeState();
    let available = false;
    const delivered: string[] = [];
    const outbox = new AuditOutbox(
      state.ctx,
      fakeEnv(async (value) => {
        if (!available)
          return {
            ok: false,
            error: { code: 'unavailable', message: 'down', status: 503 },
          };
        delivered.push(value.id);
        return { ok: true, value: undefined };
      }),
    );
    outbox.enqueue(event('a'));
    outbox.enqueue(event('a'));
    outbox.enqueue(event('b'));
    await Promise.all(state.background);
    expect(outbox.pending()).toBe(2);

    available = true;
    await outbox.alarm();
    expect(delivered).toEqual(['a', 'b']);
    expect(outbox.pending()).toBe(0);
  });

  it('deletes a row with a corrupt event_id by rowid instead of re-reading it', async () => {
    const state = fakeState();
    const delivered: string[] = [];
    const available = { value: false };
    const outbox = new AuditOutbox(
      state.ctx,
      fakeEnv(async (value) => {
        if (!available.value)
          return {
            ok: false,
            error: { code: 'unavailable', message: 'down', status: 503 },
          };
        delivered.push(value.id);
        return { ok: true, value: undefined };
      }),
    );
    outbox.enqueue(event('good'));
    await Promise.all(state.background);
    expect(outbox.pending()).toBe(1);
    for (const row of state.rows.values()) row.event_id = null;
    await outbox.drain();
    expect(state.rows.size).toBe(0);
    expect(outbox.pending()).toBe(0);
    expect(delivered).toEqual([]);
    await outbox.drain();
    expect(outbox.pending()).toBe(0);
    expect(delivered).toEqual([]);
  });
});
