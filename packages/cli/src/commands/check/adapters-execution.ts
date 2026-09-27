import { resolve } from 'node:path';
import { spawnSync } from '@devai-nyx/authority';
import { executeRoutineExecutor } from '@devai-nyx/loop';
import { ACTION_REGISTRY } from '../../generated/action-registry.js';
import type { CheckStatus, ResolvedCheckMember } from './contracts.js';

export interface CheckExecutionOptions {
  readonly repoRoot: string;
  readonly schema?: string;
  readonly instance?: string;
  readonly file?: string;
  readonly witness?: string;
  readonly databaseUrl?: string;
  readonly prBodyFile?: string;
  readonly optional?: boolean;
  readonly strict?: boolean;
  readonly sinceRef?: string;
  readonly maxCommits?: number;
  readonly skipPublishCheck?: boolean;
  readonly mutationBaseline?: string;
  readonly mutationCurrent?: string;
  readonly mutationThresholds?: string;
}

export interface RawExecution {
  readonly status: CheckStatus;
  readonly value?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exit_code?: number | null;
  readonly code?: string;
  readonly message?: string;
}

interface ProcessCapture {
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function statusFromValue(value: unknown): CheckStatus {
  const object = record(value);
  if (object === undefined) return 'pass';
  const raw = object['status'] ?? object['verdict'];
  if (typeof raw === 'string') {
    switch (raw.toLowerCase()) {
      case 'pass':
      case 'green':
      case 'valid':
        return 'pass';
      case 'warn':
      case 'review':
      case 'amber':
      case 'yellow':
        return 'review';
      case 'fail':
      case 'block':
      case 'red':
      case 'invalid':
        return 'fail';
      case 'unknown':
      case 'inconclusive':
        return 'unknown';
      case 'na':
      case 'n/a':
      case 'skipped':
        return 'na';
      case 'error':
      case 'killed':
      case 'crash':
        return 'error';
      default:
        return 'error';
    }
  }
  if (typeof object['ok'] === 'boolean') return object['ok'] ? 'pass' : 'fail';
  if (typeof object['valid'] === 'boolean') return object['valid'] ? 'pass' : 'fail';
  return 'pass';
}

export function fromValue(value: unknown): RawExecution {
  return { status: statusFromValue(value), value };
}

function parseProcess(capture: ProcessCapture): RawExecution {
  if (capture.exit_code === null) {
    return { status: 'error', ...capture, code: 'CHECK_PROCESS_NO_EXIT' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(capture.stdout.trim()) as unknown;
  } catch {
    parsed = undefined;
  }
  const structured = parsed === undefined ? undefined : statusFromValue(parsed);
  if (structured === 'error') return { status: 'error', value: parsed, ...capture };
  if (capture.exit_code !== 0) {
    return { status: structured === 'review' ? 'review' : 'fail', value: parsed, ...capture };
  }
  return { status: structured ?? 'pass', value: parsed, ...capture };
}

function timeoutFor(member: ResolvedCheckMember): number {
  return member.cost === 'high' ? 3_600_000 : member.cost === 'medium' ? 600_000 : 120_000;
}

export async function executeArgv(
  member: ResolvedCheckMember,
  argv: readonly string[],
  repoRoot: string,
): Promise<RawExecution> {
  let capture: ProcessCapture | undefined;
  const checkAction = ACTION_REGISTRY.find((entry) => entry.action_id === 'check');
  if (checkAction === undefined) throw new Error('CHECK_ACTION_CONTRACT_MISSING');
  const execution = await executeRoutineExecutor({
    executor: {
      kind: 'routine',
      argv,
      cwd: '.',
      inputs: [],
      outputs: [],
      effects: [member.effect],
      timeout_ms: timeoutFor(member),
    },
    authority: {
      discipline: 'inspector',
      capabilities: checkAction.authority_contract.capabilities,
      write: true,
      allow_publish: false,
    },
    runArgv: (command, options) => {
      const result = spawnSync(command[0] ?? '', command.slice(1), {
        cwd: resolve(repoRoot, options.cwd),
        encoding: 'utf8',
        shell: false,
        timeout: options.timeout,
        env: process.env,
      });
      capture = {
        exit_code: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
      return capture;
    },
  });
  if (capture !== undefined) return parseProcess(capture);
  return {
    status: 'error',
    code: execution.ok ? 'CHECK_PROCESS_RESULT_MISSING' : execution.code,
    message: execution.ok ? 'routine executor returned no process result' : execution.message,
  };
}
