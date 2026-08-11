import {
  executorFailure,
  isExecutorEffect,
  isRelativeExecutorPath,
  isUniqueNonEmptyStrings,
  type ExecutorDiscipline,
  type ExecutorEffect,
  type ExecutorFailure,
} from './executor-adapters.js';

const SHELL_EXECUTABLES = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'csh',
  'dash',
  'fish',
  'ksh',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sh',
  'tcsh',
  'zsh',
]);

export interface RoutineExecutorRequest {
  readonly kind: 'routine';
  readonly action_id?: string;
  readonly argv?: readonly string[];
  readonly cwd: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly effects: readonly ExecutorEffect[];
  readonly timeout_ms: number;
  readonly authority_checks?: readonly string[];
}

export interface RoutineActionRegistryEntry {
  readonly action_id: string;
  readonly internal_binding: string;
  readonly effect: ExecutorEffect;
  readonly authority_contract: {
    readonly effect: ExecutorEffect;
    readonly capabilities: readonly string[];
    readonly subject:
      | { readonly kind: 'none' }
      | { readonly kind: 'human'; readonly allowed_roles: readonly ExecutorDiscipline[] }
      | {
          readonly kind: 'derived-machine';
          readonly initiator: { readonly allowed_roles: readonly ExecutorDiscipline[] };
        };
    readonly consent: {
      readonly write: boolean;
      readonly allow_publish: boolean;
    };
  };
}

export interface RoutineAuthority {
  readonly discipline: ExecutorDiscipline;
  readonly capabilities: readonly string[];
  readonly write: boolean;
  readonly allow_publish: boolean;
}

export interface RoutineValidationOptions {
  readonly executor: RoutineExecutorRequest;
  readonly actionRegistry?: readonly RoutineActionRegistryEntry[];
  readonly authority?: RoutineAuthority;
  readonly authorize?: (request: {
    readonly discipline: ExecutorDiscipline;
    readonly executor: RoutineExecutorRequest;
    readonly action?: RoutineActionRegistryEntry;
  }) => boolean | ExecutorFailure;
}

export interface ValidatedRoutineExecutor {
  readonly ok: true;
  readonly source: 'literal-argv' | 'registered-action';
  readonly argv?: readonly string[];
  readonly action?: RoutineActionRegistryEntry;
}

function allowedRoles(entry: RoutineActionRegistryEntry): readonly ExecutorDiscipline[] | null {
  if (entry.authority_contract.subject.kind === 'none') return null;
  if (entry.authority_contract.subject.kind === 'human') {
    return entry.authority_contract.subject.allowed_roles;
  }
  return entry.authority_contract.subject.initiator.allowed_roles;
}

function validateAuthority(
  options: RoutineValidationOptions,
  action: RoutineActionRegistryEntry | undefined,
): ExecutorFailure | null {
  const hasWriteEffect = options.executor.effects.some((effect) => effect !== 'read');
  if ((hasWriteEffect || action !== undefined) && options.authority === undefined) {
    return executorFailure(
      'TASK_ROUTINE_AUTHORITY_REQUIRED',
      'write-capable and registered routine execution requires task-discipline authority',
    );
  }
  if (options.authority === undefined) return null;

  if (action !== undefined) {
    const roles = allowedRoles(action);
    if (roles !== null && !roles.includes(options.authority.discipline)) {
      return executorFailure(
        'TASK_ROUTINE_DISCIPLINE_FORBIDDEN',
        `discipline ${options.authority.discipline} is not authorized for ${action.action_id}`,
      );
    }
    const consent = action.authority_contract.consent;
    if (consent.write && !options.authority.write) {
      return executorFailure(
        'TASK_WRITE_CONSENT_REQUIRED',
        'the resolved action requires write consent',
      );
    }
    if (consent.allow_publish && !options.authority.allow_publish) {
      return executorFailure(
        'TASK_PUBLISH_CONSENT_REQUIRED',
        'the resolved action independently requires publication consent',
      );
    }
    const granted = new Set(options.authority.capabilities);
    const missing = action.authority_contract.capabilities.filter(
      (capability) => !granted.has(capability),
    );
    if (missing.length > 0) {
      return executorFailure(
        'TASK_ROUTINE_CAPABILITY_UNAUTHORIZED',
        `task authority does not grant: ${missing.join(', ')}`,
      );
    }
  }

  const decision = options.authorize?.({
    discipline: options.authority.discipline,
    executor: options.executor,
    ...(action !== undefined && { action }),
  });
  if (decision === false) {
    return executorFailure(
      'TASK_ROUTINE_AUTHORITY_DENIED',
      'the authority boundary denied execution',
    );
  }
  if (typeof decision === 'object' && decision.ok === false) return decision;
  return null;
}

