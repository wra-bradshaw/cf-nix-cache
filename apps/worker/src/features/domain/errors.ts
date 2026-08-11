import type { ContractSchema } from '../../contracts';

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function parseJsonSchema<T>(
  schema: ContractSchema<T>,
  value: unknown,
): T {
  if (!schema.validate(value)) {
    const message = (schema.validate.errors ?? [])
      .map(
        (issue) =>
          `${issue.instancePath || 'body'}: ${issue.message ?? 'is invalid'}`,
      )
      .join('; ');
    throw new DomainError(
      'validation_failed',
      message || 'request does not match the wire contract',
      422,
    );
  }
  return value as T;
}
