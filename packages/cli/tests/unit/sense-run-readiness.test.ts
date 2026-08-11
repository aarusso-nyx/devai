// Invariants: INV-DEVAI-019
import { describe, expect, it, vi } from 'vitest';
import { readOnlyDevaiChild } from '../../src/authority/sense-run-child.js';
import { routeArgv } from '../../src/command-router.js';
import type { RegistryEntry } from '../../src/define-command.js';
import { resolveSenseSelection } from '../../src/commands/sense/facade.js';
import { ACTION_REGISTRY } from '../../src/generated/action-registry.js';
import * as runSet from '../../src/commands/sense/run-set.js';

const mocks = vi.hoisted(() => ({
  sensorAdapter: vi.fn(),
}));

vi.mock('../../src/commands/sense/adapters.js', () => ({
  sensorAdapter: mocks.sensorAdapter,
}));

type Child = {
  readonly command: string;
  readonly processStatus: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly na?: boolean;
};

type Aggregate = {
  readonly execution_status: 'pass' | 'error';
  readonly readiness_status: 'pass' | 'review' | 'fail' | 'unknown' | 'na';
  readonly applicable_count: number;
  readonly na_count: number;
  readonly counts: Record<string, number>;
};

function reading(status: string): string {
  return JSON.stringify({ status });
}

function aggregate(children: readonly Child[]): Aggregate {
  const fn = (
    runSet as unknown as { aggregateSensorRunResults?: (c: readonly Child[]) => Aggregate }
  ).aggregateSensorRunResults;
  expect(fn, 'run-set must export its deterministic structured aggregator').toBeTypeOf('function');
  if (fn === undefined) throw new Error('aggregateSensorRunResults is not implemented');
  return fn(children);
}

const canonicalSenseRun = ACTION_REGISTRY.find((entry) => entry.action_id === 'sense run');
if (canonicalSenseRun === undefined) throw new Error('SENSE_RUN_REGISTRY_ENTRY_MISSING');

const senseRunEntry = {
  name: canonicalSenseRun.action_id,
  handler: canonicalSenseRun.handler,
  internal_name: canonicalSenseRun.handler.replaceAll(' ', '-'),
  path: canonicalSenseRun.path,
  status: canonicalSenseRun.status,
  lifecycle: canonicalSenseRun.status === 'preview' ? 'experimental' : 'supported',
  lifecycle_reason:
    canonicalSenseRun.status === 'preview'
      ? 'Preview action; contract may change before v1.0.'
      : 'Stable action.',
  promotion_criteria: [],
  visibility: canonicalSenseRun.status === 'internal' ? 'maintainer' : 'standard',
  tier: canonicalSenseRun.status === 'internal' ? 'plumbing' : 'porcelain',
  profiles: canonicalSenseRun.profiles,
  effects: canonicalSenseRun.effect,
  authority: canonicalSenseRun.authority ?? 'mesh_controller',
  description: canonicalSenseRun.description,
  authority_contract_version: canonicalSenseRun.authority_contract_version,
  authority_contract: canonicalSenseRun.authority_contract,
  output_contract: canonicalSenseRun.output_contract,
  error_contract: canonicalSenseRun.error_contract,
} satisfies RegistryEntry;

function routeSense(args: readonly string[]) {
  return routeArgv(['node', '/cli.js', 'sense', 'run', ...args], [senseRunEntry], '1.0.0');
}

