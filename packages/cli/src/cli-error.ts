import { validators } from '@devai-nyx/schemas';
import { ERROR_CODE_PREFIXES } from './error-code-prefixes.js';

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

const REFUSAL_CLASSES: Readonly<Record<CliError['exit'], CliErrorClass>> = {
  2: 'routing-authority',
  3: 'gate-fail',
  4: 'invalid-input',
  5: 'precondition',
  6: 'infrastructure',
  7: 'contract-violation',
};

const DEVAI_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;

/** A DEVAI diagnostic code: code-shaped, with a prefix the error-code reference scans. */
function isDevaiCode(token: string): boolean {
  return DEVAI_CODE.test(token) && ERROR_CODE_PREFIXES.has(token.split('_')[0] ?? '');
}

/**
 * A command-layer refusal as a schema-valid envelope (#338): the class is the one error.schema.json
 * pairs with the exit, and an exit outside 2-7 is an unanticipated failure, so infrastructure (6).
 * A composite `CODE:detail` keeps CODE as the envelope code and the detail as
 * `context.code_detail`. A leading token that is not a DEVAI code (a host error such as
 * `ENOENT: no such file`) becomes `fallback` with infrastructure (6) and the original text in
 * `context.message`.
 */
export function commandRefusal(
  raw: string,
  exit: number,
  context: Readonly<Record<string, unknown>>,
  remediation: string,
  fallback: string,
): CliError {
  const separator = raw.indexOf(':');
  const head = separator < 0 ? raw : raw.slice(0, separator);
  const known = isDevaiCode(head);
  const code = known ? head : fallback;
  const detail = known && separator >= 0 ? raw.slice(separator + 1).trim() : undefined;
  const refusalExit: CliError['exit'] = !known
    ? 6
    : Number.isInteger(exit) && exit >= 2 && exit <= 7
      ? (exit as CliError['exit'])
      : 6;
  const extra: Record<string, unknown> = {};
  if (detail !== undefined) extra['code_detail'] = detail;
  if (!known && raw.length > 0) extra['message'] = raw;
  return cliError({
    code,
    class: REFUSAL_CLASSES[refusalExit],
    exit: refusalExit,
    message: code.toLowerCase().replaceAll('_', ' '),
    remediation: known
      ? remediation
      : 'Check the operation input named in context.message, then retry; report it if it persists.',
    context: { ...context, ...extra },
  });
}

export function renderCliError(error: CliError, json: boolean): string {
  if (json) return `${JSON.stringify(error)}\n`;
  const remediation = error.remediation === undefined ? '' : ` Remediation: ${error.remediation}`;
  return `devai: ${error.message}${remediation}\n`;
}
