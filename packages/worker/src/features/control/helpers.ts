import type { AuditEvent } from '../../types';

export function pageLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
}

export function event(
  id: string,
  actor: string,
  action: string,
  resource: string,
  outcome: AuditEvent['outcome'],
): AuditEvent {
  return {
    id,
    timestamp: Math.floor(Date.now() / 1000),
    actor,
    action,
    resource,
    outcome,
    metadata: {},
  };
}
