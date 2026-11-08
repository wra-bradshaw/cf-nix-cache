import { namedStub } from '../../shared/rpc';

const AUDIT_SHARD_COUNT = 16;

function shardNumber(eventId: string): number {
  let hash = 2166136261;
  for (const character of eventId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % AUDIT_SHARD_COUNT;
}

function auditShardName(eventId: string): string {
  return `audit:${shardNumber(eventId).toString(16).padStart(2, '0')}`;
}

export function auditShardNames(): string[] {
  return Array.from(
    { length: AUDIT_SHARD_COUNT },
    (_, index) => `audit:${index.toString(16).padStart(2, '0')}`,
  ).concat('audit');
}

export function auditStub(env: Env, eventId: string) {
  return namedStub(env.AUDIT_LOG, auditShardName(eventId));
}
