// ADR-MDL-0005: the experimental-execution policy, the Owner activation record, the
// dispatch journal, and version-2 usage evidence that never records a missing counter as 0.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator, ROSTER } from '../../src/index.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const json = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(json('law/schemas/common-defs.schema.json') as object);
ajv.addSchema(json('law/schemas/task-execution-evidence.schema.json') as object);
const EVIDENCE = 'https://devai.nyxk.com.br/schemas/task-execution-evidence.schema.json';
const def = (name: string) => {
  const validate = ajv.getSchema(`${EVIDENCE}#/$defs/${name}`);
  if (validate === undefined) throw new Error(`missing $defs/${name}`);
  return (value: unknown): boolean => validate(value) === true;
};

function activation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    id: 'experimental-activation',
    authority: 'Owner',
    issued_at: '2026-10-04T00:00:00.000Z',
    expires_at: '2026-10-18T00:00:00.000Z',
    runtimes: [{ runtime: 'claude-cli', models: ['claude-opus-5-5'], efforts: ['high'] }],
    disciplines: ['engineer'],
    budgets: {
      attempts_per_task: 4,
      attempts_per_invocation: 8,
      attempt_wall_clock_minutes: 30,
      tokens_per_invocation: 2_000_000,
    },
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0.0',
    round_id: 'R-0001',
    task_id: 'TASK-0001',
    attempt: 1,
    event: 'spawned',
    at: '2026-10-04T00:00:00.000Z',
    experimental: true,
    previous_sha256: null,
    pid: 4242,
    ...overrides,
  };
}

const counter = (value: number | null, status: string) => ({ value, status });

describe('experimental execution law (ADR-MDL-0005)', () => {
  it('joins the governed schema roster', () => {
    for (const name of [
      'experimental-execution.schema.json',
      'experimental-activation.schema.json',
      'dispatch-journal-event.schema.json',
    ]) {
      expect(ROSTER).toContain(name);
    }
  });

  it('the framework policy validates and keeps the ratified rules', () => {
    const policy = json('law/policy/experimental-execution.json') as Record<string, unknown>;
    expect(getValidator('experimental-execution.schema.json')(policy)).toBe(true);
    expect(policy).toMatchObject({
      disciplines: ['engineer', 'inspector'],
      runtimes: ['claude-cli', 'codex-cli'],
      attempts: { default_tier: 3, bumped_tier: 1, exhausted_status: 'experimental_blocked' },
      ceilings: {
        attempts_per_task: 4,
        attempts_per_invocation: 32,
        attempt_wall_clock_minutes: 60,
      },
      containment: { remote_effects: 'forbidden' },
      evidence: { promoting: false, missing_counter: 'missing-never-zero' },
    });
  });

  it('admits an Owner activation within the ceilings and refuses anything wider', () => {
    const validate = getValidator('experimental-activation.schema.json');
    expect(validate(activation())).toBe(true);
    expect(validate(activation({ disciplines: ['architect'] }))).toBe(false);
    expect(validate(activation({ authority: 'Engineer' }))).toBe(false);
    expect(
      validate(activation({ runtimes: [{ runtime: 'other-cli', models: ['m'], efforts: ['e'] }] })),
    ).toBe(false);
    const { tokens_per_invocation: _omitted, ...noTokens } = activation().budgets;
    void _omitted;
    expect(validate(activation({ budgets: noTokens }))).toBe(false);
    expect(
      validate(activation({ budgets: { ...activation().budgets, attempts_per_task: 5 } })),
    ).toBe(false);
  });

  it('requires each journal event to carry its boundary facts', () => {
    const validate = getValidator('dispatch-journal-event.schema.json');
    expect(validate(event())).toBe(true);
    expect(validate(event({ event: 'intent', pid: undefined }))).toBe(false);
    expect(
      validate(
        event({
          event: 'intent',
          runtime: 'codex-cli',
          model: 'gpt-x',
          effort: 'high',
          tier: 'default',
          prompt_sha256: 'a'.repeat(64),
        }),
      ),
    ).toBe(true);
    expect(validate(event({ event: 'exited' }))).toBe(false);
    expect(validate(event({ event: 'settled', outcome: 'pass' }))).toBe(true);
    expect(validate(event({ experimental: false }))).toBe(false);
    expect(validate(event({ attempt: 5 }))).toBe(false);
  });

  it('never records a missing usage counter as zero', () => {
    const usage = def('usageEvidenceV2');
    const v2 = {
      usage_version: 2,
      counter_mode: 'cumulative-delta',
      derivation: 'session total minus the previous attempt total',
      input_tokens: counter(1200, 'derived'),
      output_tokens: counter(300, 'reported'),
      cache_read_tokens: counter(null, 'missing'),
      cache_write_tokens: counter(null, 'missing'),
    };
    expect(usage(v2)).toBe(true);
    expect(usage({ ...v2, cache_read_tokens: counter(0, 'missing') })).toBe(false);
    expect(usage({ ...v2, output_tokens: counter(null, 'reported') })).toBe(false);
    expect(usage({ ...v2, input_tokens: counter(-1, 'derived') })).toBe(false);
  });

  it('keeps version-1 usage valid and admits an unknown cost only as null', () => {
    expect(def('usageEvidence')({ input_tokens: 1, output_tokens: 2 })).toBe(true);
    const unknown = def('costUnknown');
    expect(unknown({ amount: null, currency: 'USD', source: 'unknown' })).toBe(true);
    expect(unknown({ amount: 0, currency: 'USD', source: 'unknown' })).toBe(false);
  });
});
