// ADR-MDL-0005 D-1/D-5 and ADR-MDL-0006: activation checks mirror the experimental-execution
// policy exactly, and only the runtime-state record is ever read.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXPERIMENTAL_ACTIVATION_RECORD,
  EXPERIMENTAL_CEILINGS,
  EXPERIMENTAL_DISCIPLINES,
  EXPERIMENTAL_MAX_VALIDITY_DAYS,
  EXPERIMENTAL_RUNTIMES,
  checkExperimentalActivation,
  readExperimentalActivation,
} from '../../src/loop/experimental-activation.js';

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
