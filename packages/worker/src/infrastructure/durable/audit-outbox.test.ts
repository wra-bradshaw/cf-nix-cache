import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../types';
import type { RpcResult } from '../../rpc';
import { AuditOutbox } from './audit-outbox';

type Row = { event_id: string; event: string; created_at: number };

/** Just enough of DurableObjectState for the outbox's own statements. */
function fakeState() {
  const rows = new Map<string, Row>();
  const alarms: number[] = [];
  const background: Promise<unknown>[] = [];
  const exec = (query: string, ...args: unknown[]): Iterable<unknown> => {
    if (query.startsWith('INSERT OR IGNORE INTO audit_outbox')) {
      const [event_id, event, created_at] = args as [string, string, number];
      if (!rows.has(event_id))
        rows.set(event_id, { event_id, event, created_at });
      return [];
    }
    if (query.startsWith('SELECT event_id, event FROM audit_outbox'))
      return [...rows.values()].slice(0, Number(args[0]));
    if (query.startsWith('DELETE FROM audit_outbox')) {
      rows.delete(String(args[0]));
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
});