export function validateRoutineExecutor(
  options: RoutineValidationOptions,
): ValidatedRoutineExecutor | ExecutorFailure {
  const { executor } = options;
  if (executor.kind !== 'routine') {
    return executorFailure(
      'TASK_ROUTINE_KIND_INVALID',
      'the routine adapter only accepts kind=routine',
    );
  }
  const hasAction = typeof executor.action_id === 'string' && executor.action_id.length > 0;
  const hasArgv = Array.isArray(executor.argv);
  if (hasAction === hasArgv) {
    return executorFailure(
      'TASK_ROUTINE_BINDING_INVALID',
      'a routine must declare exactly one registered action or literal argv',
    );
  }
  if (!isRelativeExecutorPath(executor.cwd)) {
    return executorFailure(
      'TASK_ROUTINE_CWD_INVALID',
      'routine cwd must be a contained relative path',
    );
  }
  for (const [kind, paths] of [
    ['input', executor.inputs],
    ['output', executor.outputs],
  ] as const) {
    if (!isUniqueNonEmptyStrings(paths) || paths.some((path) => !isRelativeExecutorPath(path))) {
      return executorFailure(
        `TASK_ROUTINE_${kind.toUpperCase()}S_INVALID`,
        `routine ${kind} paths must be unique contained relative paths`,
      );
    }
  }
  if (
    executor.effects.length === 0 ||
    new Set(executor.effects).size !== executor.effects.length ||
    executor.effects.some((effect) => !isExecutorEffect(effect))
  ) {
    return executorFailure(
      'TASK_ROUTINE_EFFECTS_INVALID',
      'routine effects must be explicit and unique',
    );
  }
  if (!Number.isSafeInteger(executor.timeout_ms) || executor.timeout_ms < 1) {
    return executorFailure(
      'TASK_ROUTINE_TIMEOUT_INVALID',
      'routine timeout must be a positive integer',
    );
  }
  if (
    executor.authority_checks !== undefined &&
    (executor.authority_checks.length === 0 || !isUniqueNonEmptyStrings(executor.authority_checks))
  ) {
    return executorFailure(
      'TASK_ROUTINE_AUTHORITY_CHECKS_INVALID',
      'declared authority checks must be nonempty and unique',
    );
  }

  let action: RoutineActionRegistryEntry | undefined;
  if (hasAction) {
    action = options.actionRegistry?.find((entry) => entry.action_id === executor.action_id);
    if (action === undefined) {
      return executorFailure(
        'TASK_ROUTINE_ACTION_UNAVAILABLE',
        `registered action ${executor.action_id ?? ''} is missing or non-runnable`,
      );
    }
    if (action.effect !== action.authority_contract.effect) {
      return executorFailure(
        'TASK_ROUTINE_ACTION_AUTHORITY_DRIFT',
        `action ${action.action_id} has divergent effect and authority contracts`,
      );
    }
    if (!executor.effects.includes(action.effect)) {
      return executorFailure(
        'TASK_ROUTINE_EFFECT_UNDERDECLARED',
        `routine effects do not include registered action effect ${action.effect}`,
      );
    }
    if (executor.authority_checks === undefined || executor.authority_checks.length === 0) {
      return executorFailure(
        'TASK_ROUTINE_AUTHORITY_CHECKS_REQUIRED',
        'registered action execution requires declared authority checks',
      );
    }
  }

  if (hasArgv) {
    const argv = executor.argv ?? [];
    if (
      argv.length === 0 ||
      !isUniqueNonEmptyStrings(argv.slice(0, 1)) ||
      argv.some((value) => value.includes('\0'))
    ) {
      return executorFailure(
        'TASK_ROUTINE_ARGV_INVALID',
        'literal argv requires a nonempty executable',
      );
    }
    const executable = (argv[0] ?? '').split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
    if (SHELL_EXECUTABLES.has(executable)) {
      return executorFailure(
        'TASK_ROUTINE_SHELL_FORBIDDEN',
        `shell executable ${executable} is forbidden for literal argv`,
      );
    }
  }

  const authorityFailure = validateAuthority(options, action);
  if (authorityFailure !== null) return authorityFailure;
  return hasArgv
    ? { ok: true, source: 'literal-argv', argv: executor.argv }
    : { ok: true, source: 'registered-action', action };
}

