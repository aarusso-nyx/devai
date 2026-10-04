import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from '@devai-nyx/authority';
import { parsers } from '@devai-nyx/schemas';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/*
 * Mirrors of law/policy/experimental-execution.json (ADR-MDL-0005, ADR-MDL-0006);
 * a contract test pins them to the policy.
 */
export const EXPERIMENTAL_ACTIVATION_RECORD = '.devai/state/experimental/activation.json';
export const EXPERIMENTAL_MAX_VALIDITY_DAYS = 30;
export const EXPERIMENTAL_DISCIPLINES = ['engineer', 'inspector'] as const;
export const EXPERIMENTAL_RUNTIMES = ['claude-cli', 'codex-cli'] as const;
export const EXPERIMENTAL_CEILINGS = {
  attempts_per_task: 4,
  attempts_per_invocation: 32,
  attempt_wall_clock_minutes: 60,
} as const;

/** The Owner activation (law/schemas/experimental-activation.schema.json). */
export interface ExperimentalActivation {
  readonly schemaVersion: '1.0.0';
  readonly id: 'experimental-activation';
  readonly authority: 'Owner';
  readonly issued_at: string;
  readonly expires_at: string;
  readonly runtimes: readonly {
    readonly runtime: (typeof EXPERIMENTAL_RUNTIMES)[number];
    readonly models: readonly string[];
    readonly efforts: readonly string[];
  }[];
  readonly disciplines: readonly (typeof EXPERIMENTAL_DISCIPLINES)[number][];
  readonly budgets: {
    readonly attempts_per_task: number;
    readonly attempts_per_invocation: number;
    readonly attempt_wall_clock_minutes: number;
    readonly tokens_per_invocation: number;
  };
  readonly note?: string;
}

export type ExperimentalActivationCheck =
  | { readonly ok: true; readonly activation: ExperimentalActivation }
  | { readonly ok: false; readonly code: string };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Clock skew tolerated for an activation issued "now" on another machine. */
const ISSUE_SKEW_MS = 5 * 60 * 1000;

/**
 * Validate an activation against its schema and the policy: it must be in force at
 * `now`, valid for at most the policy's maximum days, and within every ceiling.
 * The schema already confines runtimes and disciplines to the policy's sets.
 */
export function checkExperimentalActivation(
  value: unknown,
  now: Date,
): ExperimentalActivationCheck {
  const parsed = parsers.experimentalActivation.safeParse<ExperimentalActivation>(value);
  if (!parsed.ok) return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_INVALID' };
  const activation = parsed.value;
  const issued = Date.parse(activation.issued_at);
  const expires = Date.parse(activation.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_INVALID' };
  }
  if (issued > now.getTime() + ISSUE_SKEW_MS) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_NOT_YET_VALID' };
  }
  if (expires <= now.getTime()) return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_EXPIRED' };
  if (expires - issued > EXPERIMENTAL_MAX_VALIDITY_DAYS * DAY_MS) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_WINDOW_EXCEEDED' };
  }
  const budgets = activation.budgets;
  if (
    budgets.attempts_per_task > EXPERIMENTAL_CEILINGS.attempts_per_task ||
    budgets.attempts_per_invocation > EXPERIMENTAL_CEILINGS.attempts_per_invocation ||
    budgets.attempt_wall_clock_minutes > EXPERIMENTAL_CEILINGS.attempt_wall_clock_minutes
  ) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_BUDGET_EXCEEDS_CEILING' };
  }
  const runtimes = activation.runtimes.map((entry) => entry.runtime);
  if (new Set(runtimes).size !== runtimes.length) {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_INVALID' };
  }
  return { ok: true, activation };
}

export function experimentalActivationPath(repoRoot: string): string {
  return join(repoRoot, EXPERIMENTAL_ACTIVATION_RECORD);
}

/**
 * Read the activation `round dispatch` relies on. Only the runtime-state record is
 * ever read (ADR-MDL-0006); a file anywhere else, including .devai/config, has no
 * effect. Absent, unreadable, invalid, or expired records refuse with their code.
 */
export function readExperimentalActivation(
  repoRoot: string,
  now: Date,
): ExperimentalActivationCheck {
  const path = experimentalActivationPath(repoRoot);
  if (!existsSync(path)) return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_MISSING' };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, code: 'EXPERIMENTAL_ACTIVATION_INVALID' };
  }
  return checkExperimentalActivation(value, now);
}

/**
 * Replace the activation atomically with an already-checked record. A failed check
 * never reaches this point, so an earlier record is left untouched.
 */
export function writeExperimentalActivation(
  repoRoot: string,
  activation: ExperimentalActivation,
): string {
  const path = experimentalActivationPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.${String(process.pid)}-${randomUUID()}`;
  const fd = openSync(staged, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(activation, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staged, path);
  return path;
}