describe('sense run readiness aggregation', () => {
  it('resolves exact kind and preset effects with per-member consent before execution', () => {
    for (const [kind, effect, write, publish] of [
      ['type_check', 'read', false, false],
      ['unit_test', 'harness-write', true, false],
      ['build', 'local-write', true, false],
      ['inventory_regeneration', 'harness-write', true, false],
      ['llm_judge', 'remote-write', true, true],
    ] as const) {
      expect(resolveSenseSelection({ kind }).members).toEqual([
        expect.objectContaining({ kind, effect, consent: { write, publish } }),
      ]);
    }

    const baseline = resolveSenseSelection({ preset: 'baseline' });
    expect(baseline).toMatchObject({
      selection: { type: 'preset', value: 'baseline' },
      aggregate_effect: 'local-write',
      generic_ceiling: 'remote-write',
      implicit_persistence: false,
    });
    expect(
      baseline.members.map(({ kind, effect, consent }) => ({ kind, effect, consent })),
    ).toEqual([
      { kind: 'build', effect: 'local-write', consent: { write: true, publish: false } },
      { kind: 'lint', effect: 'read', consent: { write: false, publish: false } },
      { kind: 'type_check', effect: 'read', consent: { write: false, publish: false } },
      { kind: 'unit_test', effect: 'harness-write', consent: { write: true, publish: false } },
    ]);

    expect(() => resolveSenseSelection({ preset: 'sweep' })).toThrow('SENSE_ROUND_REQUIRED');
    const sweep = resolveSenseSelection({ preset: 'sweep' }, { roundId: 'R-0007' });
    expect(sweep.members.every((member) => member.effect === 'read')).toBe(true);
    expect(sweep.members.every((member) => !member.consent.write && !member.consent.publish)).toBe(
      true,
    );
    expect(sweep.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'inventory_regeneration', effect: 'harness-write' }),
        expect.objectContaining({ kind: 'llm_judge', effect: 'remote-write' }),
      ]),
    );
    expect(() => resolveSenseSelection({ kind: 'unknown_kind' })).toThrow(
      'SENSE_KIND_UNKNOWN:unknown_kind',
    );
    for (const name of ['tier1', 'tier2', 'tier3', 'all', 'old_sweep']) {
      expect(() => resolveSenseSelection({ preset: name })).toThrow(`SENSE_PRESET_UNKNOWN:${name}`);
    }
  });

  it('enforces resolved read, local, harness, and independently consented remote effects', () => {
    expect(routeSense(['type_check'])).toMatchObject({
      kind: 'dispatch',
      argv: ['node', '/cli.js', 'sense-run', 'type_check'],
    });

    for (const kind of ['unit_test', 'build', 'inventory_regeneration']) {
      expect(routeSense([kind])).toMatchObject({
        kind: 'output',
        exitCode: 2,
        text: expect.stringContaining('local mutation requires --write'),
      });
      expect(routeSense([kind, '--write'])).toMatchObject({
        kind: 'dispatch',
        argv: ['node', '/cli.js', 'sense-run', kind],
      });
    }

    expect(routeSense(['llm_judge'])).toMatchObject({
      kind: 'output',
      exitCode: 2,
      text: expect.stringContaining('remote mutation requires --write --publish'),
    });
    expect(routeSense(['llm_judge', '--write'])).toMatchObject({ kind: 'output', exitCode: 2 });
    expect(routeSense(['llm_judge', '--publish'])).toMatchObject({ kind: 'output', exitCode: 2 });
    expect(routeSense(['llm_judge', '--write', '--publish'])).toMatchObject({
      kind: 'dispatch',
      argv: ['node', '/cli.js', 'sense-run', 'llm_judge'],
    });
  });

  it('plans and executes direct in-process adapters without child-route aliases', async () => {
    const adapter = vi.fn(async () => ({
      sensor: { kind: 'decision_record_integrity' },
      status: 'pass',
    }));
    mocks.sensorAdapter.mockReset();
    mocks.sensorAdapter.mockReturnValue(adapter);
    const resolved = resolveSenseSelection({ kind: 'decision_record_integrity' });

    await expect(
      runSet.executeResolvedSenseSelection(resolved, {
        repoRoot: '/repo',
        inputs: { fixture: true },
      }),
    ).resolves.toEqual([
      {
        command: 'devai sense run decision_record_integrity',
        processStatus: 0,
        stdout: JSON.stringify({
          sensor: { kind: 'decision_record_integrity' },
          status: 'pass',
        }),
        stderr: '',
        na: false,
      },
    ]);
    expect(mocks.sensorAdapter).toHaveBeenCalledOnce();
    expect(mocks.sensorAdapter).toHaveBeenCalledWith('decision_record_integrity');
    expect(adapter).toHaveBeenCalledWith({ repoRoot: '/repo', inputs: { fixture: true } });

    expect(routeSense(['decision_record_integrity', '--repo-root', '/repo'])).toMatchObject({
      kind: 'dispatch',
      argv: ['node', '/cli.js', 'sense-run', 'decision_record_integrity', '--repo-root', '/repo'],
    });
    expect(
      routeArgv(
        ['node', '/cli.js', 'sense', 'decision', 'record', 'integrity'],
        [senseRunEntry],
        '1.0.0',
      ),
    ).toMatchObject({ kind: 'output', exitCode: 2 });
    expect(routeSense(['unknown_kind'])).toMatchObject({
      kind: 'output',
      exitCode: 2,
      text: expect.stringContaining('Run devai sense run --help.'),
    });
  });

  it('admits only an exact read-only public sensor child under the aggregate scope', () => {
    const admits = readOnlyDevaiChild as (
      executable: string,
      args: readonly string[],
      entries: readonly unknown[],
      parentAction: string,
    ) => boolean;
    const currentCli = process.argv[1] ?? '';
    const readEntry = {
      internal_name: 'sense-type-check',
      path: ['sense', 'type', 'check'],
      effects: 'read',
      previous_name: 'sense type check',
    };
    const writeEntry = { ...readEntry, internal_name: 'sense-write', effects: 'local-write' };

    expect(
      admits(
        process.execPath,
        [currentCli, 'sense', 'type', 'check', '--repo-root', '/repo'],
        [readEntry],
        'sense run',
      ),
    ).toBe(true);
    expect(
      admits(
        process.execPath,
        [currentCli, 'sense', 'unknown', '--repo-root', '/repo'],
        [readEntry],
        'sense run',
      ),
    ).toBe(false);
    expect(
      admits(
        process.execPath,
        [currentCli, 'sense', 'write', '--repo-root', '/repo'],
        [writeEntry],
        'sense run',
      ),
    ).toBe(false);
    expect(
      admits(
        process.execPath,
        [currentCli, 'sense', 'type', 'check', '--repo-root', '/repo', '--write'],
        [readEntry],
        'sense run',
      ),
    ).toBe(false);
    expect(
      admits(
        process.execPath,
        [currentCli, 'sense-type-check', '--repo-root', '/repo'],
        [readEntry],
        'sense run',
      ),
    ).toBe(false);
  });

  it('preserves N/A, REVIEW, and UNKNOWN without translating them to PASS or FAIL', () => {
    const result = aggregate([
      { command: 'one', processStatus: 0, stdout: reading('pass'), stderr: '' },
      { command: 'two', processStatus: 0, stdout: reading('review'), stderr: '' },
      { command: 'three', processStatus: 0, stdout: reading('unknown'), stderr: '' },
      { command: 'four', processStatus: 0, stdout: reading('pass'), stderr: '', na: true },
    ]);

    expect(result).toMatchObject({
      execution_status: 'pass',
      readiness_status: 'review',
      applicable_count: 3,
      na_count: 1,
    });
    expect(result.counts).toMatchObject({ pass: 1, review: 1, unknown: 1, na: 1 });
  });

  it('returns readiness N/A when every configured child is N/A', () => {
    expect(
      aggregate([
        { command: 'one', processStatus: 0, stdout: reading('pass'), stderr: '', na: true },
        { command: 'two', processStatus: 0, stdout: reading('review'), stderr: '', na: true },
      ]),
    ).toMatchObject({ execution_status: 'pass', readiness_status: 'na', applicable_count: 0 });
  });

  it('classifies malformed JSON and spawn failures as execution ERROR, not readiness FAIL', () => {
    const malformed = aggregate([
      { command: 'one', processStatus: 0, stdout: 'not-json', stderr: '' },
    ]);
    const spawnFailure = aggregate([
      { command: 'two', processStatus: null, stdout: '', stderr: 'ENOENT' },
    ]);

    expect(malformed.execution_status).toBe('error');
    expect(spawnFailure.execution_status).toBe('error');
    expect(malformed.readiness_status).not.toBe('fail');
    expect(spawnFailure.readiness_status).not.toBe('fail');
  });
});
