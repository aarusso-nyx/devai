import { validators } from '@devai-nyx/schemas';

export type CliErrorClass =
  | 'routing-authority'
  | 'gate-fail'
  | 'invalid-input'
  | 'precondition'
  | 'infrastructure'
  | 'contract-violation';

export interface CliError {
  readonly schemaVersion: '1.0.0';
  readonly code: string;
  readonly class: CliErrorClass;
  readonly exit: 2 | 3 | 4 | 5 | 6 | 7;
  readonly message: string;
  readonly remediation?: string;
  readonly refs?: Readonly<{ record?: string; doc?: string }>;
  readonly context?: Readonly<Record<string, unknown>>;
}

export function cliError(error: Omit<CliError, 'schemaVersion'>): CliError {
  const envelope: CliError = { schemaVersion: '1.0.0', ...error };
  if (!validators.error(envelope)) {
    throw new Error(`CLI_ERROR_CONTRACT_VIOLATION: ${JSON.stringify(validators.error.errors)}`);
  }
  return envelope;
}

export function renderCliError(error: CliError, json: boolean): string {
  if (json) return `${JSON.stringify(error)}\n`;
  const remediation = error.remediation === undefined ? '' : ` Remediation: ${error.remediation}`;
  return `devai: ${error.message}${remediation}\n`;
}
