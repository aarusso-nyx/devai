import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWorkflow } from '../../src/harness/workflow-parser.js';
import { senseHarnessCoherence } from '../../src/harness-coherence.js';

// Complete supplied-checkout fixtures; scripts below are parsed, never executed.
const candidateRoots: string[] = [];
afterEach(() => {
  for (const root of candidateRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function candidateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-parser-candidate-'));
  candidateRoots.push(root);
  return root;
}
function candidateWrite(root: string, path: string, source: string): void {
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new Error('outside candidate fixture');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}
function candidateWorkflow(command: string): string {
  return `permissions:\n  contents: read\njobs:\n  inspect:\n    concurrency:\n      group: inspect-${'${{ github.ref }}'}\n      cancel-in-progress: true\n    steps:\n      - run: ${JSON.stringify(command)}\n`;
}
function candidateEffect(root: string, source: string): string | undefined {
  return parseWorkflow(join(root, '.github/workflows/arbitrary.yml'), source, root).jobs[0]?.effect;
}
function completeCandidate(root: string): void {
  candidateWrite(root, 'scripts/process/publish-site.mjs', "import './leaf.mjs';\n");
  candidateWrite(
    root,
    'scripts/process/leaf.mjs',
    "export const description = 'contained read-only fixture';\n",
  );
  candidateWrite(
    root,
    '.github/actions/local/action.yml',
    'name: local\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node scripts/process/publish-site.mjs\n',
  );
}

function parse(line: string) {
  return parseWorkflow(
    '/repo/.github/workflows/check.yml',
    `jobs:\n  check:\n    steps:\n      - uses: ${line}\n`,
    '/repo',
  );
}

describe('workflow action reference extraction', () => {
  it.each(['actions/checkout@v4', '"actions/checkout@v4"', "'actions/checkout@v4'"])(
    'extracts the same action identity from supported YAML scalar %s',
    (scalar) => {
      expect(parse(scalar).actionUses).toEqual([
        { owner: 'actions', repo: 'checkout', ref: 'v4', line: 4 },
      ]);
    },
  );

  it('retains complete pinned refs and nested action paths', () => {
    const sha = 'abcdef0123456789abcdef0123456789abcdef0123';
    expect(parse(`"owner/repo/path/to/action@${sha}" # reviewed pin`).actionUses).toEqual([
      { owner: 'owner', repo: 'repo/path/to/action', ref: sha, line: 4 },
    ]);
  });

  it.each(['"./.github/actions/check"', "'./.github/actions/check'"])(
    'recognizes quoted local composite reference %s',
    (scalar) => {
      const ast = parse(scalar);
      expect(ast.actionUses).toEqual([
        { owner: '', repo: './.github/actions/check', ref: '', line: 4 },
      ]);
      expect(ast.compositeActionUses).toEqual(['./.github/actions/check']);
    },
  );

  it('recognizes a quoted reusable workflow and cache action', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  reusable:
    uses: "owner/repo/.github/workflows/check.yaml@main"
  checks:
    steps:
      - uses: 'actions/cache@v4'
`,
      '/repo',
    );
    expect(ast.reusableWorkflowUses).toEqual(['repo/.github/workflows/check.yaml']);
    expect(ast.hasCache).toBe(true);
    expect(ast.actionUses).toEqual([
      { owner: 'owner', repo: 'repo/.github/workflows/check.yaml', ref: 'main', line: 3 },
      { owner: 'actions', repo: 'cache', ref: 'v4', line: 6 },
    ]);
  });

  it.each(['"actions/checkout@v4', "'actions/checkout@v4", '"actions/checkout@v4\''])(
    'does not turn an unterminated or mismatched quoted reference into an action: %s',
    (scalar) => {
      expect(parse(scalar).actionUses).toEqual([]);
    },
  );

  it('ignores a uses: scalar that names no owner/repository pair', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  check:
    steps:
      - uses: docker
      - uses: actions/checkout@v4
      - uses: ./.github/actions/local
`,
      '/repo',
    );
    expect(ast.actionUses).toEqual([
      { owner: 'actions', repo: 'checkout', ref: 'v4', line: 5 },
      { owner: '', repo: './.github/actions/local', ref: '', line: 6 },
    ]);
    expect(ast.compositeActionUses).toEqual(['./.github/actions/local']);
  });

  it('does not mistake a run script line for a declared action', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  check:
    steps:
      - run: |
          uses: actions/cache@v4
`,
      '/repo',
    );
    expect(ast.actionUses).toEqual([]);
    expect(ast.hasCache).toBe(false);
  });
});

describe('workflow job and matrix accounting', () => {
  it('keeps a reusable workflow job separate from the following step-based job', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  delegated:
    uses: owner/repo/.github/workflows/reusable.yml@main
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`,
      '/repo',
    );
    expect(ast.jobs).toEqual([
      { name: 'delegated', stepCount: 0, matrixDimensions: 0, matrixCombinations: 0 },
      { name: 'build', stepCount: 1, matrixDimensions: 0, matrixCombinations: 0 },
    ]);
  });

  it('flushes a matrix at the next job even when the first job has no steps', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  delegated:
    strategy:
      matrix:
        os: [linux, macos]
        node:
          - 22
          - 24
    uses: owner/repo/.github/workflows/reusable.yml@main
  second:
    strategy:
      matrix:
        platform: [linux, macos, windows]
    steps:
      - run: echo test
`,
      '/repo',
    );
    expect(ast.jobs).toEqual([
      { name: 'delegated', stepCount: 0, matrixDimensions: 2, matrixCombinations: 4 },
      { name: 'second', stepCount: 1, matrixDimensions: 1, matrixCombinations: 3 },
    ]);
  });

  it('counts one step per list entry, not per property, and separates consecutive ordinary jobs', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  first:
    steps:
      - name: Build
        run: echo build
      - uses: actions/checkout@v4
  second:
    steps:
      - name: Test
        run: echo test
`,
      '/repo',
    );
    expect(ast.jobs.map(({ name, stepCount }) => ({ name, stepCount }))).toEqual([
      { name: 'first', stepCount: 2 },
      { name: 'second', stepCount: 1 },
    ]);
    expect(ast.runScripts).toEqual(['echo build', 'echo test']);
    expect(ast.runStepCount).toBe(2);
  });

  it('counts an inline matrix list only for the values it actually declares', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  build:
    strategy:
      matrix:
        empty: []
        os: [linux, macos, ]
        node:
          - 22
          - 24
    steps:
      - run: echo build
`,
      '/repo',
    );
    expect(ast.jobs).toEqual([
      { name: 'build', stepCount: 1, matrixDimensions: 2, matrixCombinations: 4 },
    ]);
  });

  it('keeps top-level flags and trigger path filters separate from nested job properties', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `on:
  pull_request:
    paths:
      - "src/**"
      - 'docs/#examples/**'
      - "gen/#out/**" # generated sources
  push:
    paths:
      - 'src/**'
    paths-ignore:
      - 'scratch/**'
permissions:
  contents: read
concurrency:
  group: checks
jobs:
  build:
    steps:
      - run: echo build
`,
      '/repo',
    );
    expect(ast.onPaths).toEqual(['src/**', 'docs/#examples/**', 'gen/#out/**']);
    expect(ast.onPathsIgnore).toEqual(['scratch/**']);
    expect(ast.hasPermissionsBlock).toBe(true);
    expect(ast.hasConcurrencyBlock).toBe(true);
    expect(ast.relativeFile).toBe('.github/workflows/check.yml');
    const nested = parseWorkflow(
      'external.yml',
      `jobs:
  build:
    permissions:
      contents: read
    concurrency:
      group: build
`,
      '/repo',
    );
    expect(nested.hasPermissionsBlock).toBe(false);
    expect(nested.hasConcurrencyBlock).toBe(false);
    expect(nested.relativeFile).toBe('external.yml');
  });
});

describe('run script capture', () => {
  it('captures every block-scalar indicator and dedents the body against the run: key', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  build:
    steps:
      - name: literal
        run: |
          echo literal
            indented
      - name: strip
        run: |-
          echo strip
      - name: folded
        run: >
          echo folded
      - name: folded-strip
        run: >-
          echo folded-strip
      - name: bare
        run:
          echo bare
      - run: echo inline
`,
      '/repo',
    );
    expect(ast.runScripts).toEqual([
      'echo literal\n  indented',
      'echo strip',
      'echo folded',
      'echo folded-strip',
      'echo bare',
      'echo inline',
    ]);
    expect(ast.runStepCount).toBe(6);
    expect(ast.jobs.map((job) => job.stepCount)).toEqual([6]);
  });

  it('keeps a blank line inside a literal block from truncating the commands after it', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  build:
    steps:
      - run: |
          set -euo pipefail
          echo one

          devai check --only dependencies
      - run: echo after
`,
      '/repo',
    );
    expect(ast.runScripts).toEqual([
      '  set -euo pipefail\n  echo one\n\n  devai check --only dependencies',
      'echo after',
    ]);
    expect(ast.runStepCount).toBe(2);
  });

  it('does not let a commented-out block-scalar body swallow the next step', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/check.yml',
      `jobs:
  build:
    steps:
      - run: |
          # devai check --only dependencies
      - run: echo after
`,
      '/repo',
    );
    expect(ast.runScripts).toEqual(['echo after']);
    expect(ast.runStepCount).toBe(1);
    expect(ast.jobs.map((job) => job.stepCount)).toEqual([2]);
  });

  it('ends a block-scalar body at a dedented sibling step key, blank line or not', () => {
    const separators = ['\n\n', '\n'];
    for (const separator of separators) {
      const ast = parseWorkflow(
        '/repo/.github/workflows/check.yml',
        `jobs:
  build:
    steps:
      - run: |
          echo one${separator}        env:
          MODE: strict
      - run: echo after
`,
        '/repo',
      );
      // The dash column is the recorded run indent, so the best-effort dedent
      // leaves the two columns the `- ` marker occupies.
      expect(ast.runScripts).toEqual(['  echo one', 'echo after']);
      expect(ast.runStepCount).toBe(2);
    }
  });
});

describe('plain scalar hashes and quote escape parity', () => {
  it('preserves embedded hashes in path filters and commands, removing only comments', () => {
    const ast = parseWorkflow(
      '/repo/.github/workflows/ci.yml',
      `on:
  push:
    paths:
      - gen#out/**
      - src/** # only sources
    paths-ignore:
      - docs/#drafts/**
jobs:
  check:
    steps:
      - run: devai check --only dependencies --out dist/report#1.json || true # note
`,
      '/repo',
    );
    expect(ast.onPaths).toEqual(['gen#out/**', 'src/**']);
    expect(ast.onPathsIgnore).toEqual(['docs/#drafts/**']);
    expect(ast.runScripts).toEqual([
      'devai check --only dependencies --out dist/report#1.json || true',
    ]);
  });

  it.each([2, 4])('strips a trailing comment after %i backslashes and a closing quote', (count) => {
    const command = `devai check --only dependencies --root "C:${'\\'.repeat(count)}"`;
    const ast = parseWorkflow(
      '/repo/.github/workflows/ci.yml',
      `jobs:
  check:
    steps:
      - run: ${command} # explanatory || true text
`,
      '/repo',
    );
    expect(ast.runScripts).toEqual([command]);
  });
});

describe('folded scalar line boundaries', () => {
  it.each([
    ['devai check --only dependencies', '|| true'],
    ['devai check', '--only dependencies'],
    ['echo one', '', 'echo two'],
    ['echo one', '', '', 'echo two'],
    ['echo one', '  indented text', 'echo two'],
    ['echo one', '', '  indented text', '', 'echo two'],
    ['', 'echo one', 'echo two'],
  ])('agrees with YAML folding for %j', (...body) => {
    const content = `jobs:\n  check:\n    steps:\n      - run: >-\n${body.map((line) => `          ${line}`).join('\n')}\n`;
    const reference = parseYaml(content) as { jobs: { check: { steps: { run: string }[] } } };
    const ast = parseWorkflow('/repo/.github/workflows/ci.yml', content, '/repo');
    expect(ast.runScripts).toEqual([reference.jobs.check.steps[0]?.run]);
  });
});

// Trace annotation deferred to Architect TASK-06216: no exact canonical concurrency invariant.
// ADR-REL-0034 requires per-job custody/effects with no filename privilege.
describe('job-scoped effect declarations', () => {
  it('retains independent locks, needs, permissions, environment and run scripts per arbitrary named job', () => {
    const root = candidateRoot();
    completeCandidate(root);
    const ast = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      `permissions:
  contents: read
jobs:
  observe:
    concurrency:
      group: prepare-${'${{ github.ref }}'}
      cancel-in-progress: true
    permissions:
      contents: read
    steps:
      - run: pnpm docs:build
  actuate:
    needs: observe
    permissions:
      contents: read
      pages: write
      deployments: write
      id-token: write
    environment: github-pages
    concurrency:
      group: devai-pages-publication
      cancel-in-progress: false
    steps:
      - run: node scripts/process/publish-site.mjs
`,
      root,
    );
    expect(ast.jobs).toEqual([
      expect.objectContaining({
        name: 'observe',
        permissions: { contents: 'read' },
        concurrency: { group: 'prepare-${{ github.ref }}', cancelInProgress: true },
        runScripts: ['pnpm docs:build'],
      }),
      expect.objectContaining({
        name: 'actuate',
        needs: ['observe'],
        permissions: {
          contents: 'read',
          pages: 'write',
          deployments: 'write',
          'id-token': 'write',
        },
        environment: 'github-pages',
        concurrency: { group: 'devai-pages-publication', cancelInProgress: false },
        runScripts: ['node scripts/process/publish-site.mjs'],
      }),
    ]);
    expect(ast.hasConcurrencyBlock).toBe(false);
  });
});

describe('supplied candidate source provenance (offline analysis)', () => {
  const direct = candidateWorkflow('node scripts/process/publish-site.mjs');
  it.each([
    'missing-direct',
    'missing-import',
    'unreadable-direct',
    'import-cycle',
    'import-escape',
    'symlink-escape',
    'dynamic-import',
  ])('refuses %s after a complete direct/import positive', (fault) => {
    const root = candidateRoot();
    completeCandidate(root);
    expect(candidateEffect(root, direct)).toBe('read-only');
    if (fault === 'missing-direct') rmSync(join(root, 'scripts/process/publish-site.mjs'));
    if (fault === 'missing-import') rmSync(join(root, 'scripts/process/leaf.mjs'));
    if (fault === 'unreadable-direct') {
      rmSync(join(root, 'scripts/process/publish-site.mjs'));
      mkdirSync(join(root, 'scripts/process/publish-site.mjs'));
    }
    if (fault === 'import-cycle')
      candidateWrite(root, 'scripts/process/leaf.mjs', "import './publish-site.mjs';\n");
    if (fault === 'import-escape')
      candidateWrite(root, 'scripts/process/leaf.mjs', "import '../../../outside.mjs';\n");
    if (fault === 'symlink-escape') {
      const outside = candidateRoot();
      candidateWrite(outside, 'leaf.mjs', 'export const value = 1;\n');
      rmSync(join(root, 'scripts/process/leaf.mjs'));
      symlinkSync(join(outside, 'leaf.mjs'), join(root, 'scripts/process/leaf.mjs'));
    }
    if (fault === 'dynamic-import')
      candidateWrite(
        root,
        'scripts/process/leaf.mjs',
        'await import(process.env.SELECTED_MODULE);\n',
      );
    // The sole changed source edge is unresolved; no analyzer checkout may fill it.
    expect(candidateEffect(root, direct)).toBe('unknown');
  });
  it('uses supplied same-path bytes and refuses absent explicit candidate identity', () => {
    const root = candidateRoot();
    completeCandidate(root);
    expect(candidateEffect(root, direct)).toBe('read-only');
    candidateWrite(
      root,
      'scripts/process/leaf.mjs',
      'fetch("https://example.invalid", {method:"POST"});\n',
    );
    expect(candidateEffect(root, direct)).toBe('publication');
    const other = candidateRoot();
    completeCandidate(other);
    expect(candidateEffect(other, direct)).toBe('read-only');
    expect(
      parseWorkflow(join(root, '.github/workflows/arbitrary.yml'), direct, '').jobs[0]?.effect,
    ).toBe('unknown');
  });
  it.each([
    'node -e \'fetch("https://example.invalid", {method:"POST"})\'',
    'node --eval \'fetch("https://example.invalid")\'',
    "python -c 'import urllib.request'",
    "sh -c 'unknown-operation'",
    'unregistered-tool --write',
  ])('refuses unbound executable form %s', (command) => {
    const root = candidateRoot();
    completeCandidate(root);
    expect(candidateEffect(root, direct)).toBe('read-only');
    expect(candidateEffect(root, candidateWorkflow(command))).toBe('unknown');
  });
  it('follows concrete local-composite scripts/imports before classifying locks', () => {
    const root = candidateRoot();
    completeCandidate(root);
    const composite = direct.replace(
      'run: "node scripts/process/publish-site.mjs"',
      'uses: ./.github/actions/local',
    );
    expect(candidateEffect(root, composite)).toBe('read-only');
    candidateWrite(
      root,
      'scripts/process/leaf.mjs',
      'fetch("https://example.invalid", {method:"POST"});\n',
    );
    expect(candidateEffect(root, composite)).toBe('publication');
    rmSync(join(root, 'scripts/process/leaf.mjs'));
    expect(candidateEffect(root, composite)).toBe('unknown');
  });
  it('follows contained nested local actions and refuses a local action cycle', () => {
    const root = candidateRoot();
    completeCandidate(root);
    candidateWrite(
      root,
      '.github/actions/outer/action.yml',
      'name: outer\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/local\n',
    );
    const nested = direct.replace(
      'run: "node scripts/process/publish-site.mjs"',
      'uses: ./.github/actions/outer',
    );
    expect(candidateEffect(root, nested)).toBe('read-only');
    candidateWrite(
      root,
      '.github/actions/local/action.yml',
      'name: local\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/outer\n',
    );
    expect(candidateEffect(root, nested)).toBe('unknown');
  });

  // WHOLE19-REV-002 R1-R5: a registered action admits only its declared inert inputs, a
  // capability-reducing literal, or the ambient token; every selector refuses.
  const pin = '0123456789abcdef0123456789abcdef01234567';
  function actionStep(use: string, inputs: readonly string[] = []): string {
    const lines = [`      - uses: ${use}`];
    if (inputs.length) lines.push('        with:', ...inputs.map((input) => `          ${input}`));
    return lines.join('\n');
  }
  function stepsWorkflow(...steps: readonly string[]): string {
    return `permissions:\n  contents: read\njobs:\n  inspect:\n    concurrency:\n      group: inspect-${'${{ github.ref }}'}\n      cancel-in-progress: true\n    steps:\n${steps.join('\n')}\n`;
  }
  it.each([
    ['fetch-depth', ['fetch-depth: 0']],
    ['persist-credentials literal false', ['persist-credentials: false']],
    ['ambient secrets.GITHUB_TOKEN', ['token: ${{ secrets.GITHUB_TOKEN }}']],
    ['ambient github.token', ['token: ${{ github.token }}']],
    ['undeclared input on a full-SHA pin', ["schedule: '0 3 * * *'"]],
  ] as const)('keeps a pinned checkout with %s read-only', (_name, inputs) => {
    const root = candidateRoot();
    completeCandidate(root);
    expect(candidateEffect(root, stepsWorkflow(actionStep(`actions/checkout@${pin}`)))).toBe(
      'read-only',
    );
    expect(
      candidateEffect(root, stepsWorkflow(actionStep(`actions/checkout@${pin}`, inputs))),
    ).toBe('read-only');
  });
  it.each([
    ['checkout non-ambient token', 'actions/checkout', ['token: ${{ secrets.PAT }}']],
    ['checkout ssh-key', 'actions/checkout', ['ssh-key: ${{ secrets.DEPLOY_KEY }}']],
    ['checkout github-server-url', 'actions/checkout', ['github-server-url: https://evil.example']],
    ['checkout ssh-strict false', 'actions/checkout', ['ssh-strict: false']],
    ['checkout repository', 'actions/checkout', ['repository: other/repo']],
    ['checkout ref', 'actions/checkout', ['ref: refs/heads/other']],
    ['checkout path', 'actions/checkout', ['path: scripts']],
    ['checkout submodules', 'actions/checkout', ['submodules: true']],
    ['checkout lfs', 'actions/checkout', ['lfs: true']],
    ['checkout sparse-checkout', 'actions/checkout', ['sparse-checkout: scripts']],
    ['checkout persist-credentials true', 'actions/checkout', ['persist-credentials: true']],
    [
      'checkout persist-credentials expression',
      'actions/checkout',
      ['persist-credentials: ${{ inputs.persist }}'],
    ],
    ['checkout non-scalar input', 'actions/checkout', ['fetch-depth:', '  - 0']],
    ['setup-node mirror', 'actions/setup-node', ['mirror: https://evil.example/dist']],
    ['setup-node registry-url', 'actions/setup-node', ['registry-url: https://evil.example']],
    ['setup-node non-ambient token', 'actions/setup-node', ['token: ${{ secrets.PAT }}']],
    ['download-artifact repository', 'actions/download-artifact', ['repository: other/repo']],
    ['download-artifact run-id', 'actions/download-artifact', ["run-id: '123'"]],
    [
      'download-artifact github-token',
      'actions/download-artifact',
      ['github-token: ${{ secrets.PAT }}'],
    ],
    ['download-artifact path', 'actions/download-artifact', ['path: scripts']],
    [
      'upload-artifact include-hidden-files',
      'actions/upload-artifact',
      ['include-hidden-files: true'],
    ],
    ['upload-artifact overwrite', 'actions/upload-artifact', ['overwrite: true']],
    ['pnpm/action-setup dest', 'pnpm/action-setup', ['dest: node_modules/.bin']],
  ] as const)(
    'refuses %s after the same pinned registered action passes',
    (_name, action, inputs) => {
      const root = candidateRoot();
      completeCandidate(root);
      const control = stepsWorkflow(actionStep(`${action}@${pin}`));
      expect(candidateEffect(root, control)).toBe('read-only');
      // Only the selector, credential, reducing-value or shape of one input changes.
      expect(candidateEffect(root, stepsWorkflow(actionStep(`${action}@${pin}`, inputs)))).toBe(
        'unknown',
      );
    },
  );
  it.each([
    ['branch ref', 'actions/checkout@main'],
    ['absent ref', 'actions/checkout'],
  ])('refuses inputs on a checkout with an unpinned %s', (_name, use) => {
    const root = candidateRoot();
    completeCandidate(root);
    for (const inputs of [["schedule: '0 3 * * *'"], ['fetch-depth: 0']]) {
      // The same inputs are inert only against the declared set of a pinned revision.
      expect(
        candidateEffect(root, stepsWorkflow(actionStep(`actions/checkout@${pin}`, inputs))),
      ).toBe('read-only');
      expect(candidateEffect(root, stepsWorkflow(actionStep(use, inputs)))).toBe('unknown');
    }
  });

  // WHOLE19-R2-001: GitHub hands each `with` key to the action as INPUT_<NAME in upper
  // case>, so an input name is case-insensitive; classification follows the folded name.
  it.each([
    ['checkout Fetch-Depth', 'actions/checkout', ['fetch-depth: 0'], ['Fetch-Depth: 0']],
    [
      'checkout PERSIST-CREDENTIALS literal false',
      'actions/checkout',
      ['persist-credentials: false'],
      ['PERSIST-CREDENTIALS: false'],
    ],
    [
      'checkout Token ambient github.token',
      'actions/checkout',
      ['token: ${{ github.token }}'],
      ['Token: ${{ github.token }}'],
    ],
    ['setup-node Node-Version', 'actions/setup-node', ['node-version: 24'], ['Node-Version: 24']],
  ] as const)(
    'keeps a pinned %s case variant read-only like its lowercase input',
    (_name, action, lowercase, variant) => {
      const root = candidateRoot();
      completeCandidate(root);
      expect(candidateEffect(root, stepsWorkflow(actionStep(`${action}@${pin}`)))).toBe(
        'read-only',
      );
      expect(candidateEffect(root, stepsWorkflow(actionStep(`${action}@${pin}`, lowercase)))).toBe(
        'read-only',
      );
      expect(candidateEffect(root, stepsWorkflow(actionStep(`${action}@${pin}`, variant)))).toBe(
        'read-only',
      );
    },
  );
  it.each([
    ['checkout Ref', 'actions/checkout', ['ref: evil'], ['Ref: evil']],
    [
      'checkout REPOSITORY',
      'actions/checkout',
      ['repository: evil/repo'],
      ['REPOSITORY: evil/repo'],
    ],
    [
      'checkout Token non-ambient',
      'actions/checkout',
      ['token: ${{ secrets.PAT }}'],
      ['Token: ${{ secrets.PAT }}'],
    ],
    [
      'checkout GITHUB-SERVER-URL',
      'actions/checkout',
      ['github-server-url: https://evil.example'],
      ['GITHUB-SERVER-URL: https://evil.example'],
    ],
    [
      'checkout Persist-Credentials true',
      'actions/checkout',
      ['persist-credentials: true'],
      ['Persist-Credentials: true'],
    ],
    [
      'setup-node Mirror',
      'actions/setup-node',
      ['mirror: https://evil.example'],
      ['Mirror: https://evil.example'],
    ],
    [
      'cache enablecrossosarchive',
      'actions/cache',
      ['enableCrossOsArchive: true'],
      ['enablecrossosarchive: true'],
    ],
  ] as const)(
    'refuses a pinned %s case variant like its declared input after the control passes',
    (_name, action, declared, variant) => {
      const root = candidateRoot();
      completeCandidate(root);
      expect(candidateEffect(root, stepsWorkflow(actionStep(`${action}@${pin}`)))).toBe(
        'read-only',
      );
      expect(candidateEffect(root, stepsWorkflow(actionStep(`${action}@${pin}`, declared)))).toBe(
        'unknown',
      );
      // Only the letter case of the input name changes.
      expect(candidateEffect(root, stepsWorkflow(actionStep(`${action}@${pin}`, variant)))).toBe(
        'unknown',
      );
    },
  );
  it('refuses a pinned github-script SCRIPT case variant like its executable script input', () => {
    const root = candidateRoot();
    completeCandidate(root);
    const action = `actions/github-script@${pin}`;
    expect(candidateEffect(root, stepsWorkflow(actionStep(action)))).toBe('publication');
    expect(
      candidateEffect(root, stepsWorkflow(actionStep(action, ['script: console.log(1)']))),
    ).toBe('unknown');
    expect(
      candidateEffect(root, stepsWorkflow(actionStep(action, ['SCRIPT: console.log(1)']))),
    ).toBe('unknown');
  });
  it.each([
    ['selector ref and REF', ['ref: main', 'REF: evil'], 'unknown'],
    ['inert fetch-depth and Fetch-Depth', ['fetch-depth: 0', 'Fetch-Depth: 1'], 'read-only'],
    [
      'reducing persist-credentials and PERSIST-CREDENTIALS',
      ['persist-credentials: false', 'PERSIST-CREDENTIALS: false'],
      'read-only',
    ],
  ] as const)(
    'refuses two pinned checkout input names folding to one name (%s)',
    (_name, inputs, alone) => {
      const root = candidateRoot();
      completeCandidate(root);
      const action = `actions/checkout@${pin}`;
      expect(candidateEffect(root, stepsWorkflow(actionStep(action)))).toBe('read-only');
      for (const input of inputs)
        expect(candidateEffect(root, stepsWorkflow(actionStep(action, [input])))).toBe(alone);
      // Only the second spelling of the one folded name is added.
      expect(candidateEffect(root, stepsWorkflow(actionStep(action, inputs)))).toBe('unknown');
    },
  );

  // WHOLE19-REV-012: cache restore and artifact download select workspace bytes; a later
  // workspace execution no longer runs the bytes that were analysed.
  it.each([
    ['download-artifact', actionStep(`actions/download-artifact@${pin}`)],
    ['named download-artifact', actionStep(`actions/download-artifact@${pin}`, ['name: payload'])],
    ['cache restore', actionStep(`actions/cache@${pin}`, ['path: scripts', 'key: anything'])],
  ])('refuses %s followed by a workspace execution', (_name, selector) => {
    const root = candidateRoot();
    completeCandidate(root);
    const execution = '      - run: "node scripts/process/publish-site.mjs"';
    const composite = '      - uses: ./.github/actions/local';
    expect(candidateEffect(root, stepsWorkflow(execution))).toBe('read-only');
    expect(candidateEffect(root, stepsWorkflow(composite))).toBe('read-only');
    expect(candidateEffect(root, stepsWorkflow(selector, execution))).toBe('unknown');
    expect(candidateEffect(root, stepsWorkflow(selector, composite))).toBe('unknown');
  });
  it('keeps an input-free artifact download alone read-only, not before a workspace execution', () => {
    const root = candidateRoot();
    completeCandidate(root);
    const download = actionStep(`actions/download-artifact@${pin}`);
    expect(candidateEffect(root, stepsWorkflow(download))).toBe('read-only');
    expect(
      candidateEffect(
        root,
        stepsWorkflow(download, '      - run: "node scripts/process/publish-site.mjs"'),
      ),
    ).toBe('unknown');
  });

  // WHOLE19-REV-003 / R5: a reusable workflow call forwards inputs and secrets to its callee.
  function reusableCall(use: string, forwarded = ''): string {
    return `permissions:\n  contents: read\njobs:\n  inspect:\n    concurrency:\n      group: inspect-${'${{ github.ref }}'}\n      cancel-in-progress: true\n    uses: ${use}\n${forwarded}`;
  }
  function reusableCallee(root: string): void {
    completeCandidate(root);
    candidateWrite(
      root,
      '.github/workflows/reuse.yml',
      'on:\n  workflow_call:\n    inputs:\n      ref:\n        type: string\npermissions:\n  contents: read\njobs:\n  inner:\n    steps:\n      - run: node scripts/process/publish-site.mjs\n',
    );
  }
  it.each([
    ['with', '    with:\n      ref: refs/heads/other\n'],
    ['secrets inherit', '    secrets: inherit\n'],
    ['explicit secrets', '    secrets:\n      token: ${{ secrets.PAT }}\n'],
    ['with and secrets inherit', '    with:\n      ref: refs/heads/other\n    secrets: inherit\n'],
  ])(
    'refuses a local reusable workflow call with %s after the plain call passes',
    (_n, forwarded) => {
      const root = candidateRoot();
      reusableCallee(root);
      expect(candidateEffect(root, reusableCall('./.github/workflows/reuse.yml'))).toBe(
        'read-only',
      );
      expect(candidateEffect(root, reusableCall('./.github/workflows/reuse.yml', forwarded))).toBe(
        'unknown',
      );
    },
  );
  it.each([
    ['with', '    with:\n      ref: refs/heads/other\n'],
    ['secrets inherit', '    secrets: inherit\n'],
  ])('refuses a remote reusable workflow call with %s', (_name, forwarded) => {
    const root = candidateRoot();
    reusableCallee(root);
    expect(candidateEffect(root, reusableCall('./.github/workflows/reuse.yml'))).toBe('read-only');
    expect(
      candidateEffect(
        root,
        reusableCall(`octo/tools/.github/workflows/reuse.yml@${pin}`, forwarded),
      ),
    ).toBe('unknown');
  });
});

describe('contained builtin capability effects (offline source analysis)', () => {
  const readOnlyCjs = [
    "const { readFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    "const assert = require('node:assert/strict');",
    "const observed = readFileSync(join(__dirname, '../fixtures/control.txt'), 'utf8');",
    "assert.equal(observed, 'contained observation\\n');",
    '',
  ].join('\n');
  const readOnlyMjs = [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import assert from 'node:assert/strict';",
    "const observed = readFileSync(join('fixtures', 'control.txt'), 'utf8');",
    "assert.equal(observed, 'contained observation\\n');",
    '',
  ].join('\n');
  const variants = [
    {
      name: 'child-process-property',
      extension: 'cjs',
      source:
        "const cp = require('node:child_process');\ncp.execFileSync('git', ['push', 'origin', 'HEAD']);\n",
      expected: 'unknown',
    },
    {
      name: 'child-process-destructured-alias-argv',
      extension: 'cjs',
      source:
        "const { spawnSync: launch } = require('node:child_process');\nconst executable = 'git';\nconst argv = ['push', 'origin', 'HEAD'];\nlaunch(executable, argv);\n",
      expected: 'unknown',
    },
    {
      name: 'child-process-imported-alias-argv',
      extension: 'mjs',
      source:
        "import { execFileSync as launch } from 'node:child_process';\nconst executable = 'git';\nconst argv = ['push', 'origin', 'HEAD'];\nlaunch(executable, argv);\n",
      expected: 'unknown',
    },
    {
      name: 'child-process-computed-operation',
      extension: 'cjs',
      source:
        "const cp = require('node:child_process');\nconst operation = process.env.OPERATION;\ncp[operation](process.env.EXECUTABLE, JSON.parse(process.env.ARGV));\n",
      expected: 'unknown',
    },
    {
      name: 'fs-mutator-alias',
      extension: 'cjs',
      source:
        "const { writeFileSync: mutate } = require('node:fs');\nconst target = process.env.DESTINATION;\nmutate(target, 'candidate mutation');\n",
      expected: 'publication',
    },
    {
      name: 'fs-imported-mutator',
      extension: 'mjs',
      source:
        "import { appendFileSync as mutate } from 'node:fs';\nconst target = process.env.DESTINATION;\nmutate(target, 'candidate mutation');\n",
      expected: 'publication',
    },
    {
      name: 'fs-computed-mutator',
      extension: 'cjs',
      source:
        "const filesystem = require('node:fs');\nconst operation = process.env.OPERATION;\nfilesystem[operation](process.env.DESTINATION, 'candidate mutation');\n",
      expected: 'unknown',
    },
    {
      name: 'network-request-alias',
      extension: 'cjs',
      source:
        "const client = require('node:https');\nconst send = client.request;\nconst options = { hostname: 'example.invalid', method: 'POST' };\nsend(options);\n",
      expected: 'unknown',
    },
    {
      name: 'network-imported-request',
      extension: 'mjs',
      source:
        "import { request as send } from 'node:http';\nconst options = { hostname: 'example.invalid', method: 'POST' };\nsend(options);\n",
      expected: 'unknown',
    },
    {
      name: 'vm-execution-alias',
      extension: 'cjs',
      source:
        "const { runInNewContext: execute } = require('node:vm');\nconst program = process.env.PROGRAM;\nexecute(program);\n",
      expected: 'unknown',
    },
    {
      name: 'unresolved-require-alias',
      extension: 'cjs',
      source:
        'const load = require;\nconst client = load(process.env.MODULE_NAME);\nclient[process.env.OPERATION](process.env.VALUE);\n',
      expected: 'unknown',
    },
    {
      name: 'unresolved-global-executor',
      extension: 'cjs',
      source: 'const execute = globalThis[process.env.EXECUTOR];\nexecute(process.env.COMMAND);\n',
      expected: 'unknown',
    },
    {
      name: 'unresolved-reflective-executor',
      extension: 'cjs',
      source:
        'const execute = globalThis[process.env.EXECUTOR];\nReflect.apply(execute, null, [process.env.COMMAND]);\n',
      expected: 'unknown',
    },
    {
      name: 'fs-static-computed-alias',
      extension: 'cjs',
      source:
        "const filesystem = require('node:fs');\nconst operation = 'writeFileSync';\nconst mutate = filesystem[operation];\nmutate(process.env.DESTINATION, 'candidate mutation');\n",
      expected: 'publication',
    },
    {
      name: 'aliased-Function-constructor',
      extension: 'cjs',
      source:
        'const compile = Function;\nconst execute = new compile(process.env.PROGRAM);\nexecute();\n',
      expected: 'unknown',
    },
    {
      name: 'aliased-eval',
      extension: 'cjs',
      source: 'const execute = eval;\nexecute(process.env.PROGRAM);\n',
      expected: 'unknown',
    },
    {
      name: 'worker-thread-constructor',
      extension: 'cjs',
      source:
        "const { Worker: Execute } = require('node:worker_threads');\nnew Execute(process.env.PROGRAM, { eval: true });\n",
      expected: 'unknown',
    },
    {
      name: 'module-createRequire-alias',
      extension: 'cjs',
      source:
        "const { createRequire: loadFactory } = require('node:module');\nconst load = loadFactory(__filename);\nload(process.env.MODULE_NAME);\n",
      expected: 'unknown',
    },
    {
      name: 'process-getBuiltinModule',
      extension: 'cjs',
      source:
        'const load = process.getBuiltinModule;\nconst client = load(process.env.MODULE_NAME);\nclient[process.env.OPERATION](process.env.VALUE);\n',
      expected: 'unknown',
    },
    {
      name: 'getter-executable-capability',
      extension: 'cjs',
      source:
        'const object = { get operation() { return globalThis[process.env.EXECUTOR]; } };\nobject.operation(process.env.VALUE);\n',
      expected: 'unknown',
    },
    {
      name: 'proxy-executable-capability',
      extension: 'cjs',
      source:
        'const object = new Proxy({}, { get() { return globalThis[process.env.EXECUTOR]; } });\nobject.operation(process.env.VALUE);\n',
      expected: 'unknown',
    },
    {
      name: 'fs-path-coercion-executable-hook',
      extension: 'cjs',
      source:
        "const filesystem = require('node:fs');\nconst path = { toString() { const execute = globalThis[process.env.EXECUTOR]; execute(process.env.VALUE); return 'fixtures/control.txt'; } };\nfilesystem.readFileSync(path, 'utf8');\n",
      expected: 'unknown',
    },
  ];
  function observe(root: string, source: string) {
    candidateWrite(root, '.github/workflows/arbitrary.yml', source);
    return senseHarnessCoherence({ repoRoot: root, now: '2026-10-02T12:00:00.000Z' });
  }
  for (const topology of ['direct', 'transitive', 'composite'] as const) {
    it.each(variants)(
      `${topology} source refuses $name after the complete control passes`,
      (fault) => {
        const root = candidateRoot();
        const entry = `scripts/observe.${fault.extension}`;
        const leaf = `scripts/runner.${fault.extension}`;
        const readOnly = fault.extension === 'cjs' ? readOnlyCjs : readOnlyMjs;
        candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
        candidateWrite(root, leaf, readOnly);
        candidateWrite(
          root,
          entry,
          topology === 'transitive'
            ? fault.extension === 'cjs'
              ? "require('./runner.cjs');\n"
              : "import './runner.mjs';\n"
            : readOnly,
        );
        candidateWrite(
          root,
          '.github/actions/builtin-control/action.yml',
          `name: contained control\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node ${entry}\n`,
        );
        const command = `node ${entry}`;
        const direct = candidateWorkflow(command);
        const workflow =
          topology === 'composite'
            ? direct.replace(
                `run: ${JSON.stringify(command)}`,
                'uses: ./.github/actions/builtin-control',
              )
            : direct;
        expect(candidateEffect(root, workflow)).toBe('read-only');
        const control = observe(root, workflow);
        expect(control.status).toBe('pass');
        expect(control.metrics?.concurrency_semantic_issues).toBe(0);
        expect(control.findings ?? []).toEqual([]);
        // Only this reachable source member changes; root, command, data and
        // candidate source identity stay bound to the complete accepted control.
        candidateWrite(root, topology === 'transitive' ? leaf : entry, fault.source);
        expect(candidateEffect(root, workflow)).toBe(fault.expected);
        const refused = observe(root, workflow);
        expect(refused.status).toBe('review');
        expect(refused.metrics?.concurrency_semantic_issues).toBe(1);
        expect(refused.findings ?? []).toEqual([
          {
            severity: 'warning',
            code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
            message:
              '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
          },
        ]);
        const serialized = workflow
          .replace('inspect-${{ github.ref }}', 'devai-pages-publication')
          .replace('cancel-in-progress: true', 'cancel-in-progress: false');
        expect(candidateEffect(root, serialized)).toBe(fault.expected);
        const locked = observe(root, serialized);
        expect(locked.status).toBe(fault.expected === 'publication' ? 'pass' : 'review');
        expect(locked.metrics?.concurrency_semantic_issues).toBe(
          fault.expected === 'publication' ? 0 : 1,
        );
        expect(locked.findings ?? []).toEqual(
          fault.expected === 'publication' ? [] : refused.findings,
        );
      },
    );
  }
  it.each([
    'inline-assignment',
    'inline-export',
    'inline-path',
    'workflow-env',
    'job-env',
    'step-env',
    'composite-step-env',
  ] as const)(
    'refuses executable-affecting %s after the unchanged observation control passes',
    (scope) => {
      const root = candidateRoot();
      candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
      candidateWrite(root, 'scripts/observe.cjs', readOnlyCjs);
      candidateWrite(
        root,
        'scripts/writer.cjs',
        "const cp = require('node:child_process');\ncp.execFileSync('git', ['push', 'origin', 'HEAD']);\n",
      );
      const action =
        'name: loader control\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node scripts/observe.cjs\n';
      candidateWrite(root, '.github/actions/loader-control/action.yml', action);
      const direct = candidateWorkflow('node scripts/observe.cjs');
      const observation =
        scope === 'composite-step-env'
          ? direct.replace(
              'run: "node scripts/observe.cjs"',
              'uses: ./.github/actions/loader-control',
            )
          : direct;
      expect(candidateEffect(root, observation)).toBe('read-only');
      const control = observe(root, observation);
      expect(control.status).toBe('pass');
      expect(control.metrics?.concurrency_semantic_issues).toBe(0);
      expect(control.findings ?? []).toEqual([]);
      // The preload writer is already contained but unreachable in the control.
      // Only one applicable environment/command input changes after it passes.
      let loader = observation;
      if (scope === 'inline-assignment')
        loader = candidateWorkflow(
          'NODE_OPTIONS=--require=./scripts/writer.cjs node scripts/observe.cjs',
        );
      if (scope === 'inline-export')
        loader = candidateWorkflow(
          'export NODE_OPTIONS=--require=./scripts/writer.cjs; node scripts/observe.cjs',
        );
      if (scope === 'inline-path')
        loader = candidateWorkflow('PATH=./scripts node scripts/observe.cjs');
      if (scope === 'workflow-env')
        loader = 'env:\n  NODE_OPTIONS: --require=./scripts/writer.cjs\n' + observation;
      if (scope === 'job-env')
        loader = observation.replace(
          '  inspect:\n',
          '  inspect:\n    env:\n      NODE_OPTIONS: --require=./scripts/writer.cjs\n',
        );
      if (scope === 'step-env')
        loader = observation.replace(
          '      - run: "node scripts/observe.cjs"\n',
          '      - run: "node scripts/observe.cjs"\n        env:\n          NODE_OPTIONS: --require=./scripts/writer.cjs\n',
        );
      if (scope === 'composite-step-env')
        candidateWrite(
          root,
          '.github/actions/loader-control/action.yml',
          action + '      env:\n        NODE_OPTIONS: --require=./scripts/writer.cjs\n',
        );
      expect(candidateEffect(root, loader)).toBe('unknown');
      const refused = observe(root, loader);
      expect(refused.status).toBe('review');
      expect(refused.metrics?.concurrency_semantic_issues).toBe(1);
      expect(refused.findings ?? []).toEqual([
        {
          severity: 'warning',
          code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
          message:
            '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
        },
      ]);
      const serialized = loader
        .replace('inspect-${{ github.ref }}', 'devai-pages-publication')
        .replace('cancel-in-progress: true', 'cancel-in-progress: false');
      expect(candidateEffect(root, serialized)).toBe('unknown');
      const locked = observe(root, serialized);
      expect(locked.status).toBe('review');
      expect(locked.metrics?.concurrency_semantic_issues).toBe(1);
      expect(locked.findings ?? []).toEqual(refused.findings);
    },
  );
  it.each([
    'node-redirection',
    'echo-redirection',
    'package-redirection',
    'composite-redirection',
    'package-pretest',
    'package-posttest',
    'package-script-shell',
    'workflow-shell',
    'job-shell',
    'step-shell',
    'composite-shell',
    'step-working-directory',
  ] as const)('refuses unproved %s after its complete source control passes', (fault) => {
    const root = candidateRoot();
    candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
    candidateWrite(root, 'scripts/observe.cjs', readOnlyCjs);
    const writer =
      "const cp = require('node:child_process');\ncp.execFileSync('git', ['push', 'origin', 'HEAD']);\n";
    candidateWrite(root, 'scripts/writer.cjs', writer);
    candidateWrite(root, 'nested/scripts/observe.cjs', writer);
    // This real executable fixture is dormant in every control and never run.
    candidateWrite(root, 'scripts/executor.cjs', '#!/usr/bin/env node\n' + writer);
    chmodSync(join(root, 'scripts/executor.cjs'), 0o755);
    const packageControl = { private: true, scripts: { test: 'node scripts/observe.cjs' } };
    candidateWrite(root, 'package.json', JSON.stringify(packageControl));
    const action =
      'name: shell control\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node scripts/observe.cjs\n';
    candidateWrite(root, '.github/actions/shell-control/action.yml', action);
    const direct = candidateWorkflow('node scripts/observe.cjs');
    const observation = fault.startsWith('package-')
      ? candidateWorkflow('npm test')
      : fault.startsWith('composite-')
        ? direct.replace('run: "node scripts/observe.cjs"', 'uses: ./.github/actions/shell-control')
        : fault === 'echo-redirection'
          ? candidateWorkflow('node scripts/observe.cjs; echo payload')
          : direct;
    expect(candidateEffect(root, observation)).toBe('read-only');
    const control = observe(root, observation);
    expect(control.status).toBe('pass');
    expect(control.metrics?.concurrency_semantic_issues).toBe(0);
    expect(control.findings ?? []).toEqual([]);
    // Only one run, package/config, hook or effective-executor member changes.
    let changed = observation;
    if (fault === 'node-redirection')
      changed = candidateWorkflow('node scripts/observe.cjs > observed.txt');
    if (fault === 'echo-redirection')
      changed = candidateWorkflow('node scripts/observe.cjs; echo payload > observed.txt');
    if (fault === 'package-redirection')
      candidateWrite(
        root,
        'package.json',
        JSON.stringify({
          ...packageControl,
          scripts: { test: 'node scripts/observe.cjs > observed.txt' },
        }),
      );
    if (fault === 'composite-redirection')
      candidateWrite(
        root,
        '.github/actions/shell-control/action.yml',
        action.replace(
          'run: node scripts/observe.cjs',
          'run: node scripts/observe.cjs > observed.txt',
        ),
      );
    if (fault === 'package-pretest' || fault === 'package-posttest')
      candidateWrite(
        root,
        'package.json',
        JSON.stringify({
          ...packageControl,
          scripts: {
            ...packageControl.scripts,
            [fault === 'package-pretest' ? 'pretest' : 'posttest']: 'node scripts/writer.cjs',
          },
        }),
      );
    if (fault === 'package-script-shell')
      candidateWrite(root, '.npmrc', 'script-shell=./scripts/executor.cjs\n');
    if (fault === 'workflow-shell')
      changed = 'defaults:\n  run:\n    shell: node scripts/writer.cjs {0}\n' + observation;
    if (fault === 'job-shell')
      changed = observation.replace(
        '  inspect:\n',
        '  inspect:\n    defaults:\n      run:\n        shell: node scripts/writer.cjs {0}\n',
      );
    if (fault === 'step-shell')
      changed = observation.replace(
        '      - run: "node scripts/observe.cjs"\n',
        '      - run: "node scripts/observe.cjs"\n        shell: node scripts/writer.cjs {0}\n',
      );
    if (fault === 'composite-shell')
      candidateWrite(
        root,
        '.github/actions/shell-control/action.yml',
        action.replace('shell: bash', 'shell: node scripts/writer.cjs {0}'),
      );
    if (fault === 'step-working-directory')
      changed = observation.replace(
        '      - run: "node scripts/observe.cjs"\n',
        '      - run: "node scripts/observe.cjs"\n        working-directory: nested\n',
      );
    expect(candidateEffect(root, changed)).toBe('unknown');
    const refused = observe(root, changed);
    expect(refused.status).toBe('review');
    expect(refused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(refused.findings ?? []).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
    ]);
    const serialized = changed
      .replace('inspect-${{ github.ref }}', 'devai-pages-publication')
      .replace('cancel-in-progress: true', 'cancel-in-progress: false');
    expect(candidateEffect(root, serialized)).toBe('unknown');
    const locked = observe(root, serialized);
    expect(locked.status).toBe('review');
    expect(locked.metrics?.concurrency_semantic_issues).toBe(1);
    expect(locked.findings ?? []).toEqual(refused.findings);
  });

  it('refuses a candidate package-bin node shadow after its complete npm control passes', () => {
    const root = candidateRoot();
    candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
    candidateWrite(root, 'scripts/observe.cjs', readOnlyCjs);
    candidateWrite(
      root,
      'package.json',
      JSON.stringify({ private: true, scripts: { test: 'node scripts/observe.cjs' } }),
    );
    const observation = candidateWorkflow('npm test');
    expect(candidateEffect(root, observation)).toBe('read-only');
    const control = observe(root, observation);
    expect(control.status).toBe('pass');
    expect(control.metrics?.concurrency_semantic_issues).toBe(0);
    expect(control.findings ?? []).toEqual([]);
    // Only this real contained package-bin executable is added after the control.
    // Its valid source and mode are inspected, never invoked by this test.
    candidateWrite(
      root,
      'node_modules/.bin/node',
      '#!/bin/sh\nprintf payload > selector-publication.txt\n',
    );
    chmodSync(join(root, 'node_modules/.bin/node'), 0o755);
    expect(candidateEffect(root, observation)).toBe('unknown');
    const refused = observe(root, observation);
    expect(refused.status).toBe('review');
    expect(refused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(refused.findings ?? []).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
    ]);
    const serialized = observation
      .replace('inspect-${{ github.ref }}', 'devai-pages-publication')
      .replace('cancel-in-progress: true', 'cancel-in-progress: false');
    expect(candidateEffect(root, serialized)).toBe('unknown');
    const locked = observe(root, serialized);
    expect(locked.status).toBe('review');
    expect(locked.metrics?.concurrency_semantic_issues).toBe(1);
    expect(locked.findings ?? []).toEqual(refused.findings);
  });

  it.each([
    'node-v8-coverage',
    'node-compile-cache',
    'step-leading-shell',
    'step-leading-env',
    'step-leading-cwd',
    'quoted-run',
    'quoted-uses',
    'composite-quoted-run',
  ] as const)(
    'refuses concealed invocation selector %s after its complete control passes',
    (fault) => {
      const root = candidateRoot();
      candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
      candidateWrite(root, 'scripts/observe.cjs', readOnlyCjs);
      candidateWrite(
        root,
        'scripts/writer.cjs',
        "const cp = require('node:child_process');\ncp.execFileSync('git', ['push', 'origin', 'HEAD']);\n",
      );
      const observerAction =
        'name: observation\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node scripts/observe.cjs\n';
      const writerAction =
        'name: writer\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node scripts/writer.cjs\n';
      candidateWrite(root, '.github/actions/selector-observer/action.yml', observerAction);
      candidateWrite(root, '.github/actions/selector-writer/action.yml', writerAction);
      const direct = candidateWorkflow('node scripts/observe.cjs');
      const observation =
        fault === 'composite-quoted-run'
          ? direct.replace(
              'run: "node scripts/observe.cjs"',
              'uses: ./.github/actions/selector-observer',
            )
          : direct;
      expect(candidateEffect(root, observation)).toBe('read-only');
      const control = observe(root, observation);
      expect(control.status).toBe('pass');
      expect(control.metrics?.concurrency_semantic_issues).toBe(0);
      expect(control.findings ?? []).toEqual([]);
      // One applicable env selector or serialized executable-bearing YAML form changes.
      // All candidate script/action bodies are present before this accepted control.
      let changed = observation;
      if (fault === 'node-v8-coverage' || fault === 'node-compile-cache')
        changed = observation.replace(
          '      - run: "node scripts/observe.cjs"\n',
          `      - run: "node scripts/observe.cjs"\n        env:\n          ${fault === 'node-v8-coverage' ? 'NODE_V8_COVERAGE' : 'NODE_COMPILE_CACHE'}: ./runtime-output\n`,
        );
      if (fault === 'step-leading-shell')
        changed = observation.replace(
          '      - run: "node scripts/observe.cjs"\n',
          '      - shell: bash\n        run: node scripts/writer.cjs\n',
        );
      if (fault === 'step-leading-env')
        changed = observation.replace(
          '      - run: "node scripts/observe.cjs"\n',
          '      - env:\n          OBSERVATION_ONLY: yes\n        run: node scripts/writer.cjs\n',
        );
      if (fault === 'step-leading-cwd')
        changed = observation.replace(
          '      - run: "node scripts/observe.cjs"\n',
          '      - working-directory: .\n        run: node scripts/writer.cjs\n',
        );
      if (fault === 'quoted-run')
        changed = observation.replace(
          '      - run: "node scripts/observe.cjs"\n',
          '      - "run": node scripts/writer.cjs\n',
        );
      if (fault === 'quoted-uses')
        changed = observation.replace(
          '      - run: "node scripts/observe.cjs"\n',
          '      - "uses": ./.github/actions/selector-writer\n',
        );
      if (fault === 'composite-quoted-run')
        candidateWrite(
          root,
          '.github/actions/selector-observer/action.yml',
          observerAction.replace('run: node scripts/observe.cjs', '"run": node scripts/writer.cjs'),
        );
      expect(candidateEffect(root, changed)).toBe('unknown');
      const refused = observe(root, changed);
      expect(refused.status).toBe('review');
      expect(refused.metrics?.concurrency_semantic_issues).toBe(1);
      expect(refused.findings ?? []).toEqual([
        {
          severity: 'warning',
          code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
          message:
            '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
        },
      ]);
      const serialized = changed
        .replace('inspect-${{ github.ref }}', 'devai-pages-publication')
        .replace('cancel-in-progress: true', 'cancel-in-progress: false');
      expect(candidateEffect(root, serialized)).toBe('unknown');
      const locked = observe(root, serialized);
      expect(locked.status).toBe('review');
      expect(locked.metrics?.concurrency_semantic_issues).toBe(1);
      expect(locked.findings ?? []).toEqual(refused.findings);
    },
  );

  it('keeps an actual node action unknown when description text impersonates composite metadata', () => {
    const root = candidateRoot();
    candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
    candidateWrite(root, 'scripts/observe.cjs', readOnlyCjs);
    candidateWrite(
      root,
      '.github/actions/selector-node/writer.cjs',
      "const cp = require('node:child_process');\ncp.execFileSync('git', ['push', 'origin', 'HEAD']);\n",
    );
    const nodeAction = 'name: node writer\nruns:\n  using: node20\n  main: writer.cjs\n';
    candidateWrite(root, '.github/actions/selector-node/action.yml', nodeAction);
    const observation = candidateWorkflow('node scripts/observe.cjs');
    expect(candidateEffect(root, observation)).toBe('read-only');
    const control = observe(root, observation);
    expect(control.status).toBe('pass');
    expect(control.metrics?.concurrency_semantic_issues).toBe(0);
    expect(control.findings ?? []).toEqual([]);
    const actionWorkflow = observation.replace(
      'run: "node scripts/observe.cjs"',
      'uses: ./.github/actions/selector-node',
    );
    // The genuine unsafe action baseline is refused before any description changes.
    expect(candidateEffect(root, actionWorkflow)).toBe('unknown');
    const beforeDescription = observe(root, actionWorkflow);
    expect(beforeDescription.status).toBe('review');
    expect(beforeDescription.metrics?.concurrency_semantic_issues).toBe(1);
    expect(beforeDescription.findings ?? []).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
    ]);
    // Only descriptive scalar text changes; actual runs.using/main remain byte-exact.
    candidateWrite(
      root,
      '.github/actions/selector-node/action.yml',
      nodeAction.replace(
        'name: node writer\n',
        'name: node writer\ndescription: |\n  using: composite\n',
      ),
    );
    expect(candidateEffect(root, actionWorkflow)).toBe('unknown');
    const afterDescription = observe(root, actionWorkflow);
    expect(afterDescription.status).toBe('review');
    expect(afterDescription.metrics?.concurrency_semantic_issues).toBe(1);
    expect(afterDescription.findings ?? []).toEqual(beforeDescription.findings);
    const serialized = actionWorkflow
      .replace('inspect-${{ github.ref }}', 'devai-pages-publication')
      .replace('cancel-in-progress: true', 'cancel-in-progress: false');
    expect(candidateEffect(root, serialized)).toBe('unknown');
    const locked = observe(root, serialized);
    expect(locked.status).toBe('review');
    expect(locked.metrics?.concurrency_semantic_issues).toBe(1);
    expect(locked.findings ?? []).toEqual(beforeDescription.findings);
  });

  it('keeps publication controls bound to the actual job when workflow name text impersonates them', () => {
    const root = candidateRoot();
    candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
    candidateWrite(root, 'scripts/observe.cjs', readOnlyCjs);
    candidateWrite(
      root,
      'scripts/actual-writer.cjs',
      "const fs = require('node:fs');\nfs.writeFileSync('fixtures/published.txt', 'payload');\n",
    );
    const observation = candidateWorkflow('node scripts/observe.cjs');
    expect(candidateEffect(root, observation)).toBe('read-only');
    const control = observe(root, observation);
    expect(control.status).toBe('pass');
    expect(control.metrics?.concurrency_semantic_issues).toBe(0);
    expect(control.findings ?? []).toEqual([]);
    const writer = candidateWorkflow('node scripts/actual-writer.cjs').replace(
      '    concurrency:\n      group: inspect-${{ github.ref }}\n      cancel-in-progress: true\n',
      '',
    );
    const actual = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      writer,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    // This is a genuine publication baseline with no actual job-level controls.
    expect(actual?.effect).toBe('publication');
    expect(actual?.concurrency).toBeUndefined();
    expect(actual?.condition).toBeUndefined();
    expect(actual?.needs).toBeUndefined();
    expect(actual?.environment).toBeUndefined();
    expect(actual?.permissions).toEqual({});
    const beforeName = observe(root, writer);
    expect(beforeName.status).toBe('review');
    expect(beforeName.metrics?.concurrency_semantic_issues).toBe(1);
    expect(beforeName.findings ?? []).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
    ]);
    // Only a descriptive scalar is inserted; the actual jobs subtree is unchanged.
    // The fake lock has the exact publication group/noncancel form but no authority.
    const deceptiveName =
      "name: |\n  inspect:\n    concurrency:\n      group: devai-pages-publication\n      cancel-in-progress: false\n    if: github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'\n    needs: [prepare]\n    environment: github-pages\n    permissions:\n      contents: read\n      pages: write\n      id-token: write\n" +
      writer;
    const after = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      deceptiveName,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    expect(after?.effect).toBe('publication');
    expect(after?.concurrency).toBeUndefined();
    expect(after?.condition).toBeUndefined();
    expect(after?.needs).toBeUndefined();
    expect(after?.environment).toBeUndefined();
    expect(after?.permissions).toEqual({});
    const afterName = observe(root, deceptiveName);
    expect(afterName.status).toBe('review');
    expect(afterName.metrics?.concurrency_semantic_issues).toBe(1);
    expect(afterName.findings ?? []).toEqual(beforeName.findings);
  });

  it('refuses a lossy clipped publication-lock scalar after its genuine plain-group control passes', () => {
    const root = candidateRoot();
    candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
    candidateWrite(root, 'scripts/observe.cjs', readOnlyCjs);
    candidateWrite(
      root,
      'scripts/scalar-writer.cjs',
      "const fs = require('node:fs');\nfs.writeFileSync('fixtures/scalar-publication.txt', 'payload');\n",
    );
    const plain =
      "on:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  prepare:\n    if: github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'\n    concurrency:\n      group: prepare-${{ github.ref }}\n      cancel-in-progress: true\n    steps:\n      - run: node scripts/observe.cjs\n  inspect:\n    if: github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'\n    needs: [prepare]\n    environment: github-pages\n    permissions:\n      contents: read\n      pages: write\n      id-token: write\n    concurrency:\n      group: devai-pages-publication\n      cancel-in-progress: false\n    steps:\n      - run: node scripts/scalar-writer.cjs\n";
    const actual = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      plain,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    expect(actual?.effect).toBe('publication');
    expect(actual?.concurrency).toEqual({
      group: 'devai-pages-publication',
      cancelInProgress: false,
    });
    expect(actual?.needs).toEqual(['prepare']);
    const control = observe(root, plain);
    expect(control.status).toBe('pass');
    expect(control.metrics?.concurrency_semantic_issues).toBe(0);
    expect(control.findings ?? []).toEqual([]);
    // Only the actual group scalar style changes; default clip preserves terminal LF.
    // Source, complete dependency jobs, conditions, permissions and lock cancellation stay exact.
    const clipped = plain.replace(
      '      group: devai-pages-publication\n',
      '      group: |\n        devai-pages-publication\n',
    );
    const changed = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      clipped,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    expect(changed?.effect).toBe('unknown');
    expect(changed?.concurrency?.group).not.toBe('devai-pages-publication');
    const refused = observe(root, clipped);
    expect(refused.status).toBe('review');
    expect(refused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(refused.findings ?? []).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
    ]);
  });

  it('keeps every actual writer and root cancellation visible through public workflow entry parsing', () => {
    const root = candidateRoot();
    candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
    candidateWrite(root, 'scripts/observe.cjs', readOnlyCjs);
    candidateWrite(
      root,
      'scripts/entry-writer.cjs',
      "const fs = require('node:fs');\nfs.writeFileSync('fixtures/entry-publication.txt', 'payload');\n",
    );
    const observation =
      'permissions:\n  contents: read\nconcurrency:\n  group: entry-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  observe:\n    steps:\n      - run: node scripts/observe.cjs\n';
    expect(candidateEffect(root, observation)).toBe('read-only');
    const control = observe(root, observation);
    expect(control.status).toBe('pass');
    expect(control.metrics?.concurrency_semantic_issues).toBe(0);
    expect(control.findings ?? []).toEqual([]);
    const writer =
      observation + '  inspect:\n    steps:\n      - run: node scripts/entry-writer.cjs\n';
    const baselineJob = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      writer,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    // The plain mixed inventory genuinely contains an unserialized publication job.
    expect(baselineJob?.effect).toBe('publication');
    const baseline = observe(root, writer);
    expect(baseline.status).toBe('review');
    expect(baseline.metrics?.concurrency_semantic_issues).toBe(1);
    expect(baseline.findings ?? []).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
    ]);
    const quotedInventories = [
      writer.replace('  inspect:\n', '  "inspect":\n'),
      writer.replace('  inspect:\n    steps:\n', '  inspect:\n    "steps":\n'),
      writer.replace('  inspect:\n    steps:\n', '  "inspect":\n    "steps":\n'),
      writer.replace('jobs:\n', '"jobs":\n'),
    ];
    // Each sibling changes only actual key spelling; the plain observer stays present.
    for (const quoted of quotedInventories) {
      const job = parseWorkflow(
        join(root, '.github/workflows/arbitrary.yml'),
        quoted,
        root,
      ).jobs.find((entry) => entry.name === 'inspect');
      expect(['publication', 'unknown']).toContain(job?.effect);
      const refused = observe(root, quoted);
      expect(refused.status).toBe('review');
      expect(refused.metrics?.concurrency_semantic_issues).toBe(1);
      expect(refused.findings ?? []).toEqual(baseline.findings);
    }
    const publication =
      "on:\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  prepare:\n    if: github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'\n    concurrency:\n      group: prepare-${{ github.ref }}\n      cancel-in-progress: true\n    steps:\n      - run: node scripts/observe.cjs\n  inspect:\n    if: github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'\n    needs: [prepare]\n    environment: github-pages\n    permissions:\n      contents: read\n      pages: write\n      id-token: write\n    concurrency:\n      group: devai-pages-publication\n      cancel-in-progress: false\n    steps:\n      - run: node scripts/entry-writer.cjs\n";
    const publicationJob = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      publication,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    // A complete actual shared job lock is a separate accepted publication control.
    expect(publicationJob?.effect).toBe('publication');
    expect(publicationJob?.concurrency).toEqual({
      group: 'devai-pages-publication',
      cancelInProgress: false,
    });
    const publicationControl = observe(root, publication);
    expect(publicationControl.status).toBe('pass');
    expect(publicationControl.metrics?.concurrency_semantic_issues).toBe(0);
    expect(publicationControl.findings ?? []).toEqual([]);
    const quotedRoot =
      '"concurrency":\n  group: entry-${{ github.ref }}\n  "cancel-in-progress": true\n' +
      publication;
    const quotedRootJob = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      quotedRoot,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    expect(['publication', 'unknown']).toContain(quotedRootJob?.effect);
    const rootRefused = observe(root, quotedRoot);
    expect(rootRefused.status).toBe('review');
    expect(rootRefused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(rootRefused.findings ?? []).toEqual(baseline.findings);
    const plainRoot =
      'concurrency:\n  group: entry-${{ github.ref }}\n  cancel-in-progress: true\n' + publication;
    const plainRootJob = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      plainRoot,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    // Real cancellable root declaration is refused before any descriptive counterfeit.
    expect(['publication', 'unknown']).toContain(plainRootJob?.effect);
    const actualRootRefused = observe(root, plainRoot);
    expect(actualRootRefused.status).toBe('review');
    expect(actualRootRefused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(actualRootRefused.findings ?? []).toEqual(baseline.findings);
    const counterfeit = plainRoot.replace(
      '  group: entry-${{ github.ref }}\n',
      '  group: |\n    entry-${{ github.ref }}\n    cancel-in-progress: false\n',
    );
    const counterfeitJob = parseWorkflow(
      join(root, '.github/workflows/arbitrary.yml'),
      counterfeit,
      root,
    ).jobs.find((job) => job.name === 'inspect');
    expect(['publication', 'unknown']).toContain(counterfeitJob?.effect);
    const counterfeitRefused = observe(root, counterfeit);
    expect(counterfeitRefused.status).toBe('review');
    expect(counterfeitRefused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(counterfeitRefused.findings ?? []).toEqual(actualRootRefused.findings);
  });
});

// Existing exported file-backed operations; appended without editing prior imports/source.
import * as workflowSourceBinding from '../../src/harness/workflow-parser.js';

describe('actual scheduler and selected workflow source binding (offline analysis)', () => {
  it('refuses trigger-projection borrowing and selected workflow source escapes after complete controls', () => {
    const root = candidateRoot();
    const observationSource =
      "const fs = require('node:fs');\nconst path = require('node:path');\nconst assert = require('node:assert/strict');\nconst value = fs.readFileSync(path.join('fixtures', 'control.txt'), 'utf8');\nassert.equal(value, 'contained observation\\n');\n";
    candidateWrite(root, 'fixtures/control.txt', 'contained observation\n');
    candidateWrite(root, 'scripts/schedule-observer.cjs', observationSource);
    const ordinary =
      'permissions:\n  contents: read\nconcurrency:\n  group: schedule-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  inspect:\n    steps:\n      - run: node scripts/schedule-observer.cjs\n';
    // Direct supplied-text parsing is valid before any workflow file exists.
    expect(candidateEffect(root, ordinary)).toBe('read-only');
    function reading(source: string) {
      candidateWrite(root, '.github/workflows/arbitrary.yml', source);
      return senseHarnessCoherence({ repoRoot: root, now: '2026-10-02T12:00:00.000Z' });
    }
    const ordinaryControl = reading(ordinary);
    expect(ordinaryControl.status).toBe('pass');
    expect(ordinaryControl.metrics?.concurrency_semantic_issues).toBe(0);
    expect(ordinaryControl.findings ?? []).toEqual([]);
    const schedulePrefix = 'on:\n  schedule:\n    - cron: "0 * * * *"\n';
    const scheduled =
      schedulePrefix +
      ordinary
        .replace('schedule-${{ github.ref }}', 'devai-pages-publication')
        .replace('cancel-in-progress: true', 'cancel-in-progress: false');
    expect(candidateEffect(root, scheduled)).toBe('read-only');
    const scheduledControl = reading(scheduled);
    expect(scheduledControl.status).toBe('pass');
    expect(scheduledControl.metrics?.concurrency_semantic_issues).toBe(0);
    expect(scheduledControl.findings ?? []).toEqual([]);
    const cancellable = schedulePrefix + ordinary;
    // This genuine actual schedule is unsafe before any trigger key is quoted.
    const scheduleRefused = reading(cancellable);
    expect(scheduleRefused.status).toBe('review');
    expect(scheduleRefused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(scheduleRefused.findings ?? []).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: false (serialized).',
      },
    ]);
    const quotedSchedule = cancellable.replace('  schedule:\n', '  "schedule":\n');
    expect(candidateEffect(root, quotedSchedule)).toBe('unknown');
    const quotedRefused = reading(quotedSchedule);
    expect(quotedRefused.status).toBe('review');
    expect(quotedRefused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(quotedRefused.findings ?? []).toMatchObject([
      { code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY' },
    ]);
    const unscheduled = scheduled.replace(schedulePrefix, 'on:\n  workflow_dispatch:\n');
    // A noncancel ordinary observation is also an honest unsafe profile baseline.
    const unscheduledRefused = reading(unscheduled);
    expect(unscheduledRefused.status).toBe('review');
    expect(unscheduledRefused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(unscheduledRefused.findings ?? []).toEqual([
      {
        severity: 'warning',
        code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
        message:
          '.github/workflows/arbitrary.yml must declare a non-empty concurrency group with cancel-in-progress: true (superseding).',
      },
    ]);
    const descriptiveSchedule = 'name: |\n  schedule:\n    - cron: "0 * * * *"\n' + unscheduled;
    expect(candidateEffect(root, descriptiveSchedule)).toBe('unknown');
    const descriptionRefused = reading(descriptiveSchedule);
    expect(descriptionRefused.status).toBe('review');
    expect(descriptionRefused.metrics?.concurrency_semantic_issues).toBe(1);
    expect(descriptionRefused.findings ?? []).toMatchObject([
      { code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY' },
    ]);
    const refusal = /WORKFLOW_SOURCE_BINDING_REFUSED/u;
    for (const fault of ['directory-escape', 'file-symlink-escape', 'dangling-source'] as const) {
      const contained = candidateRoot();
      const external = candidateRoot();
      candidateWrite(contained, 'fixtures/control.txt', 'contained observation\n');
      candidateWrite(contained, 'scripts/schedule-observer.cjs', observationSource);
      candidateWrite(external, 'fixtures/control.txt', 'contained observation\n');
      candidateWrite(external, 'scripts/schedule-observer.cjs', observationSource);
      candidateWrite(contained, '.github/workflows/a-safe.yml', ordinary);
      candidateWrite(contained, '.github/workflows/b-target.yml', ordinary);
      candidateWrite(contained, 'fixtures/workflows/control.yml', ordinary);
      candidateWrite(external, '.github/workflows/control.yml', ordinary);
      const selected = join(contained, '.github/workflows/b-target.yml');
      const files = [join(contained, '.github/workflows/a-safe.yml'), selected];
      // Every fault starts from a real complete contained default and custom loader.
      expect(workflowSourceBinding.listWorkflowFiles(contained)).toEqual(files);
      expect(workflowSourceBinding.loadWorkflows(contained).map((entry) => entry.file)).toEqual(
        files,
      );
      expect(
        workflowSourceBinding
          .loadWorkflows(contained)
          .every((entry) => entry.jobs.length === 1 && entry.jobs[0]?.effect === 'read-only'),
      ).toBe(true);
      expect(workflowSourceBinding.listWorkflowFiles(contained, 'fixtures/workflows')).toEqual([
        join(contained, 'fixtures/workflows/control.yml'),
      ]);
      expect(
        workflowSourceBinding.loadWorkflows(contained, 'fixtures/workflows')[0]?.jobs[0]?.effect,
      ).toBe('read-only');
      const fileControl = senseHarnessCoherence({
        repoRoot: contained,
        now: '2026-10-02T12:00:00.000Z',
      });
      expect(fileControl.status).toBe('pass');
      expect(fileControl.metrics?.workflow_count).toBe(2);
      expect(fileControl.findings ?? []).toEqual([]);
      if (fault === 'directory-escape') {
        const directory = join(external, '.github/workflows');
        expect(() => workflowSourceBinding.listWorkflowFiles(contained, directory)).toThrow(
          refusal,
        );
        expect(() => workflowSourceBinding.loadWorkflows(contained, directory)).toThrow(refusal);
        expect(() =>
          senseHarnessCoherence({ repoRoot: contained, workflowDir: directory }),
        ).toThrow(refusal);
      } else {
        rmSync(selected);
        symlinkSync(
          fault === 'file-symlink-escape'
            ? join(external, '.github/workflows/control.yml')
            : join(external, '.github/workflows/missing.yml'),
          selected,
        );
        expect(() => workflowSourceBinding.listWorkflowFiles(contained)).toThrow(refusal);
        expect(() => workflowSourceBinding.loadWorkflows(contained)).toThrow(refusal);
        expect(() => senseHarnessCoherence({ repoRoot: contained })).toThrow(refusal);
      }
    }
  });
});
