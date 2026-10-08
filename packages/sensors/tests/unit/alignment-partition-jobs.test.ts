// ADR-CHK-0007 rule 11 with ADR-SCR-0013: once the gate is split into gate-cli, gate-rest and
// the always() aggregator, the alignment sensor still reads the gate invariant producers and
// the affected check wherever they run across the partition jobs, and a job that may not run
// on a pull request still proves nothing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hasExecutableMeasurement,
  hasExecutableProducer,
  loadRunSteps,
} from '../../src/harness-invariant-alignment-workflow.js';

const CLI = 'node .devai/state/pr-bootstrap/cli/bin.js';
const BLUEPRINT = ['check', '--only', 'blueprint', '--file', 'fixtures/blueprint.json'];
const PACKS = [
  'sense',
  'inventory',
  '--slice',
  'pack',
  '--packs-root',
  'fixtures/packs',
  '--adopter-root',
  'fixtures/packs',
];

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? '', { recursive: true, force: true });
});

function threeJobs(restCondition = ''): string {
  return `name: Pull request preflight
on:
  pull_request:
  merge_group:
jobs:
  gate-cli:
    name: gate-cli
    runs-on: ubuntu-latest
    steps:
      - name: Preflight probes
        shell: bash
        run: |
          set -euo pipefail
          ${CLI} check --preflight --run --base "$DEVAI_PREFLIGHT_BASE" --format json
      - name: Affected checks
        shell: bash
        run: |
          set -euo pipefail
          ${CLI} check --affected --run --base "$DEVAI_PREFLIGHT_BASE" --partition-include test:cli --format json
  gate-rest:
    name: gate-rest
    runs-on: ubuntu-latest${restCondition}
    steps:
      - name: Gate invariant producers
        shell: bash
        run: |
          set -euo pipefail
          ${CLI} ${BLUEPRINT.join(' ')} --format human
          ${CLI} ${PACKS.join(' ')} --format human
      - name: Affected checks
        shell: bash
        run: |
          set -euo pipefail
          pnpm run release:pr-gate -- "$DEVAI_PREFLIGHT_BASE"
          ${CLI} check --affected --run --base "$DEVAI_PREFLIGHT_BASE" --partition-exclude test:cli --format json
  gate:
    name: devai-release-gate
    needs: [gate-cli, gate-rest]
    if: \${{ always() }}
    runs-on: ubuntu-latest
    steps:
      - name: Aggregate the partition reports
        run: node scripts/aggregate-gate-partitions.mjs --include-report a --exclude-report b --include-result x --exclude-result y
`;
}

function steps(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'devai-alignment-partitions-'));
  roots.push(root);
  const file = join(root, 'pull-request-checks.yml');
  writeFileSync(file, content);
  return loadRunSteps([file]);
}

describe('alignment across the partition jobs (ADR-CHK-0007 rule 11, ADR-SCR-0013)', () => {
  it('reads run steps from every job of the three-job workflow', () => {
    const scripts = steps(threeJobs()).map((step) => step.script);
    expect(scripts.some((script) => script.includes('--partition-include test:cli'))).toBe(true);
    expect(scripts.some((script) => script.includes('--partition-exclude test:cli'))).toBe(true);
    expect(scripts.some((script) => script.includes('aggregate-gate-partitions.mjs'))).toBe(true);
  });

  it('aligns both scoped producers that run in gate-rest', () => {
    const read = steps(threeJobs());
    expect(hasExecutableProducer(read, 'check', BLUEPRINT)).toBe(true);
    expect(hasExecutableProducer(read, 'sense inventory', PACKS)).toBe(true);
  });

  it('measures the affected check that runs in either partition job', () => {
    expect(hasExecutableMeasurement(steps(threeJobs()), 'check')).toBe(true);
  });

  it('treats the always() aggregator as a job that runs', () => {
    const aggregate = steps(threeJobs()).find((step) =>
      step.script.includes('aggregate-gate-partitions.mjs'),
    );
    expect(aggregate?.conditional).not.toBe(true);
  });

  it('proves nothing from producers in a partition job that may not run on a pull request', () => {
    const read = steps(threeJobs("\n    if: github.event_name == 'push'"));
    expect(hasExecutableProducer(read, 'check', BLUEPRINT)).toBe(false);
    expect(hasExecutableProducer(read, 'sense inventory', PACKS)).toBe(false);
  });
});
