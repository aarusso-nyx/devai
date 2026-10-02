// TASK-0254, campaign CMP-0002 round R-0205: pull-request-checks.yml,
// release.yml, and devai-ledger-verify.yml delegate their repeated pnpm/Node
// setup to the shared composite action at
// .github/actions/setup-node-toolchain, so the F5 harness_coherence and
// harness_idiomaticity sensors (packages/sensors/src/harness-coherence.ts,
// harness-idiomaticity.ts) read a uniform, idiomatic CI surface. This file
// created new; no prior workflow-shape.contract.test.ts existed.
//
// scripts/check-workflows.mjs validates the composite action's own action.yml
// pins the same way it validates inline workflow steps
// (checkCompositeActionPins / validateActionStepPins), and continues to
// forbid any *other* local ("./...") action reference and to keep the
// checkout/setup-node/pnpm pins and the secret bijection intact.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
interface WorkflowFinding {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}
const { checkWorkflowTree } = (await import(
  pathToFileURL(join(ROOT, 'scripts/check-workflows.mjs')).href
)) as { checkWorkflowTree: (root: string) => { ok: boolean; findings: WorkflowFinding[] } };

const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');
const ACTIONS_DIR = resolve(ROOT, '.github/actions');
const MANIFEST_PATH = resolve(ROOT, '.devai/config/toolchain.json');
const CREDENTIAL_MANIFEST_PATH = resolve(ROOT, 'law/policy/credential-requirements.json');
const SHARED_SETUP_ACTION = './.github/actions/setup-node-toolchain';
const COMPOSITE_ACTION_FILE = resolve(ACTIONS_DIR, 'setup-node-toolchain/action.yml');
const REQUIRED_WORKFLOWS = [
  'pull-request-checks.yml',
  'release.yml',
  'devai-ledger-verify.yml',
  'site-publish.yml',
] as const;
// devai-ledger-verify.yml keeps its single Node setup step inline rather than
// delegating to the shared composite: tests/contract/check-workflows-manifest.contract.test.ts
// (outside this task's boundary paths) asserts on the literal `node-version: 24`
// inside that exact file, and TASK-0254's boundary forbids editing it.
const WORKFLOWS_USING_SHARED_SETUP = [
  'pull-request-checks.yml',
  'release.yml',
  'site-publish.yml',
] as const;
// release.yml jobs that check the repository out under a path (candidate/ or
// release-control/) rather than at the workspace root: a local action cannot
// resolve there, so their Node setup is the inline pinned actions/setup-node
// step, never the shared composite (release fix of pull request #208).
const PATH_CHECKOUT_RELEASE_JOBS = ['verify-ledger', 'deploy-pages'] as const;
// Root-checkout release.yml jobs that keep the shared composite.
const ROOT_CHECKOUT_RELEASE_JOBS = ['build-release', 'finalize-release'] as const;
const BUILD_RELEASE_SETUP_STEP = 'name: Set up pnpm and Node with GitHub Packages';

type WorkflowStep = Readonly<{ uses?: unknown; with?: Readonly<Record<string, unknown>> }>;

function releaseJobSteps(job: string): readonly WorkflowStep[] {
  const workflow = parse(readFileSync(join(WORKFLOWS_DIR, 'release.yml'), 'utf8')) as {
    jobs?: Record<string, { steps?: WorkflowStep[] }>;
  };
  const steps = workflow.jobs?.[job]?.steps;
  expect(steps, `release.yml declares jobs.${job}.steps`).toBeDefined();
  return steps ?? [];
}

/** The actions/setup-node pin the shared composite action carries. */
function compositeSetupNodePin(): string {
  const match = /uses: (actions\/setup-node@[0-9a-f]{40})/u.exec(
    readFileSync(COMPOSITE_ACTION_FILE, 'utf8'),
  );
  expect(match, 'the composite action pins actions/setup-node').not.toBeNull();
  return match?.[1] ?? '';
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** Copies the real workflow tree, the composite action tree, and both
 * manifests into a scratch root, so the checker's other rules stay satisfied
 * and only the mutation under test can produce a finding. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-workflow-shape-check-'));
  roots.push(root);
  const workflowsOut = join(root, '.github/workflows');
  mkdirSync(workflowsOut, { recursive: true });
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    writeFileSync(join(workflowsOut, name), readFileSync(join(WORKFLOWS_DIR, name)));
  }
  cpSync(ACTIONS_DIR, join(root, '.github/actions'), { recursive: true });
  const configOut = join(root, '.devai/config');
  mkdirSync(configOut, { recursive: true });
  writeFileSync(join(configOut, 'toolchain.json'), readFileSync(MANIFEST_PATH));
  const policyOut = join(root, 'law/policy');
  mkdirSync(policyOut, { recursive: true });
  writeFileSync(
    join(policyOut, 'credential-requirements.json'),
    readFileSync(CREDENTIAL_MANIFEST_PATH),
  );
  return root;
}

