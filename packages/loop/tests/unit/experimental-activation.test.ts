// ADR-MDL-0005 D-1/D-5 and ADR-MDL-0006: activation checks mirror the experimental-execution
// policy exactly, and only the runtime-state record is ever read.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runWithAuthorityHostEffects,
  type AuthorityHostEffectRequest,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import {
  createIssuer,
  runtimeApi,
} from '../../../authority/tests/unit/authority-runtime-testkit.js';
import {
  EXPERIMENTAL_ACTIVATION_LOCK,
  EXPERIMENTAL_ACTIVATION_RECORD,
  EXPERIMENTAL_CEILINGS,
  EXPERIMENTAL_DISCIPLINES,
  EXPERIMENTAL_MAX_VALIDITY_DAYS,
  EXPERIMENTAL_RUNTIMES,
  EXPERIMENTAL_WITHDRAWALS_DIR,
  ExperimentalActivationLockStale,
  checkExperimentalActivation,
  readExperimentalActivation,
  withdrawExperimentalActivation,
  writeExperimentalActivation,
  type ExperimentalActivation,
} from '../../src/loop/experimental-activation.js';

/** Run with every host effect permitted, optionally intercepted before it applies. */
async function effects<T>(
  run: () => T,
  intercept?: (request: AuthorityHostEffectRequest, apply: () => unknown) => unknown,
): Promise<T> {
  const issuer = createIssuer(await runtimeApi(), { invocation_id: 'activation-lock' });
  const scope: AuthorityHostEffectScope = {
    action_id: 'round dispatch deactivate',
    invocation_id: 'activation-lock',
    effect: 'local-write',
    receipt_store: issuer,
    apply_effect: intercept ?? ((_request, apply) => apply()),
  };
  try {
    return await runWithAuthorityHostEffects(scope, async () => run());
  } finally {
    issuer.dispose();
  }
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const NOW = new Date('2026-10-04T12:00:00.000Z');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function activation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'experimental-activation',
    authority: 'Owner',
    issued_at: '2026-10-04T11:00:00.000Z',
    expires_at: '2026-10-18T11:00:00.000Z',
    runtimes: [{ runtime: 'codex-cli', models: ['gpt-x'], efforts: ['high'] }],
    disciplines: ['inspector'],
    budgets: {
      attempts_per_task: 4,
      attempts_per_invocation: 32,
      attempt_wall_clock_minutes: 60,
      tokens_per_invocation: 1,
    },
    ...overrides,
  };
}

describe('experimental activation checks', () => {
  it('mirror law/policy/experimental-execution.json', () => {
    const policy = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, 'law/policy/experimental-execution.json'), 'utf8'),
    ) as Record<string, Record<string, unknown> & unknown>;
    expect(policy['activation']).toMatchObject({
      record: EXPERIMENTAL_ACTIVATION_RECORD,
      max_validity_days: EXPERIMENTAL_MAX_VALIDITY_DAYS,
      writer: 'round dispatch activate',
    });
    expect(policy['ceilings']).toMatchObject(EXPERIMENTAL_CEILINGS);
    expect(policy['disciplines']).toEqual([...EXPERIMENTAL_DISCIPLINES]);
    expect(policy['runtimes']).toEqual([...EXPERIMENTAL_RUNTIMES]);
  });

  it('admits an activation exactly at every ceiling', () => {
    expect(checkExperimentalActivation(activation(), NOW)).toMatchObject({ ok: true });
  });

  it.each([
    [{ issued_at: '2026-10-05T00:00:00.000Z' }, 'EXPERIMENTAL_ACTIVATION_NOT_YET_VALID'],
    [{ expires_at: '2026-10-04T11:30:00.000Z' }, 'EXPERIMENTAL_ACTIVATION_EXPIRED'],
    [{ expires_at: '2026-10-04T10:00:00.000Z' }, 'EXPERIMENTAL_ACTIVATION_INVALID'],
    [{ expires_at: '2026-11-04T11:00:01.000Z' }, 'EXPERIMENTAL_ACTIVATION_WINDOW_EXCEEDED'],
    [
      {
        runtimes: [
          { runtime: 'codex-cli', models: ['a'], efforts: ['high'] },
          { runtime: 'codex-cli', models: ['b'], efforts: ['low'] },
        ],
      },
      'EXPERIMENTAL_ACTIVATION_INVALID',
    ],
    [{ disciplines: ['architect'] }, 'EXPERIMENTAL_ACTIVATION_INVALID'],
  ])('refuses %j', (change, code) => {
    expect(checkExperimentalActivation(activation(change), NOW)).toEqual({ ok: false, code });
  });

  it('reads only the runtime-state record and refuses an unreadable one', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-experimental-activation-'));
    roots.push(root);
    expect(readExperimentalActivation(root, NOW)).toEqual({
      ok: false,
      code: 'EXPERIMENTAL_ACTIVATION_MISSING',
    });
    mkdirSync(join(root, '.devai/state/experimental'), { recursive: true });
    writeFileSync(join(root, EXPERIMENTAL_ACTIVATION_RECORD), '{');
    expect(readExperimentalActivation(root, NOW)).toEqual({
      ok: false,
      code: 'EXPERIMENTAL_ACTIVATION_INVALID',
    });
    writeFileSync(join(root, EXPERIMENTAL_ACTIVATION_RECORD), JSON.stringify(activation()));
    expect(readExperimentalActivation(root, NOW)).toMatchObject({ ok: true });
  });
});

