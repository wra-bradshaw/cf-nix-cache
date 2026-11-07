import type { AuditEvent } from './types';

export function auditEvent(
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
