import { createHash } from 'node:crypto';
import { cliError, renderCliError } from '../cli-error.js';

export type FailureCategory = 'usage-error' | 'refused' | 'dependency-error';
export type HumanRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type JsonRecord = Record<string, unknown>;

export interface ActionContract extends JsonRecord {
  readonly action_id: string;
  readonly effect: 'read' | 'harness-write' | 'local-write' | 'remote-write';
  readonly subject: JsonRecord;
  readonly consent: JsonRecord;
  readonly planner: JsonRecord;
  readonly boundary: JsonRecord;
  readonly readiness: JsonRecord;
}

export interface TaggedFailure {
  readonly ok: false;
  readonly category: FailureCategory;
  readonly code: string;
  readonly reasons: readonly string[];
  readonly context?: JsonRecord;
}

export interface CliResult {
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly authority?: JsonRecord;
}

export const ROLES = new Set<HumanRole>(['owner', 'architect', 'inspector', 'engineer', 'auditor']);
export const SESSION_ID = /^AUTH-SESSION-[A-Za-z0-9]{16,}$/u;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function taggedFailure(
  category: FailureCategory,
  code: string,
  context?: JsonRecord,
): TaggedFailure {
  return Object.freeze({
    ok: false,
    category,
    code,
    reasons: Object.freeze([code]),
    ...(context === undefined ? {} : { context: Object.freeze({ ...context }) }),
  });
}

export function authorityRemediation(code: string, context: JsonRecord): string {
  if (code === 'AUTHORITY_HUMAN_ROLE_DENIED') {
    const roles = Array.isArray(context.allowed_roles) ? context.allowed_roles.map(String) : [];
    return roles.length > 0
      ? `Declare one of: ${roles.join(', ')} via --as-role.`
      : 'Declare an allowed role via --as-role.';
  }
  if (code === 'AUTHORITY_DECLARATION_NOT_APPLICABLE') {
    const declared = isRecord(context.declared) ? context.declared : {};
    const flags = [
      ...(declared.write === true ? ['--write'] : []),
      ...(declared.allow_publish === true ? ['--publish'] : []),
      ...(declared.as_role === true ? ['--as-role'] : []),
      ...(declared.authority_session === true ? ['--authority-session'] : []),
    ];
    return flags.length > 0
      ? `This action's effect is '${String(context.effect ?? 'read')}'; remove ${flags.join(' and ')}.`
      : `This action's effect is '${String(context.effect ?? 'read')}'; remove the authority declaration.`;
  }
  if (code === 'AUTHORITY_POLICY_MISSING') {
    const commands = Array.isArray(context.commands) ? context.commands.map(String) : [];
    if (commands.length > 1) {
      return `Run in order:\n${commands.map((command, index) => `${String(index + 1)}. ${command}`).join('\n')}`;
    }
    return `Run: ${String(commands[0] ?? context.command ?? 'devai init bind --target <repo> --as-role architect --write')}`;
  }
  if (code === 'AUTHORITY_WRITE_CONSENT_REQUIRED') {
    return 'Add --write after reviewing the action plan.';
  }
  if (code === 'AUTHORITY_PUBLISH_CONSENT_REQUIRED') {
    return 'Add --write and --publish after reviewing the remote effect.';
  }
  if (code === 'AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED') {
    const reason = String(context.reason ?? '');
    if (reason === 'cwd escapes the repository') {
      return 'The declared cwd must resolve inside the repository.';
    }
    if (reason === 'cwd does not exist') {
      return 'The declared cwd must exist before the task can run.';
    }
    if (reason === 'cwd must be declared') {
      return 'Declare the task cwd in the adopter-owned task descriptor.';
    }
    if (reason === 'shell must be false') {
      return 'Declare an argv-based task with shell disabled.';
    }
    const executable = String(context.executable ?? '<unknown>');
    const argv = Array.isArray(context.argv) ? JSON.stringify(context.argv) : '[]';
    const descriptor = String(context.descriptor_path ?? '<unknown>');
    if (context.action === 'sense run') {
      const sensor = String(context.sensor ?? '<sensor>');
      return `Declare the process for sensor ${sensor} as its input in ${descriptor}; received ${executable} ${argv}.`;
    }
    return `Declare the exact process in ${descriptor}; received ${executable} ${argv}.`;
  }
  return context.category === 'dependency-error'
    ? 'Materialize the required repository state, then retry.'
    : 'Use a declared role and the required consent flags.';
}