describe('activation writes and withdrawals serialize (ADR-MDL-0007)', () => {
  const first = () => activation() as unknown as ExperimentalActivation;
  const second = () => activation({ note: 'second' }) as unknown as ExperimentalActivation;

  it('refuses an activation while a withdrawal holds the lock, so it removes only the record it names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-experimental-activation-'));
    roots.push(root);
    const record = join(root, EXPERIMENTAL_ACTIVATION_RECORD);
    await effects(() => writeExperimentalActivation(root, first()));
    const named = sha256(record);
    let concurrent: unknown;
    const withdrawn = await effects(
      () => withdrawExperimentalActivation({ repoRoot: root }),
      (request, apply) => {
        const applied = apply();
        if (
          concurrent === undefined &&
          request.symbol === 'renameSync' &&
          String(request.arguments[1]).includes(EXPERIMENTAL_WITHDRAWALS_DIR)
        ) {
          // An activation arrives between the withdrawal record and the removal.
          try {
            writeExperimentalActivation(root, second());
            concurrent = 'replaced';
          } catch (error) {
            concurrent = (error as { code?: string }).code;
          }
        }
        return applied;
      },
    );
    expect(concurrent).toBe('EXPERIMENTAL_ACTIVATION_BUSY');
    expect(withdrawn.withdrawal.record_sha256).toBe(named);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(join(root, EXPERIMENTAL_ACTIVATION_LOCK))).toBe(false);
    // Once the withdrawal finished, the next activation is admitted.
    await effects(() => writeExperimentalActivation(root, second()));
    expect(readFileSync(record, 'utf8')).toContain('second');
  });

  it('never removes a record that a lock-bypassing writer replaced after it was named', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-experimental-activation-'));
    roots.push(root);
    const record = join(root, EXPERIMENTAL_ACTIVATION_RECORD);
    await effects(() => writeExperimentalActivation(root, first()));
    let replaced = false;
    await effects(
      () => {
        expect(() => withdrawExperimentalActivation({ repoRoot: root })).toThrow(
          'EXPERIMENTAL_ACTIVATION_CHANGED',
        );
      },
      (request, apply) => {
        const applied = apply();
        if (
          !replaced &&
          request.symbol === 'renameSync' &&
          String(request.arguments[1]).includes(EXPERIMENTAL_WITHDRAWALS_DIR)
        ) {
          replaced = true;
          writeFileSync(record, `${JSON.stringify(second(), null, 2)}\n`);
        }
        return applied;
      },
    );
    expect(readFileSync(record, 'utf8')).toContain('second');
  });

  it('never takes a lock over: a gone writer refuses as stale with its removal step, a live one as busy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-experimental-activation-'));
    roots.push(root);
    const lock = join(root, EXPERIMENTAL_ACTIVATION_LOCK);
    const record = join(root, EXPERIMENTAL_ACTIVATION_RECORD);
    mkdirSync(join(root, '.devai/state/experimental'), { recursive: true });
    const gone = spawnSync(process.execPath, ['--version']).pid;
    const stale = JSON.stringify({ pid: gone, hostname: hostname(), token: 'gone' });
    writeFileSync(lock, stale);
    let refusal: unknown;
    await effects(() => {
      try {
        writeExperimentalActivation(root, first());
      } catch (error) {
        refusal = error;
      }
    });
    expect(refusal).toBeInstanceOf(ExperimentalActivationLockStale);
    expect(refusal).toMatchObject({
      code: 'EXPERIMENTAL_ACTIVATION_LOCK_STALE',
      removal: `rm "${lock}"`,
    });
    expect((refusal as ExperimentalActivationLockStale).detail).toContain(
      EXPERIMENTAL_ACTIVATION_LOCK,
    );
    // Nothing was taken over: the stale lock is untouched and nothing was written.
    expect(readFileSync(lock, 'utf8')).toBe(stale);
    expect(existsSync(record)).toBe(false);
    // The human removal step, then the activation is admitted and its lock released.
    rmSync(lock);
    await effects(() => writeExperimentalActivation(root, first()));
    expect(existsSync(lock)).toBe(false);
    const live = JSON.stringify({ pid: process.pid, hostname: hostname(), token: 'live' });
    writeFileSync(lock, live);
    await effects(() => {
      expect(() => writeExperimentalActivation(root, second())).toThrow(
        'EXPERIMENTAL_ACTIVATION_BUSY',
      );
      expect(() => withdrawExperimentalActivation({ repoRoot: root })).toThrow(
        'EXPERIMENTAL_ACTIVATION_BUSY',
      );
    });
    // Only the token owner removes a lock.
    expect(readFileSync(lock, 'utf8')).toBe(live);
    expect(readFileSync(record, 'utf8')).not.toContain('second');
  });
});