function mutateFile(path: string, from: string, to: string): void {
  const source = readFileSync(path, 'utf8');
  expect(source).toContain(from);
  writeFileSync(path, source.replace(from, to));
}

describe('shared setup composite action exists and is used uniformly', () => {
  it('is present on disk as a composite action', () => {
    expect(existsSync(COMPOSITE_ACTION_FILE)).toBe(true);
    const action = readFileSync(COMPOSITE_ACTION_FILE, 'utf8');
    expect(action).toContain('using: composite');
  });

  it('is referenced by pull-request-checks.yml, release.yml and site-publish.yml, so their repeated setup steps are shared rather than duplicated', () => {
    for (const file of WORKFLOWS_USING_SHARED_SETUP) {
      const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      expect(source, `${file} must delegate setup to ${SHARED_SETUP_ACTION}`).toContain(
        SHARED_SETUP_ACTION,
      );
    }
  });

  it('passes the workflow checker unmodified', () => {
    const root = fixture();
    const result = checkWorkflowTree(root);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
  });
});

describe('composite action pins are validated the same way inline steps are', () => {
  it('flags a divergent digest inside the composite action itself', () => {
    const root = fixture();
    const path = join(root, '.github/actions/setup-node-toolchain/action.yml');
    mutateFile(
      path,
      'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      `uses: actions/setup-node@${'f'.repeat(40)}`,
    );

    const result = checkWorkflowTree(root);

    const named = result.findings.find(
      (item) =>
        item.file.includes('setup-node-toolchain') &&
        item.detail.includes('actions/setup-node') &&
        item.detail.includes('f'.repeat(40)),
    );
    expect(named, JSON.stringify(result.findings)).toBeDefined();
  });

  it('flags a node-version drift inside the composite action itself', () => {
    const root = fixture();
    const path = join(root, '.github/actions/setup-node-toolchain/action.yml');
    mutateFile(path, 'node-version: 24', 'node-version: 99');

    const result = checkWorkflowTree(root);

    const named = result.findings.find(
      (item) =>
        item.file.includes('setup-node-toolchain') &&
        /node/iu.test(item.detail) &&
        item.detail.includes('99'),
    );
    expect(named, JSON.stringify(result.findings)).toBeDefined();
  });

  it('rejects a composite action that references a further local action instead of a pinned external one', () => {
    const root = fixture();
    const path = join(root, '.github/actions/setup-node-toolchain/action.yml');
    mutateFile(
      path,
      'uses: pnpm/action-setup@7088e561eb65bb68695d245aa206f005ef30921d # v4.1.0',
      'uses: ./.github/actions/some-nested-action',
    );

    const result = checkWorkflowTree(root);

    const named = result.findings.find(
      (item) => item.code === 'CI_COMPOSITE_ACTION_LOCAL_USE_FORBIDDEN',
    );
    expect(named, JSON.stringify(result.findings)).toBeDefined();
  });

  it('still forbids any local action reference other than the recognized shared composite', () => {
    const root = fixture();
    const path = join(root, '.github/workflows/release.yml');
    mutateFile(
      path,
      `${BUILD_RELEASE_SETUP_STEP}\n        uses: ${SHARED_SETUP_ACTION}\n`,
      `${BUILD_RELEASE_SETUP_STEP}\n        uses: ./.github/actions/some-other-action\n`,
    );

    const result = checkWorkflowTree(root);

    const named = result.findings.find(
      (item) =>
        item.file === 'release.yml' &&
        item.code === 'CI_ACTION_REFERENCE_MUTABLE' &&
        item.detail.includes('build-release') &&
        item.detail.includes('./.github/actions/some-other-action'),
    );
    expect(named, JSON.stringify(result.findings)).toBeDefined();
  });

  it('still forbids a local action other than the shared composite in pull-request-checks.yml', () => {
    const root = fixture();
    const path = join(root, '.github/workflows/pull-request-checks.yml');
    mutateFile(
      path,
      `uses: ${SHARED_SETUP_ACTION}\n`,
      'uses: ./.github/actions/some-other-action\n',
    );

    const result = checkWorkflowTree(root);

    const named = result.findings.find(
      (item) =>
        item.file === 'pull-request-checks.yml' &&
        item.code === 'CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN' &&
        item.detail.includes('./.github/actions/some-other-action'),
    );
    expect(named, JSON.stringify(result.findings)).toBeDefined();
  });

  it('flags a divergent inline actions/setup-node pin in the verify-ledger job', () => {
    const root = fixture();
    const path = join(root, '.github/workflows/release.yml');
    const pin = compositeSetupNodePin();
    mutateFile(
      path,
      `name: Set up verifier runtime\n        uses: ${pin}\n`,
      `name: Set up verifier runtime\n        uses: actions/setup-node@${'f'.repeat(40)}\n`,
    );

    const result = checkWorkflowTree(root);

    const named = result.findings.find(
      (item) =>
        item.file === 'release.yml' &&
        item.code === 'CI_ACTION_PIN_MISMATCH' &&
        item.detail.includes('verify-ledger') &&
        item.detail.includes('f'.repeat(40)),
    );
    expect(named, JSON.stringify(result.findings)).toBeDefined();
  });
});

