interface ContractIssue {
  readonly instancePath: string;
  readonly message?: string;
}

export interface ContractSchema<T> {
  readonly ref: string;
  readonly validate: ((value: unknown) => value is T) & {
    readonly errors?: readonly ContractIssue[] | null;
  };
  readonly __type?: T;
}
