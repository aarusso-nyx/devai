import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCiScaffoldPlan,
  CHECKOUT_COMMIT,
  LEDGER_ENVIRONMENT,
  ledgerVerificationWorkflow,
  SETUP_NODE_COMMIT,
  VERIFIER_COMMIT,
} from '../../src/services/ci-scaffold/index.js';
import { checkCiEconomy } from '../../src/commands/check/ci-economy.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CHECKER = join(ROOT, 'scripts/check-workflows.mjs');
const roots: string[] = [];

function fixture(source = ledgerVerificationWorkflow(), file = 'devai-ledger-verify.yml') {
  const root = mkdtempSync(join(tmpdir(), 'devai-ledger-workflow-'));
  roots.push(root);
  const directory = join(root, '.github/workflows');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, file), source);
  const companion = file === 'release.yml' ? 'devai-ledger-verify.yml' : 'release.yml';
  writeFileSync(
    join(directory, companion),
    readFileSync(join(ROOT, '.github/workflows', companion), 'utf8'),
  );
  return root;
}

function check(root: string) {
  return spawnSync(process.execPath, [CHECKER], { cwd: root, encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('live ledger-verification workflow', () => {
  it('keeps the checked-in workflow byte-identical to the current scaffold', () => {
    const expected = ledgerVerificationWorkflow();
    const checkedIn = readFileSync(join(ROOT, '.github/workflows/devai-ledger-verify.yml'), 'utf8');
    const target = fixture();
    const plan = buildCiScaffoldPlan({ targetRoot: target });

    expect(checkedIn).toBe(expected);
    expect(plan).toMatchObject({
      path: join(target, '.github/workflows/devai-ledger-verify.yml'),
      content: expected,
      exists: true,
    });
    expect(execFileSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8' })).toBe(
      'workflow contract: PASS\n',
    );
  });

  it.each([
    {
      name: 'older immutable checkout action',
      mutate: (source: string) => source.replaceAll(CHECKOUT_COMMIT, 'a'.repeat(40)),
      diagnostic: 'CI_ACTION_PIN_MISMATCH',
    },
    {
      name: 'older immutable setup-node action',
      mutate: (source: string) => source.replace(SETUP_NODE_COMMIT, 'b'.repeat(40)),
      diagnostic: 'CI_ACTION_PIN_MISMATCH',
    },
    {
      name: 'candidate-controlled pull-request workflow',
      mutate: (source: string) => source.replace('pull_request_target:', 'pull_request:'),
      diagnostic: 'CI_WORKFLOW_TRUST_BOUNDARY_INVALID',
    },
    {
      name: 'missing protected environment',
      mutate: (source: string) => source.replace(`    environment: ${LEDGER_ENVIRONMENT}\n`, ''),
      diagnostic: 'CI_LEDGER_ENVIRONMENT_MISSING',
    },
    {
      name: 'mutable verifier ref',
      mutate: (source: string) => source.replace(VERIFIER_COMMIT, 'main'),
      diagnostic: 'CI_VERIFIER_REF_MUTABLE',
    },
    {
      name: 'wrong immutable verifier pin',
      mutate: (source: string) => source.replace(VERIFIER_COMMIT, 'a'.repeat(40)),
      diagnostic: 'CI_VERIFIER_PIN_MISMATCH',
    },
    {
      name: 'candidate-local verifier',
      mutate: (source: string) =>
        source.replace(
          'node .devai-verifier/src/cli.js',
          'node candidate/scripts/verify-ledger.mjs',
        ),
      diagnostic: 'CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN',
    },
    {
      name: 'remote product tests',
      mutate: (source: string) => source.replace('test "$POLICY_DIGEST" != ""', 'pnpm vitest run'),
      diagnostic: 'CI_PRODUCT_EXECUTION_FORBIDDEN',
    },
    {
      name: 'candidate SHA drift',
      mutate: (source: string) =>
        source.replaceAll(
          '${{ github.event.pull_request.head.sha || github.sha }}',
          '${{ github.sha }}',
        ),
      diagnostic: 'CI_CANDIDATE_SHA_UNBOUND',
    },
  ])('rejects $name', ({ mutate, diagnostic }) => {
    const result = check(fixture(mutate(ledgerVerificationWorkflow())));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it('rejects extra and obsolete workflow files', () => {
    const root = fixture();
    writeFileSync(join(root, '.github/workflows/cold-sentinel.yml'), 'name: old\non: push\n');
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CI_WORKFLOW_SET_INVALID');
    expect(result.stderr).toContain('CI_OBSOLETE_WORKFLOW_PRESENT');
  });

  it('keeps the release workflow tag-only, immutable, ledger-bound, and coverage-free', () => {
    const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const result = check(fixture(release, 'release.yml'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('workflow contract: PASS\n');
    expect(release).toContain("tags: ['v*']");
    expect(release).toContain('environment: devai-rc-publication');
    expect(release).toContain('pnpm run release:closure');
    expect(release).not.toContain('test:coverage');
  });

  it.each([
    {
      name: 'mutable release action',
      mutate: (source: string) =>
        source.replace(
          'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
          'actions/upload-artifact@v4',
        ),
      diagnostic: 'CI_ACTION_REFERENCE_MUTABLE',
    },
    {
      name: 'coverage rerun',
      mutate: (source: string) =>
        source.replace('pnpm run release:closure', 'pnpm run test:coverage:rc'),
      diagnostic: 'RELEASE_TEST_REEXECUTION_FORBIDDEN',
    },
    {
      name: 'non-version trigger',
      mutate: (source: string) => source.replace("tags: ['v*']", 'tags: [release-*]'),
      diagnostic: 'RELEASE_TRIGGER_INVALID',
    },
    {
      name: 'redundant pnpm version input',
      mutate: (source: string) =>
        source.replace('run_install: false', 'version: 9.15.0\n          run_install: false'),
      diagnostic: 'RELEASE_PNPM_VERSION_CONFLICT',
    },
    {
      name: 'peeled pnpm commit substituted for the authentic annotated-tag object',
      mutate: (source: string) =>
        source.replace(
          '7088e561eb65bb68695d245aa206f005ef30921d',
          'a7487c7e89a18df4991f7f222e4898a00d66ddda',
        ),
      diagnostic: 'CI_ACTION_PIN_MISMATCH',
    },
    {
      name: 'replaceable Release assets',
      mutate: (source: string) =>
        source.replace(
          'gh release create',
          'gh release upload --clobber\n            gh release create',
        ),
      diagnostic: 'RELEASE_ASSET_CLOBBER_FORBIDDEN',
    },
  ])('rejects $name', ({ mutate, diagnostic }) => {
    const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const result = check(fixture(mutate(release), 'release.yml'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });

  it('exposes only the current init scaffold help surface', () => {
    const source = readFileSync(join(ROOT, 'packages/cli/src/commands/init/index.ts'), 'utf8');
    expect(source).toContain('.github/workflows/devai-ledger-verify.yml');
    expect(source).not.toContain('--devai-ref');
    expect(source).not.toContain('--chain-file');
    expect(source).not.toContain('--mode <mode>');
  });

  it('binds live check adapters to canonical local and RC config names', () => {
    const source = readFileSync(join(ROOT, 'packages/cli/src/commands/check/adapters.ts'), 'utf8');
    expect(source).toContain('tests/config/rc.containment.config.ts');
    expect(source).toContain('tests/config/rc.coverage.config.ts');
    expect(source).toContain('--coverage.reportsDirectory=scratch/coverage/rc');
    expect(source).not.toContain('tests/config/t6.containment.config.ts');
    expect(source).not.toContain('tests/config/t1-t3.coverage.config.ts');

    const economy = checkCiEconomy({ repoRoot: ROOT });
    expect(economy.workflows_scanned).toBe(2);
    expect(
      economy.findings.find((finding) => finding.ruleId === 'ci-economy.evidence-gate-wired'),
    ).toMatchObject({ severity: 'pass' });
    expect(
      economy.findings.some((finding) => finding.ruleId === 'ci-economy.scheduled-audit'),
    ).toBe(false);
  });
});