describe('release.yml sets Node up by checkout shape', () => {
  it.each(PATH_CHECKOUT_RELEASE_JOBS)(
    '%s, which checks out under a path, uses the inline pinned actions/setup-node step and no local action',
    (job) => {
      const steps = releaseJobSteps(job);
      const uses = steps.map((step) => (typeof step.uses === 'string' ? step.uses : ''));
      expect(
        uses.filter((reference) => reference.startsWith('./')),
        `${job} references no local action`,
      ).toEqual([]);
      const setup = steps.filter((step) => step.uses === compositeSetupNodePin());
      expect(setup, `${job} carries one inline pinned actions/setup-node step`).toHaveLength(1);
      expect(String(setup[0]?.with?.['node-version'])).toBe('24');
    },
  );

  it.each(ROOT_CHECKOUT_RELEASE_JOBS)(
    '%s, which checks out at the workspace root, delegates setup to the shared composite',
    (job) => {
      const uses = releaseJobSteps(job).map((step) => step.uses);
      expect(uses).toContain(SHARED_SETUP_ACTION);
      expect(
        uses.filter((reference) => String(reference).startsWith('actions/setup-node@')),
      ).toEqual([]);
    },
  );
});

describe('concurrency and permissions blocks are uniform across the four workflows', () => {
  it('declares a top-level permissions block in every workflow', () => {
    for (const file of REQUIRED_WORKFLOWS) {
      const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      expect(source, `${file} must declare top-level permissions`).toMatch(/^permissions:/mu);
    }
  });

  it('declares a top-level concurrency block with a group and an explicit cancel-in-progress in every workflow', () => {
    for (const file of REQUIRED_WORKFLOWS) {
      const source = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      expect(source, `${file} must declare top-level concurrency`).toMatch(/^concurrency:/mu);
      expect(source, `${file} concurrency must declare cancel-in-progress`).toMatch(
        /cancel-in-progress:\s*(true|false)/u,
      );
    }
  });

  it('serializes the ledger verification workflow by commit (never cancels a distinct sha) while superseding stale runs of the same sha', () => {
    const source = readFileSync(join(WORKFLOWS_DIR, 'devai-ledger-verify.yml'), 'utf8');
    expect(source).toContain('group: devai-ledger-verify-${{ github.sha }}');
    expect(source).toContain('cancel-in-progress: true');
  });
});

describe('dependency caching is present in the shared setup', () => {
  it('the composite action forwards a cache input to actions/setup-node', () => {
    const action = readFileSync(COMPOSITE_ACTION_FILE, 'utf8');
    expect(action).toMatch(/cache:\s*\$\{\{\s*inputs\.cache\s*\}\}/u);
  });

  it('every pnpm install site in the release and preflight workflows enables the composite cache', () => {
    const preflight = readFileSync(join(WORKFLOWS_DIR, 'pull-request-checks.yml'), 'utf8');
    expect(preflight).toMatch(/setup-pnpm:\s*'true'[\s\S]*?cache:\s*pnpm/u);

    const release = readFileSync(join(WORKFLOWS_DIR, 'release.yml'), 'utf8');
    expect(release).toMatch(/setup-pnpm:\s*'true'[\s\S]*?cache:\s*pnpm/u);
  });
});

// Invariants: INV-CORE-003, INV-HARNESS-006
// ADR-MDL-0004: named provider-free scored gate joins, rather than skips, the floor.
describe('provider-free scored gate source integration', () => {
  it('retains every mandatory hard stage and consumes selected soft evidence', () => {
    const source = readFileSync(join(WORKFLOWS_DIR, 'pull-request-checks.yml'), 'utf8');
    expect(source).toContain('release:bootstrap');
    expect(source).toContain('check-ci-invariant-gate');
    expect(source).toContain('fetch-ci-invariant-evidence');
    expect(source).not.toMatch(
      /produce-ci-invariant-evidence|claude(?:\s|$)|codex exec|OPENAI_API_KEY|ANTHROPIC_API_KEY/u,
    );
    const parsed = parse(source) as {
      jobs: Record<
        string,
        {
          steps?: {
            id?: string;
            run?: string;
            'continue-on-error'?: unknown;
            env?: Record<string, string>;
          }[];
        }
      >;
    };
    const steps = parsed.jobs.preflight?.steps ?? [];
    const soft = steps.filter((step) => step.id === 'soft-gate');
    expect(soft).toHaveLength(1);
    expect(soft[0]?.['continue-on-error']).not.toBe(true);
    expect(soft[0]?.env).toEqual({
      DEVAI_SOFT_GATE_TRUST_JSON: '${{ vars.DEVAI_SOFT_GATE_TRUST_JSON }}',
    });
    expect(source.match(/vars\.DEVAI_SOFT_GATE_TRUST_JSON/gu)).toHaveLength(1);
  });
});
