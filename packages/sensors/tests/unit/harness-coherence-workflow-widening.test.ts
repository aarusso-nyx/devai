// #325 (F5:T3): the harness effect analysis is widened to the patterns the DEVAI workflows
// use, while ADR-REL-0034 keeps every unproved effect a finding: scoped concurrency group
// expressions, dispatch-input job conditions, workflow data variables, and a reviewed-step
// registry keyed by each step's canonical YAML digest.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseHarnessCoherence, supersedingGroupScoped } from '../../src/harness-coherence.js';
import {
  concurrencyGroupContexts,
  jobEffectFacts,
  workflowStepInventory,
} from '../../src/harness/workflow-parser.js';

const NOW = '2026-10-06T12:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-coherence-widening-'));
  roots.push(root);
  return root;
}
function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
function sense(root: string) {
  return senseHarnessCoherence({ repoRoot: root, now: NOW });
}

const GATE_GROUP =
  "${{ github.event_name == 'merge_group' && format('{0}-mq-{1}', github.workflow, github.event.merge_group.head_sha) || format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) }}";
const RELEASE_GROUP =
  "devai-release-${{ github.event_name == 'workflow_dispatch' && inputs.release_tag || github.ref_name }}";

describe('concurrency group expressions', () => {
  it('reads the contexts of the gate, release and ref-scoped groups', () => {
    expect(concurrencyGroupContexts(GATE_GROUP)).toEqual([
      'github.event_name',
      'github.workflow',
      'github.event.merge_group.head_sha',
      'github.workflow',
      'github.event.pull_request.number',
    ]);
    expect(concurrencyGroupContexts(RELEASE_GROUP)).toEqual([
      'github.event_name',
      'inputs.release_tag',
      'github.ref_name',
    ]);
    expect(concurrencyGroupContexts('ci-${{ github.ref }}')).toEqual(['github.ref']);
    expect(concurrencyGroupContexts('devai-pages-publication')).toEqual([]);
  });

  it.each([
    'ci-${{ secrets.TOKEN }}',
    'ci-${{ github.event.pull_request.title }}',
    'ci-${{ toJSON(github) }}',
    "ci-${{ format(github.ref, 'x') }}",
    'ci-${{ github.ref ',
    'ci-}} ${{ github.ref }}',
    'ci-${{ github.ref ; }}',
  ])('refuses %s', (group) => {
    expect(concurrencyGroupContexts(group)).toBeUndefined();
  });

  it('scopes a superseding group to its ref, commit, or pull request and merge-queue entry', () => {
    expect(supersedingGroupScoped(GATE_GROUP)).toBe(true);
    expect(supersedingGroupScoped('ci-${{ github.ref }}')).toBe(true);
    expect(supersedingGroupScoped('verify-${{ github.sha }}')).toBe(true);
    expect(supersedingGroupScoped('ci-${{ github.workflow }}')).toBe(false);
    expect(supersedingGroupScoped('ci-github.ref')).toBe(false);
    expect(
      supersedingGroupScoped(
        "${{ format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) }}",
      ),
    ).toBe(false);
  });
});