export function authorityErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = /^(AUTHORITY_[A-Z0-9_]+|UNCLASSIFIED_RESOURCE|POLICY_DENY)(?::|$)/u.exec(
    error.message,
  )?.[1];
  if (code !== undefined) return code;
  return error.message.startsWith('authority policy:') ? 'AUTHORITY_POLICY_MISSING' : undefined;
}

export function authorityErrorContext(error: unknown): JsonRecord | undefined {
  if (!(error instanceof Error)) return undefined;
  const attached = (error as Error & { readonly context?: unknown }).context;
  if (isRecord(attached)) return attached;
  const separator = error.message.indexOf(':');
  if (separator < 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(error.message.slice(separator + 1));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function handleBoundaryError(error: unknown): undefined {
  const code = authorityErrorCode(error);
  if (code === undefined) throw error;
  const format = formatFor(process.argv);
  const category: FailureCategory = code.endsWith('_UNAVAILABLE') ? 'dependency-error' : 'refused';
  const rendered = renderAuthorityResult(
    taggedFailure(category, code, authorityErrorContext(error)),
    format,
  );
  const stream = rendered.stdout.length > 0 ? process.stdout : process.stderr;
  stream.write(rendered.stdout.length > 0 ? rendered.stdout : rendered.stderr);
  process.exitCode = rendered.exit_code;
  return undefined;
}

function outputContractValid(authority: unknown): boolean {
  if (!isRecord(authority) || !isRecord(authority.principal)) return true;
  const principal = authority.principal;
  if (principal.kind !== 'human') return true;
  if (principal.declaration_source === 'cli-flag') return !Object.hasOwn(principal, 'session_id');
  if (principal.declaration_source === 'session-state') {
    return typeof principal.session_id === 'string' && SESSION_ID.test(principal.session_id);
  }
  return false;
}

export function renderAuthorityResult(result: unknown, format: 'human' | 'json'): CliResult {
  if (!isRecord(result) || !outputContractValid(result.authority)) {
    return renderAuthorityResult(
      taggedFailure('dependency-error', 'AUTHORITY_OUTPUT_CONTRACT_INVALID'),
      format,
    );
  }
  if (result.ok === false) {
    const category = result.category as FailureCategory;
    const code = typeof result.code === 'string' ? result.code : 'AUTHORITY_RESULT_INVALID';
    const detailContext = isRecord(result.context) ? result.context : {};
    const contractViolation =
      code.includes('CONTRACT') || code.includes('INVALID') || code.includes('DIVERGENCE');
    const infrastructure =
      code.includes('TIMEOUT') || code.includes('CRASH') || code.includes('SIGNAL');
    const exitCode = contractViolation
      ? 7
      : infrastructure
        ? 6
        : category === 'dependency-error'
          ? 5
          : 2;
    const error = cliError({
      code,
      class: contractViolation
        ? 'contract-violation'
        : infrastructure
          ? 'infrastructure'
          : category === 'dependency-error'
            ? 'precondition'
            : 'routing-authority',
      exit: exitCode,
      message: code.replaceAll('_', ' ').toLowerCase(),
      remediation: authorityRemediation(code, { category, ...detailContext }),
      refs: {
        doc:
          code === 'AUTHORITY_POLICY_MISSING'
            ? 'docs/adopters/install.md'
            : 'law/constitution.md#article-6',
      },
      context: { category, ...detailContext },
    });
    const authority = { category, code };
    return {
      exit_code: exitCode,
      stdout: '',
      stderr: renderCliError(error, format === 'json'),
      authority,
    };
  }
  const payload = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'ok'));
  return {
    exit_code: 0,
    stdout: format === 'json' ? `${JSON.stringify(payload)}\n` : '',
    stderr: '',
    ...(isRecord(result.authority) && { authority: result.authority }),
  };
}

export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function formatFor(argv: readonly string[]): 'human' | 'json' {
  return flagValue(argv, '--format') === 'json' || argv.includes('--json') ? 'json' : 'human';
}
