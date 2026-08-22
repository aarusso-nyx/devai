import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  buildCiScaffoldPlan,
  CHECKOUT_COMMIT,
  LEDGER_ENVIRONMENT,
  ledgerVerificationWorkflow,
  SETUP_NODE_COMMIT,
  VERIFIER_PACKAGE,
  VERIFIER_SOURCE_COMMIT,
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

function verifierMaterializationScript(source: string): string {
  const workflow = parse(source) as {
    jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const materialize = steps.find(
    (step) => step.name === 'Materialize protected DEVAI verifier package',
  );
  expect(materialize?.run).toBeTypeOf('string');
  return materialize?.run ?? '';
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
    const digestCheck = checkedIn.indexOf(
      'test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"',
    );
    const packageCopy = checkedIn.indexOf(
      'cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"',
    );
    const provenanceVerification = checkedIn.indexOf('const provenance = JSON.parse');
    expect(digestCheck).toBeGreaterThan(-1);
    expect(packageCopy).toBeGreaterThan(digestCheck);
    expect(provenanceVerification).toBeGreaterThan(packageCopy);
    expect(checkedIn).toContain("manifest.name !== '@aarusso-nyx/devai'");
    expect(checkedIn).toContain('DEVAI_VERIFIER_PACKAGE_BIN_INVALID:');
    expect(checkedIn).toContain('DEVAI_VERIFIER_PACKAGE_PROVENANCE_INVALID');
    expect(checkedIn).toContain('DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID');
    expect(checkedIn).not.toContain('devai-nyx/devai-verifier');
  });

  it.each([
    { name: 'ledger workflow', source: ledgerVerificationWorkflow() },
    {
      name: 'release workflow',
      source: readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8'),
    },
  ])('executes protected verifier materialization in the $name', ({ source }) => {
    const root = mkdtempSync(join(tmpdir(), 'devai-verifier-materialization-'));
    roots.push(root);
    const packageRoot = join(root, 'candidate/packages/cli');
    const sourceRoot = join(packageRoot, 'vendor/evidence-verification');
    const runnerTemp = join(root, 'runner-temp');
    const githubEnv = join(root, 'github-env');
    const githubOutput = join(root, 'github-output');
    const fixtureVersion = '9.8.7-materialization-fixture';
    mkdirSync(join(packageRoot, 'vendor'), { recursive: true });
    mkdirSync(runnerTemp, { recursive: true });
    cpSync(join(ROOT, 'packages/cli/vendor/evidence-verification'), sourceRoot, {
      recursive: true,
    });
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({
        name: '@aarusso-nyx/devai',
        version: fixtureVersion,
        bin: {
          'devai-evidence-policy': './dist/runtime/evidence-verification/src/build-policy-cli.js',
          'devai-evidence-verify': './dist/runtime/evidence-verification/src/cli.js',
          'devai-evidence-bundle-verify': './dist/runtime/evidence-verification/src/bundle-cli.js',
          'devai-evidence-export': './dist/runtime/evidence-verification/src/export-cli.js',
          'devai-evidence-publish': './dist/runtime/evidence-verification/src/publish-cli.js',
        },
      })}\n`,
    );
    writeFileSync(githubEnv, '');
    writeFileSync(githubOutput, '');
    const provenance = readFileSync(join(sourceRoot, 'provenance.json'));
    const provenanceDigest = createHash('sha256').update(provenance).digest('hex');

    const result = spawnSync('bash', ['-c', verifierMaterializationScript(source)], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: runnerTemp,
        GITHUB_ENV: githubEnv,
        GITHUB_OUTPUT: githubOutput,
        VERIFIER_PROVENANCE_SHA256: provenanceDigest,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(githubOutput, 'utf8').trim().split('\n')).toEqual([
      `version=${fixtureVersion}`,
      `provenance_sha256=${provenanceDigest}`,
    ]);
    expect(readFileSync(githubEnv, 'utf8').trim().split('\n')).toEqual([
      `DEVAI_EVIDENCE_POLICY=${runnerTemp}/devai-verifier-package/evidence-verification/src/build-policy-cli.js`,
      `DEVAI_EVIDENCE_VERIFY=${runnerTemp}/devai-verifier-package/evidence-verification/src/cli.js`,
      `DEVAI_EVIDENCE_BUNDLE_VERIFY=${runnerTemp}/devai-verifier-package/evidence-verification/src/bundle-cli.js`,
    ]);
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
      name: 'missing protected artifact archive',
      mutate: (source: string) =>
        source.replaceAll(
          'secrets.DEVAI_LEDGER_ARTIFACTS_TGZ_B64',
          'secrets.DEVAI_LEDGER_ARTIFACTS_REMOVED_B64',
        ),
      diagnostic: 'CI_EXTERNAL_CONTROL_INPUT_MISSING',
    },
    {
      name: 'missing protected verifier provenance digest',
      mutate: (source: string) =>
        source.replaceAll(
          'vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256',
          'vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_REMOVED',
        ),
      diagnostic: 'CI_EXTERNAL_CONTROL_INPUT_MISSING',
    },
    {
      name: 'verifier provenance digest mismatch accepted',
      mutate: (source: string) =>
        source.replace(
          'test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"',
          'test -n "$actual_provenance_sha256"',
        ),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'unsafe verifier package subtree accepted',
      mutate: (source: string) =>
        source.replace('DEVAI_VERIFIER_PACKAGE_SPECIAL_FILE_INVALID', 'special-file-ignored'),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'verifier package population is not checked',
      mutate: (source: string) =>
        source.replace('DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID', 'population-ignored'),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'verifier runtime population copy is bypassed',
      mutate: (source: string) =>
        source.replace(
          'cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"',
          'cp -R "$source_root/test" "$verifier_root/"',
        ),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'wrong package-owned verifier provenance',
      mutate: (source: string) => source.replace(VERIFIER_SOURCE_COMMIT, 'a'.repeat(40)),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'obsolete verifier repository identity',
      mutate: (source: string) => source.replace(VERIFIER_PACKAGE, 'devai-nyx/devai-verifier'),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'candidate-local verifier',
      mutate: (source: string) =>
        source.replace('node "$DEVAI_EVIDENCE_VERIFY"', 'node candidate/scripts/verify-ledger.mjs'),
      diagnostic: 'CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN',
    },
    {
      name: 'missing expected-policy reconstruction',
      mutate: (source: string) =>
        source.replace('node "$DEVAI_EVIDENCE_POLICY"', 'node -e "process.exit(0)"'),
      diagnostic: 'CI_EXPECTED_POLICY_RECONSTRUCTION_MISSING',
    },
    {
      name: 'legacy task-policy reconstruction',
      mutate: (source: string) =>
        source.replace('--schema-version 1.1.0', '--schema-version 1.0.0'),
      diagnostic: 'CI_EXPECTED_POLICY_BINDING_MISSING',
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
    {
      name: 'main tree-equivalent binding removed',
      mutate: (source: string) =>
        source.replace('echo "binding=exact-tree"', 'echo "binding=exact-commit"'),
      diagnostic: 'CI_VERIFIER_BINDING_MODE_INVALID',
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

  it('keeps publication explicit and rehearsal non-publishing, ledger-bound, and coverage-free', () => {
    const release = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const discipline = readFileSync(
      join(ROOT, 'docs/dev/operations/release-discipline.md'),
      'utf8',
    );
    const result = check(fixture(release, 'release.yml'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('workflow contract: PASS\n');
    expect(release).toContain("tags: ['v*']");
    expect(release).toContain('workflow_dispatch:');
    expect(release).toContain(
      "if: ${{ github.event_name == 'workflow_dispatch' && inputs.publish }}",
    );
    expect(release).toContain(
      "if: ${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && !inputs.publish) }}",
    );
    expect(release).toContain('environment: devai-rc-publication');
    expect(release).toContain('EXPECTED_ACTION_COUNT: 44');
    expect(release).toContain('pnpm run release:closure');
    expect(release).toContain('--binding exact-tree');
    expect(release).toContain(
      'npm --prefix "$sbom_root/package" install --omit=dev --ignore-scripts --no-audit --no-fund',
    );
    expect(release).not.toContain('--package-lock-only');
    expect(release).toContain('--tag "$PACKAGE_DIST_TAG"');
    expect(release).toContain('if test "$RELEASE_IS_PRERELEASE" = true');
    expect(release).toContain('dist-tags.$PACKAGE_DIST_TAG');
    expect(release).not.toContain('npm publish "$source_tgz" --tag next');
    expect(release).not.toContain('test:coverage');
    expect(discipline).toContain('The tag-push path verifies the uploaded workflow artifact');
    expect(discipline).toContain(
      '`publish: true` is the only path that may create or verify the canonical Release',
    );
    expect(discipline).not.toContain(
      'publication and Pages jobs are structurally restricted to a version-tag `push`',
    );
  });

  it('binds workflow, documentation, and release scripts into the RC task key', () => {
    const descriptor = JSON.parse(readFileSync(join(ROOT, 'test-tasks.json'), 'utf8')) as {
      tasks: Array<{
        nodeId: string;
        inputSelectors: Array<{ kind: string; pattern: string }>;
      }>;
    };
    const rc = descriptor.tasks.find((task) => task.nodeId === 'test:coverage:rc');
    expect(rc?.inputSelectors).toEqual(
      expect.arrayContaining([
        { kind: 'prefix', pattern: '.github/' },
        { kind: 'prefix', pattern: 'docs/' },
        { kind: 'prefix', pattern: 'scripts/' },
      ]),
    );
  });

  it('derives stable and prerelease channels from the exact package version', () => {
    const script = join(ROOT, 'scripts/release-channel.mjs');
    const stable = JSON.parse(
      execFileSync(process.execPath, [script, '1.0.0'], { encoding: 'utf8' }),
    ) as Record<string, unknown>;
    const candidate = JSON.parse(
      execFileSync(process.execPath, [script, '1.0.0-rc.7'], { encoding: 'utf8' }),
    ) as Record<string, unknown>;

    expect(stable).toMatchObject({
      version: '1.0.0',
      prerelease: false,
      release_type: 'stable',
      dist_tag: 'latest',
    });
    expect(candidate).toMatchObject({
      version: '1.0.0-rc.7',
      prerelease: true,
      release_type: 'prerelease',
      dist_tag: 'next',
    });
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
      name: 'lockfile-only SBOM dependency preparation',
      mutate: (source: string) =>
        source.replace(
          'install --omit=dev --ignore-scripts',
          'install --package-lock-only --ignore-scripts',
        ),
      diagnostic: 'RELEASE_SBOM_LOCKFILE_ONLY_FORBIDDEN',
    },
    {
      name: 'prerelease-only registry channel',
      mutate: (source: string) => source.replace('--tag "$PACKAGE_DIST_TAG"', '--tag next'),
      diagnostic: 'RELEASE_CONTROL_MISSING',
    },
    {
      name: 'stale installed action count',
      mutate: (source: string) =>
        source.replace('EXPECTED_ACTION_COUNT: 44', 'EXPECTED_ACTION_COUNT: 41'),
      diagnostic: 'RELEASE_IDENTITY_INVALID',
    },
    {
      name: 'non-version trigger',
      mutate: (source: string) => source.replace("tags: ['v*']", 'tags: [release-*]'),
      diagnostic: 'RELEASE_TRIGGER_INVALID',
    },
    {
      name: 'rehearsal publication guard removal',
      mutate: (source: string) =>
        source.replace(
          "    if: ${{ github.event_name == 'workflow_dispatch' && inputs.publish }}\n",
          '',
        ),
      diagnostic: 'RELEASE_REHEARSAL_PUBLICATION_GUARD_MISSING',
    },
    {
      name: 'missing protected tag signer trust',
      mutate: (source: string) =>
        source.replace('git -C candidate config gpg.format ssh', 'echo signer-trust-missing'),
      diagnostic: 'RELEASE_TAG_TRUST_MISSING',
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
    {
      name: 'release tree-equivalent binding removed',
      mutate: (source: string) => source.replace('--binding exact-tree', '--binding exact-commit'),
      diagnostic: 'RELEASE_CONTROL_MISSING',
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