function gate(group: string, cancel: boolean): string {
  return `on:
  pull_request: {}
permissions:
  contents: read
concurrency:
  group: ${group}
  cancel-in-progress: ${String(cancel)}
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
}

describe('root concurrency policy', () => {
  it('accepts the pull request gate group and refuses an unscoped superseding group', () => {
    const root = repository();
    write(root, '.github/workflows/gate.yml', gate(GATE_GROUP, true));
    expect(sense(root).status).toBe('pass');
    write(root, '.github/workflows/gate.yml', gate('ci-${{ github.workflow }}', true));
    expect(sense(root).metrics).toMatchObject({ concurrency_semantic_issues: 1 });
  });

  it('accepts the release group serialized and refuses it cancelling', () => {
    const root = repository();
    write(root, '.github/workflows/release.yml', gate(RELEASE_GROUP, false));
    expect(sense(root).status).toBe('pass');
    write(root, '.github/workflows/release.yml', gate(RELEASE_GROUP, true));
    expect(sense(root).metrics).toMatchObject({ concurrency_semantic_issues: 1 });
  });

  it('requires an environment-bound workflow to serialize', () => {
    const root = repository();
    const verify = (cancel: boolean) =>
      gate('verify-${{ github.sha }}', cancel).replace(
        '    runs-on: ubuntu-latest\n',
        '    runs-on: ubuntu-latest\n    environment: verification\n',
      );
    write(root, '.github/workflows/verify.yml', verify(true));
    expect(sense(root).metrics).toMatchObject({ concurrency_semantic_issues: 1 });
    write(root, '.github/workflows/verify.yml', verify(false));
    expect(sense(root).status).toBe('pass');
  });
});

describe('job facts the DEVAI workflows use', () => {
  const job = (body: string) => `on:
  workflow_dispatch: {}
permissions:
  contents: read
${body}`;

  it('admits workflow_dispatch inputs in a job condition, and still refuses other contexts', () => {
    const facts = (condition: string) =>
      jobEffectFacts(
        job(`jobs:\n  build:\n    if: \${{ ${condition} }}\n    steps:\n      - run: echo ok\n`),
        repository(),
        'build',
      );
    expect(facts("github.event_name == 'workflow_dispatch' && !inputs.publish").effect).toBe(
      'read-only',
    );
    expect(facts('secrets.TOKEN').effect).toBe('unknown');
    expect(facts("contains(github.ref, 'x')").effect).toBe('unknown');
  });

  it('admits the declared data variables and plain integers, and still refuses loader variables', () => {
    const facts = (env: string) =>
      jobEffectFacts(
        job(`env:\n${env}\njobs:\n  build:\n    steps:\n      - run: echo ok\n`),
        repository(),
        'build',
      );
    expect(facts('  EXPECTED_ACTION_COUNT: 69\n  RELEASE_TAG: v1').effect).toBe('read-only');
    expect(facts('  NODE_OPTIONS: --require ./x.js').effect).toBe('unknown');
    expect(facts('  EXPECTED_ACTION_COUNT: 6.9').effect).toBe('unknown');
  });

  it('keeps two jobs without job-level groups free of a lock alias', () => {
    const root = repository();
    write(
      root,
      '.github/workflows/release.yml',
      `on:
  workflow_dispatch: {}
permissions:
  contents: read
concurrency:
  group: ${RELEASE_GROUP}
  cancel-in-progress: false
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
  publish:
    runs-on: ubuntu-latest
    environment: release
    needs: verify
    steps:
      - run: echo ok
`,
    );
    expect(sense(root).status).toBe('pass');
  });
});

describe('reviewed workflow steps', () => {
  const unreviewed = `on:
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Not reviewed
        run: |
          for file in *; do echo "$file"; done
`;

  it('leaves a step outside the registry to the analysis, which refuses it', () => {
    expect(jobEffectFacts(unreviewed, repository(), 'build').effect).toBe('unknown');
    const [step] = workflowStepInventory(unreviewed);
    expect(step?.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('gives a step a digest that changes with any field and ignores map key order', () => {
    const inline = (step: string) =>
      `jobs:\n  build:\n    steps:\n      - ${step.split('\n').join('\n        ')}\n`;
    const [a] = workflowStepInventory(inline('name: Probe\nshell: bash\nrun: echo "$x"'));
    const [b] = workflowStepInventory(inline('run: echo "$x"\nname: Probe\nshell: bash'));
    const [c] = workflowStepInventory(inline('name: Probe\nshell: bash\nrun: echo "$y"'));
    const [d] = workflowStepInventory(inline('name: Probe\nshell: sh\nrun: echo "$x"'));
    expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(b?.sha256).toBe(a?.sha256);
    expect(c?.sha256).not.toBe(a?.sha256);
    expect(d?.sha256).not.toBe(a?.sha256);
  });
});