export interface RoutineProcessResult {
  readonly exit_code: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface ExecuteRoutineOptions extends RoutineValidationOptions {
  readonly runArgv: (
    argv: readonly string[],
    options: { readonly cwd: string; readonly shell: false; readonly timeout: number },
  ) => RoutineProcessResult | Promise<RoutineProcessResult>;
  readonly runAction?: (
    action: RoutineActionRegistryEntry,
    options: {
      readonly cwd: string;
      readonly shell: false;
      readonly timeout: number;
      readonly inputs: readonly string[];
      readonly outputs: readonly string[];
    },
  ) => RoutineProcessResult | Promise<RoutineProcessResult>;
  /** Accepted only to make the prohibited boundary explicit. It is never invoked. */
  readonly invokeLlm?: (...args: readonly unknown[]) => unknown;
}

export type RoutineExecutionResult =
  | ExecutorFailure
  | {
      readonly ok: true;
      readonly resolved: {
        readonly source: 'literal-argv' | 'registered-action';
        readonly argv?: readonly string[];
        readonly action_id?: string;
        readonly cwd: string;
        readonly effects: readonly ExecutorEffect[];
        readonly timeout_ms: number;
      };
      readonly process: RoutineProcessResult;
    };

export async function executeRoutineExecutor(
  options: ExecuteRoutineOptions,
): Promise<RoutineExecutionResult> {
  const validated = validateRoutineExecutor(options);
  if (!validated.ok) return validated;

  const process =
    validated.source === 'literal-argv'
      ? await options.runArgv(validated.argv ?? [], {
          cwd: options.executor.cwd,
          shell: false,
          timeout: options.executor.timeout_ms,
        })
      : options.runAction === undefined || validated.action === undefined
        ? null
        : await options.runAction(validated.action, {
            cwd: options.executor.cwd,
            shell: false,
            timeout: options.executor.timeout_ms,
            inputs: options.executor.inputs,
            outputs: options.executor.outputs,
          });

  if (process === null) {
    return executorFailure(
      'TASK_ROUTINE_ACTION_ADAPTER_REQUIRED',
      'registered action execution requires an injected action adapter',
    );
  }
  if (process.exit_code !== 0) {
    return executorFailure(
      'TASK_ROUTINE_PROCESS_FAILED',
      `routine process exited with ${String(process.exit_code)}`,
    );
  }
  return {
    ok: true,
    resolved: {
      source: validated.source,
      ...(validated.argv !== undefined && { argv: validated.argv }),
      ...(validated.action !== undefined && { action_id: validated.action.action_id }),
      cwd: options.executor.cwd,
      effects: options.executor.effects,
      timeout_ms: options.executor.timeout_ms,
    },
    process,
  };
}
