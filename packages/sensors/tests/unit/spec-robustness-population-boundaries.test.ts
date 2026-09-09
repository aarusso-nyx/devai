import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseSpecRobustnessTargets } from '../../src/spec-robustness-targets.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

function write(path: string, contents: unknown): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function invariant(name: string): void {
  write(`law/invariants/${name}.json`, {
    id: `INV-${name}`,
    type: 'error_semantics',
    statement: 'Missing resources return a stable error code.',
  });
}

function errorContract(name = 'errors.json'): void {
  write(`docs/reference/contracts/${name}`, '{}');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-spec-robustness-boundaries-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('spec robustness population boundaries', () => {
  it('fails when neither robustness population is present', () => {
    const reading = senseSpecRobustnessTargets({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'fail',
      timestamp: NOW,
      sensor: { name: 'spec-robustness-targets', kind: 'spec_robustness_targets' },
      metrics: { error_semantics_invariants: 0, error_contract_files: 0, targets_total: 0 },
      findings: [
        {
          severity: 'error',
          code: 'SPEC_ROBUSTNESS_NO_TARGETS',
          message: 'No error_semantics invariants and no error-contract files.',
        },
      ],
    });
  });

  it('reviews a report with only an error-semantics invariant', () => {
    invariant('error-semantics');

    const reading = senseSpecRobustnessTargets({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: { error_semantics_invariants: 1, error_contract_files: 0, targets_total: 1 },
      findings: [
        {
          severity: 'warning',
          code: 'SPEC_ROBUSTNESS_PARTIAL',
          message:
            'Partial robustness targets: 1 invariants, 0 error contracts. Both should be ≥ 1.',
        },
      ],
    });
  });

  it('reviews a report with only an error-contract file', () => {
    errorContract();

    const reading = senseSpecRobustnessTargets({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'review',
      metrics: { error_semantics_invariants: 0, error_contract_files: 1, targets_total: 1 },
      findings: [
        {
          severity: 'warning',
          code: 'SPEC_ROBUSTNESS_PARTIAL',
          message:
            'Partial robustness targets: 0 invariants, 1 error contracts. Both should be ≥ 1.',
        },
      ],
    });
  });

  it('passes when both robustness populations are present', () => {
    invariant('error-semantics');
    errorContract();

    const reading = senseSpecRobustnessTargets({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      timestamp: NOW,
      findings: [],
      metrics: { error_semantics_invariants: 1, error_contract_files: 1, targets_total: 2 },
    });
  });

  it('retains exact population counts when each side has multiple entries', () => {
    invariant('error-one');
    invariant('error-two');
    errorContract('errors-one.json');
    errorContract('errors-two.json');

    const reading = senseSpecRobustnessTargets({ repoRoot: root, now: NOW });

    expect(reading).toMatchObject({
      status: 'pass',
      metrics: { error_semantics_invariants: 2, error_contract_files: 2, targets_total: 4 },
    });
  });
});
