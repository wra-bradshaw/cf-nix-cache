import { DomainError } from './errors';

interface ContractIssue {
  readonly instancePath: string;
  readonly message?: string;
}

export interface ContractSchema<T> {
  readonly validate: ((value: unknown) => value is T) & {
    readonly errors?: readonly ContractIssue[] | null;
  };
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

export {
  BootstrapRequestSchema,
  ChunkManifestSchema,
  CompleteUploadSchema,
  ConfigureCacheSchema,
  CreateCacheSchema,
  EncodedCompleteBatchSchema,
  EncodedUploadBatchSchema,
  EncodedUploadRequestSchema,
  GcRunRequestSchema,
  GrantSchema,
  MissingPathsSchema,
  TokenRequestSchema,
  UploadRequestSchema,
} from '../generated/json-contracts';
