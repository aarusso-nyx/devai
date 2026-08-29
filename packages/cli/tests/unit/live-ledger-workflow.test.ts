import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
const CHECKED_IN_LEDGER = readFileSync(
  join(ROOT, '.github/workflows/devai-ledger-verify.yml'),
  'utf8',
);
const PREFLIGHT_WORKFLOW_FILE = 'pull-request-checks.yml';
const CHECKED_IN_PREFLIGHT = readFileSync(
  join(ROOT, '.github/workflows', PREFLIGHT_WORKFLOW_FILE),
  'utf8',
);
const VERIFIER_POLICY = JSON.parse(
  readFileSync(join(ROOT, 'law/policy/trusted-local-rc-verifier-package.json'), 'utf8'),
) as {
  package: {
    name: string;
    version: string;
    registry: string;
    tarball: string;
    shasum_sha1: string;
    integrity_sri: string;
    release_source: { repository: string; commit: string; tree: string };
  };
  verifier: { provenance_sha256: string; root: string };
};
const roots: string[] = [];
const EXPLICIT_PUBLISH_CONDITION =
  "${{ github.event_name == 'workflow_dispatch' && inputs.publish }}";
const REHEARSAL_CONDITION =
  "${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && !inputs.publish) }}";
const PERMISSIVE_PUSH_PUBLICATION_CONDITION =
  "${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.publish) }}";
const DISPATCH_ONLY_REHEARSAL_CONDITION =
  "${{ github.event_name == 'workflow_dispatch' && !inputs.publish }}";

/**
 * Both RC workflows are mandatory in every fixture; the preflight lane is
 * optional and is written only when a case asks for it. Copying the checked-in
 * bytes for whichever file the case is not mutating keeps a fixture from
 * failing CI_WORKFLOW_SET_INVALID for an unrelated reason.
 */
const REQUIRED_WORKFLOWS = ['devai-ledger-verify.yml', 'release.yml'] as const;

function fixture(source = CHECKED_IN_LEDGER, file = 'devai-ledger-verify.yml') {
  const root = mkdtempSync(join(tmpdir(), 'devai-ledger-workflow-'));
  roots.push(root);
  const directory = join(root, '.github/workflows');
  mkdirSync(directory, { recursive: true });
  for (const required of REQUIRED_WORKFLOWS) {
    if (required === file) continue;
    writeFileSync(
      join(directory, required),
      readFileSync(join(ROOT, '.github/workflows', required), 'utf8'),
    );
  }
  writeFileSync(join(directory, file), source);
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

function executablePackageMaterializationFixture(
  source = ledgerVerificationWorkflow(),
  mutate?: (packageRoot: string, verifierRoot: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'devai-verifier-materialization-'));
  roots.push(root);
  const packageRoot = join(root, 'package');
  const verifierRoot = join(packageRoot, VERIFIER_POLICY.verifier.root);
  const runnerTemp = join(root, 'runner-temp');
  const githubEnv = join(root, 'github-env');
  const githubOutput = join(root, 'github-output');
  const archive = join(root, 'package.tgz');
  const mockBin = join(root, 'mock-bin');
  mkdirSync(verifierRoot, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(mockBin, { recursive: true });
  cpSync(
    join(ROOT, 'packages/cli/vendor/evidence-verification/provenance.json'),
    join(verifierRoot, 'provenance.json'),
  );
  cpSync(
    join(ROOT, 'packages/cli/vendor/evidence-verification/schemas'),
    join(verifierRoot, 'schemas'),
    {
      recursive: true,
    },
  );
  cpSync(join(ROOT, 'packages/cli/vendor/evidence-verification/src'), join(verifierRoot, 'src'), {
    recursive: true,
  });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({
      name: VERIFIER_POLICY.package.name,
      version: VERIFIER_POLICY.package.version,
      bin: {
        'devai-evidence-policy': './dist/runtime/evidence-verification/src/build-policy-cli.js',
        'devai-evidence-verify': './dist/runtime/evidence-verification/src/cli.js',
        'devai-evidence-bundle-verify': './dist/runtime/evidence-verification/src/bundle-cli.js',
        'devai-evidence-export': './dist/runtime/evidence-verification/src/export-cli.js',
        'devai-evidence-publish': './dist/runtime/evidence-verification/src/publish-cli.js',
      },
    })}\n`,
  );
  mutate?.(packageRoot, verifierRoot);
  execFileSync('tar', ['-czf', archive, '--format', 'ustar', 'package'], {
    cwd: root,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const archiveBytes = readFileSync(archive);
  const shasum = createHash('sha1').update(archiveBytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`;
  const provenanceDigest = createHash('sha256')
    .update(readFileSync(join(verifierRoot, 'provenance.json')))
    .digest('hex');
  const provenanceSourceCommit = JSON.parse(
    readFileSync(join(verifierRoot, 'provenance.json'), 'utf8'),
  ).sourceCommit as string;
  const registry = 'https://registry.fixture.invalid';
  const tarball = `${registry}/package.tgz`;
  const releaseRef = `https://api.github.com/repos/${VERIFIER_POLICY.package.release_source.repository}/git/ref/tags/v${VERIFIER_POLICY.package.version}`;
  const tagUrl = 'https://api.fixture.invalid/tag';
  const commitUrl = 'https://api.fixture.invalid/commit';
  const responses = {
    [`${registry}/${encodeURIComponent(VERIFIER_POLICY.package.name).replace('%40', '@')}`]: {
      json: {
        name: VERIFIER_POLICY.package.name,
        versions: {
          [VERIFIER_POLICY.package.version]: {
            version: VERIFIER_POLICY.package.version,
            dist: { tarball, shasum, integrity },
          },
        },
      },
    },
    [tarball]: { file: archive },
    [releaseRef]: { json: { object: { type: 'tag', url: tagUrl } } },
    [tagUrl]: {
      json: {
        object: {
          type: 'commit',
          url: commitUrl,
          sha: VERIFIER_POLICY.package.release_source.commit,
        },
      },
    },
    [commitUrl]: {
      json: {
        sha: VERIFIER_POLICY.package.release_source.commit,
        tree: { sha: VERIFIER_POLICY.package.release_source.tree },
      },
    },
  };
  const curl = join(mockBin, 'curl');
  writeFileSync(
    curl,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
const url = args.at(-1);
if (!args.includes('Authorization: Bearer fixture-token')) process.exit(91);
const response = JSON.parse(process.env.MOCK_CURL_RESPONSES)[url];
if (!response || !output) process.exit(92);
if (response.file) fs.copyFileSync(response.file, output);
else fs.writeFileSync(output, JSON.stringify(response.json));
`,
  );
  chmodSync(curl, 0o755);
  writeFileSync(githubEnv, '');
  writeFileSync(githubOutput, '');
  const script = verifierMaterializationScript(source)
    .replaceAll(VERIFIER_POLICY.package.tarball, tarball)
    .replaceAll(VERIFIER_POLICY.package.registry, registry)
    .replaceAll(VERIFIER_POLICY.package.shasum_sha1, shasum)
    .replaceAll(VERIFIER_POLICY.package.integrity_sri, integrity)
    .replaceAll(VERIFIER_POLICY.verifier.provenance_sha256, provenanceDigest)
    .replaceAll(VERIFIER_SOURCE_COMMIT, provenanceSourceCommit);
  return {
    root,
    runnerTemp,
    githubEnv,
    githubOutput,
    script,
    provenanceDigest,
    env: {
      ...process.env,
      PATH: `${mockBin}:${process.env.PATH ?? ''}`,
      NODE_AUTH_TOKEN: 'fixture-token',
      VERIFIER_PROVENANCE_SHA256: provenanceDigest,
      RUNNER_TEMP: runnerTemp,
      GITHUB_ENV: githubEnv,
      GITHUB_OUTPUT: githubOutput,
      MOCK_CURL_RESPONSES: JSON.stringify(responses),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('live ledger-verification workflow', () => {
  it('keeps the immutable generated scaffold separate from the checked-in DEVAI workflow contract', () => {
    const expected = ledgerVerificationWorkflow();
    const target = fixture();
    const plan = buildCiScaffoldPlan({ targetRoot: target });

    expect(plan).toMatchObject({
      path: join(target, '.github/workflows/devai-ledger-verify.yml'),
      content: expected,
      exists: true,
    });
    expect(execFileSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8' })).toBe(
      'workflow contract: PASS\n',
    );
    const digestCheck = expected.indexOf(
      'test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"',
    );
    const packageExtraction = expected.indexOf(
      'tar -xzf "$archive" --directory "$control/extracted" --no-same-owner --no-same-permissions',
    );
    const provenanceVerification = expected.indexOf('const provenance = JSON.parse');
    expect(digestCheck).toBeGreaterThan(-1);
    expect(packageExtraction).toBeGreaterThan(-1);
    expect(provenanceVerification).toBeGreaterThan(packageExtraction);
    expect(expected).toContain("manifest.name !== '@aarusso-nyx/devai'");
    expect(expected).toContain('DEVAI_VERIFIER_PACKAGE_BIN_INVALID:');
    expect(expected).toContain('DEVAI_VERIFIER_PACKAGE_PROVENANCE_INVALID');
    expect(expected).toContain('DEVAI_VERIFIER_PACKAGE_FILE_MISSING:');
    expect(expected).toContain('DEVAI_VERIFIER_PACKAGE_FILE_EXTRA:');
    expect(expected).not.toContain('candidate/packages/cli');
    expect(expected).not.toContain('devai-nyx/devai-verifier');
  });

  it('executes authenticated immutable-package materialization in the generated ledger workflow', () => {
    const materialization = executablePackageMaterializationFixture();
    const result = spawnSync('bash', ['-c', materialization.script], {
      cwd: materialization.root,
      encoding: 'utf8',
      env: materialization.env,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(materialization.githubOutput, 'utf8').trim().split('\n')).toEqual([
      `version=${VERIFIER_POLICY.package.version}`,
      `provenance_sha256=${materialization.provenanceDigest}`,
    ]);
    const installedVerifier = `${materialization.runnerTemp}/devai-verifier-package/extracted/package/${VERIFIER_POLICY.verifier.root}`;
    expect(readFileSync(materialization.githubEnv, 'utf8').trim().split('\n')).toEqual([
      `DEVAI_EVIDENCE_POLICY=${installedVerifier}/src/build-policy-cli.js`,
      `DEVAI_EVIDENCE_VERIFY=${installedVerifier}/src/cli.js`,
      `DEVAI_EVIDENCE_BUNDLE_VERIFY=${installedVerifier}/src/bundle-cli.js`,
    ]);
  });

  it.each([
    { name: 'missing', token: undefined },
    { name: 'empty', token: '' },
  ])('fails before registry access when PACKAGES_READ_TOKEN is $name', ({ token }) => {
    const materialization = executablePackageMaterializationFixture();
    const env = { ...materialization.env } as Record<string, string | undefined>;
    if (token === undefined) delete env.NODE_AUTH_TOKEN;
    else env.NODE_AUTH_TOKEN = token;
    const result = spawnSync('bash', ['-c', materialization.script], {
      cwd: materialization.root,
      encoding: 'utf8',
      env,
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(materialization.githubOutput, 'utf8')).toBe('');
  });

  it.each([
    {
      name: 'a missing declared verifier file',
      mutate: (_packageRoot: string, verifierRoot: string) =>
        rmSync(join(verifierRoot, 'src/verify.js')),
      diagnostic: 'DEVAI_VERIFIER_PACKAGE_FILE_MISSING',
    },
    {
      name: 'an extra verifier file',
      mutate: (_packageRoot: string, verifierRoot: string) =>
        writeFileSync(join(verifierRoot, 'src/extra.js'), 'export {};\n'),
      diagnostic: 'DEVAI_VERIFIER_PACKAGE_FILE_EXTRA',
    },
    {
      name: 'verifier file digest drift',
      mutate: (_packageRoot: string, verifierRoot: string) =>
        writeFileSync(join(verifierRoot, 'src/verify.js'), 'export {};\n'),
      diagnostic: 'DEVAI_VERIFIER_PACKAGE_FILE_DIGEST_INVALID',
    },
    {
      name: 'binary map drift',
      mutate: (packageRoot: string) => {
        const manifestPath = join(packageRoot, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          bin: Record<string, string>;
        };
        manifest.bin['devai-evidence-verify'] = './dist/runtime/evidence-verification/src/extra.js';
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      },
      diagnostic: 'DEVAI_VERIFIER_PACKAGE_BIN_INVALID',
    },
    {
      name: 'a verifier symlink archive entry',
      mutate: (_packageRoot: string, verifierRoot: string) =>
        symlinkSync('verify.js', join(verifierRoot, 'src/linked.js')),
      diagnostic: 'DEVAI_VERIFIER_ARCHIVE_SYMLINK_INVALID',
    },
    {
      name: 'a verifier hardlink archive entry',
      mutate: (_packageRoot: string, verifierRoot: string) =>
        linkSync(join(verifierRoot, 'src/verify.js'), join(verifierRoot, 'src/linked.js')),
      diagnostic: 'DEVAI_VERIFIER_ARCHIVE_HARDLINK_INVALID',
    },
    {
      name: 'a verifier special-file archive entry',
      mutate: (_packageRoot: string, verifierRoot: string) =>
        execFileSync('mkfifo', [join(verifierRoot, 'src/special')]),
      diagnostic: 'DEVAI_VERIFIER_ARCHIVE_SPECIAL_FILE_INVALID',
    },
  ])('rejects $name in the executable package materializer', ({ mutate, diagnostic }) => {
    const materialization = executablePackageMaterializationFixture(
      ledgerVerificationWorkflow(),
      mutate,
    );
    const result = spawnSync('bash', ['-c', materialization.script], {
      cwd: materialization.root,
      encoding: 'utf8',
      env: materialization.env,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(diagnostic);
    expect(readFileSync(materialization.githubOutput, 'utf8')).toBe('');
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
      name: 'privileged pull-request-target workflow',
      mutate: (source: string) => source.replace('pull_request:', 'pull_request_target:'),
      diagnostic: 'CI_WORKFLOW_TRUST_BOUNDARY_INVALID',
    },
    {
      name: 'protected environment on untrusted preflight',
      mutate: (source: string) =>
        source.replace(
          '    name: Validate candidate verifier without protected inputs\n',
          `    name: Validate candidate verifier without protected inputs\n    environment: ${LEDGER_ENVIRONMENT}\n`,
        ),
      diagnostic: 'CI_UNTRUSTED_PREFLIGHT_PRIVILEGED',
    },
    {
      name: 'protected variable on untrusted preflight',
      mutate: (source: string) =>
        source.replace(
          '    name: Validate candidate verifier without protected inputs\n',
          '    name: Validate candidate verifier without protected inputs\n    env:\n      PROTECTED: ${{ vars.PROTECTED }}\n',
        ),
      diagnostic: 'CI_UNTRUSTED_PREFLIGHT_PRIVILEGED',
    },
    {
      name: 'protected verification pull-request guard removed',
      mutate: (source: string) =>
        source.replace("    if: ${{ github.event_name != 'pull_request' }}\n", ''),
      diagnostic: 'CI_LEDGER_TRUSTED_EVENT_GUARD_MISSING',
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
        source.replaceAll(
          'test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"',
          'test -n "$actual_provenance_sha256"',
        ),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'unsafe verifier package subtree accepted',
      mutate: (source: string) =>
        source.replaceAll('DEVAI_VERIFIER_PACKAGE_SPECIAL_FILE_INVALID', 'special-file-ignored'),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'verifier package population is not checked',
      mutate: (source: string) =>
        source.replaceAll('DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID', 'population-ignored'),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'verifier runtime population copy is bypassed',
      mutate: (source: string) =>
        source.replaceAll(
          'cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"',
          'cp -R "$source_root/test" "$verifier_root/"',
        ),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'wrong package-owned verifier provenance',
      mutate: (source: string) => source.replaceAll(VERIFIER_SOURCE_COMMIT, 'a'.repeat(40)),
      diagnostic: 'CI_VERIFIER_PACKAGE_BINDING_MISSING',
    },
    {
      name: 'obsolete verifier repository identity',
      mutate: (source: string) => source.replaceAll(VERIFIER_PACKAGE, 'devai-nyx/devai-verifier'),
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
    const result = check(fixture(mutate(CHECKED_IN_LEDGER)));
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

  it('keeps tag pushes rehearsal-only and publication explicit, ledger-bound, and coverage-free', () => {
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
    const parsed = parse(release) as {
      jobs?: Record<string, { if?: string }>;
    };
    expect(parsed.jobs?.['finalize-release']?.if).toBe(EXPLICIT_PUBLISH_CONDITION);
    expect(parsed.jobs?.['deploy-pages']?.if).toBe(EXPLICIT_PUBLISH_CONDITION);
    expect(parsed.jobs?.['rehearsal-summary']?.if).toBe(REHEARSAL_CONDITION);
    expect(release).toContain('environment: devai-rc-publication');
    expect(release).toContain('EXPECTED_ACTION_COUNT: 48');
    expect(release).toContain('pnpm run release:closure');
    expect(release).toContain('--binding exact-tree');
    expect(release).toContain('sbom_subject_sha256');
    expect(release).toContain('Verify npm adopter quickstart on Linux');
    expect(release).toContain("task.disposition === 'reused'");
    expect(release).not.toContain('--package-lock-only');
    expect(release).toContain('--tag "$PACKAGE_DIST_TAG"');
    expect(release).toContain('if test "$RELEASE_IS_PRERELEASE" = true');
    expect(release).toContain('dist-tags.$PACKAGE_DIST_TAG');
    expect(release).not.toContain('npm publish "$source_tgz" --tag next');
    expect(release).not.toContain('test:coverage');
    expect(release).toContain('for attempt in {1..12}');
    expect(release).toContain('grep -Fq "$expected"');
    expect(release).toContain('?release=${RELEASE_TAG#v}&attempt=$attempt');
    expect(discipline).toContain(
      'A signed annotated version-tag push is a non-publishing rehearsal trigger.',
    );
    expect(discipline).toContain(
      'Only an explicit `workflow_dispatch` with `publish: true` may finalize',
    );
  });

  it('accepts only explicit dispatch publication and push-or-false-dispatch rehearsal guards', () => {
    const current = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
    const intended = current
      .replaceAll(PERMISSIVE_PUSH_PUBLICATION_CONDITION, EXPLICIT_PUBLISH_CONDITION)
      .replace(DISPATCH_ONLY_REHEARSAL_CONDITION, REHEARSAL_CONDITION);
    const accepted = check(fixture(intended, 'release.yml'));
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toBe('workflow contract: PASS\n');

    const pushCanPublish = intended.replaceAll(
      EXPLICIT_PUBLISH_CONDITION,
      PERMISSIVE_PUSH_PUBLICATION_CONDITION,
    );
    const permissive = check(fixture(pushCanPublish, 'release.yml'));
    expect(permissive.status).toBe(1);
    expect(permissive.stderr).toContain('RELEASE_REHEARSAL_PUBLICATION_GUARD_MISSING');

    const dispatchOnlyRehearsal = intended.replace(
      REHEARSAL_CONDITION,
      DISPATCH_ONLY_REHEARSAL_CONDITION,
    );
    const incompleteRehearsal = check(fixture(dispatchOnlyRehearsal, 'release.yml'));
    expect(incompleteRehearsal.status).toBe(1);
    expect(incompleteRehearsal.stderr).toContain('RELEASE_REHEARSAL_JOB_INVALID');
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
      mutate: (source: string) => source.replace('sbom_subject_sha256', '--package-lock-only'),
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
        source.replace('EXPECTED_ACTION_COUNT: 48', 'EXPECTED_ACTION_COUNT: 41'),
      diagnostic: 'RELEASE_IDENTITY_INVALID',
    },
    {
      name: 'non-version trigger',
      mutate: (source: string) => source.replace("tags: ['v*']", 'tags: [release-*]'),
      diagnostic: 'RELEASE_TRIGGER_INVALID',
    },
    {
      name: 'rehearsal publication guard removal',
      mutate: (source: string) => source.replace(`    if: ${EXPLICIT_PUBLISH_CONDITION}\n`, ''),
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
    expect(economy.workflows_scanned).toBe(3);
    expect(
      economy.findings.find((finding) => finding.ruleId === 'ci-economy.evidence-gate-wired'),
    ).toMatchObject({ severity: 'pass' });
    expect(
      economy.findings.some((finding) => finding.ruleId === 'ci-economy.scheduled-audit'),
    ).toBe(false);
  });
});

describe('remote preflight workflow', () => {
  it('accepts the checked-in three-workflow set', () => {
    const result = check(fixture(CHECKED_IN_PREFLIGHT, PREFLIGHT_WORKFLOW_FILE));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('workflow contract: PASS\n');
  });

  it('keeps the preflight lane optional', () => {
    const result = check(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('workflow contract: PASS\n');
  });

  it('still rejects any other additional workflow file', () => {
    const root = fixture(CHECKED_IN_PREFLIGHT, PREFLIGHT_WORKFLOW_FILE);
    writeFileSync(join(root, '.github/workflows/nightly.yml'), 'name: nightly\non: schedule\n');
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CI_WORKFLOW_SET_INVALID');
    expect(result.stderr).toContain('CI_WORKFLOW_UNRECOGNIZED');
  });

  it('binds the lane to the cheap local closure and to no protected input', () => {
    expect(CHECKED_IN_PREFLIGHT).toContain('pnpm run lint');
    expect(CHECKED_IN_PREFLIGHT).toContain('pnpm run typecheck');
    expect(CHECKED_IN_PREFLIGHT).toContain('name: devai-release-gate');
    expect(CHECKED_IN_PREFLIGHT).toContain('pnpm run format:check');
    expect(CHECKED_IN_PREFLIGHT).toContain('pnpm run release:static-integrity');
    expect(CHECKED_IN_PREFLIGHT).toContain('pnpm run release:pr-gate');
    expect(CHECKED_IN_PREFLIGHT).toContain(`actions/checkout@${CHECKOUT_COMMIT}`);
    expect(CHECKED_IN_PREFLIGHT).toContain(`actions/setup-node@${SETUP_NODE_COMMIT}`);
    expect(CHECKED_IN_PREFLIGHT).toContain('persist-credentials: false');
    expect(CHECKED_IN_PREFLIGHT).not.toMatch(/:rc\b/u);
    expect(CHECKED_IN_PREFLIGHT).not.toContain('secrets.');
    expect(CHECKED_IN_PREFLIGHT).not.toContain('environment:');
    expect(CHECKED_IN_PREFLIGHT).not.toContain(LEDGER_ENVIRONMENT);
    expect(CHECKED_IN_PREFLIGHT).not.toContain('upload-artifact');

    const workflow = parse(CHECKED_IN_PREFLIGHT) as {
      on?: Record<string, unknown>;
      permissions?: Record<string, unknown>;
      concurrency?: Record<string, unknown>;
    };
    expect(Object.keys(workflow.on ?? {})).toEqual(['pull_request']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(true);
  });

  it('records the amended invariant beside the workflow it permits', () => {
    const contract = readFileSync(
      join(ROOT, 'docs/dev/operations/remote-preflight-contract.md'),
      'utf8',
    );
    const economy = readFileSync(join(ROOT, 'docs/adopters/ci-economy.md'), 'utf8');
    expect(contract).toContain('Remote CI does not execute the attested RC closure');
    expect(contract).toContain(PREFLIGHT_WORKFLOW_FILE);
    expect(economy).toContain('Remote CI does not rerun the attested RC closure');
    expect(economy).not.toContain('Remote CI does not rerun product tests.');
  });

  it.each([
    {
      name: 'a trigger that reaches a protected ref',
      mutate: (source: string) =>
        source.replace('on:\n  pull_request:', 'on:\n  push:\n  pull_request:'),
      diagnostic: 'CI_PREFLIGHT_TRIGGER_INVALID',
    },
    {
      name: 'a declared job environment',
      mutate: (source: string) =>
        source.replace(
          '    timeout-minutes: 20',
          `    timeout-minutes: 20\n    environment: ${LEDGER_ENVIRONMENT}`,
        ),
      diagnostic: 'CI_PREFLIGHT_ENVIRONMENT_FORBIDDEN',
    },
    {
      name: 'any secret reference',
      mutate: (source: string) =>
        source.replace(
          '          node-version: 24',
          '          node-version: 24\n          token: ${{ secrets.PACKAGES_READ_TOKEN }}',
        ),
      diagnostic: 'CI_PREFLIGHT_SECRET_ACCESS_FORBIDDEN',
    },
    {
      name: 'remote execution of the attested RC closure',
      mutate: (source: string) =>
        source.replace(
          'run: pnpm run release:pr-gate -- ${{ github.event.pull_request.base.sha }}',
          'run: pnpm run test:coverage:rc',
        ),
      diagnostic: 'CI_PREFLIGHT_ATTESTED_CLOSURE_FORBIDDEN',
    },
    {
      name: 'a script outside the cheap local closure',
      mutate: (source: string) =>
        source.replace('run: pnpm run lint', 'run: pnpm publish --no-git-checks'),
      diagnostic: 'CI_PREFLIGHT_SCRIPT_NOT_ALLOWED',
    },
    {
      name: 'an artifact upload',
      mutate: (source: string) =>
        source.replace(
          '      - name: Build',
          '      - name: Save\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n\n      - name: Build',
        ),
      diagnostic: 'CI_PREFLIGHT_ARTIFACT_FORBIDDEN',
    },
    {
      name: 'a mutable action reference',
      mutate: (source: string) =>
        source.replace(`actions/setup-node@${SETUP_NODE_COMMIT}`, 'actions/setup-node@v7'),
      diagnostic: 'CI_ACTION_REFERENCE_MUTABLE',
    },
    {
      name: 'persisted checkout credentials',
      mutate: (source: string) => source.replace('          persist-credentials: false\n', ''),
      diagnostic: 'CI_PREFLIGHT_CREDENTIALS_PERSISTED',
    },
    {
      name: 'superseded runs left uncancelled',
      mutate: (source: string) =>
        source.replace('  cancel-in-progress: true', '  cancel-in-progress: false'),
      diagnostic: 'CI_PREFLIGHT_CONCURRENCY_INVALID',
    },
    {
      name: 'a step on the evidence path',
      mutate: (source: string) =>
        source.replace('run: pnpm run typecheck', 'run: node ./export-receipt.mjs --attest'),
      diagnostic: 'CI_PREFLIGHT_NON_ATTESTING_VIOLATION',
    },
    {
      name: 'a billed macOS runner',
      mutate: (source: string) => source.replace('runs-on: ubuntu-latest', 'runs-on: macos-14'),
      diagnostic: 'CI_PREFLIGHT_RUNNER_INVALID',
    },
  ])('rejects $name', ({ mutate, diagnostic }) => {
    const result = check(fixture(mutate(CHECKED_IN_PREFLIGHT), PREFLIGHT_WORKFLOW_FILE));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(diagnostic);
  });
});

describe('ci-economy concurrency-cancel rule', () => {
  function economyFixture(cancelInProgress: string | null): string {
    const root = mkdtempSync(join(tmpdir(), 'devai-ci-economy-'));
    roots.push(root);
    const directory = join(root, '.github/workflows');
    mkdirSync(directory, { recursive: true });
    const concurrency =
      cancelInProgress === null
        ? ''
        : `concurrency:\n  group: pr-\${{ github.ref }}\n  cancel-in-progress: ${cancelInProgress}\n`;
    writeFileSync(
      join(directory, 'pr.yml'),
      `name: pr\non:\n  pull_request:\n  push:\n    branches: [main]\n${concurrency}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`,
    );
    return root;
  }

  function concurrencyFinding(root: string) {
    const report = checkCiEconomy({ repoRoot: root });
    const finding = report.findings.find((f) => f.ruleId === 'ci-economy.concurrency-cancel');
    expect(finding).toBeDefined();
    return finding;
  }

  it.each([
    { name: 'a literal true', value: 'true' },
    {
      name: 'a pull_request event expression',
      value: "${{ github.event_name == 'pull_request' }}",
    },
    {
      name: 'a pull_request_target event expression',
      value: "${{ github.event_name == 'pull_request_target' }}",
    },
    {
      name: 'a double-quoted event expression',
      value: '${{ github.event_name == "pull_request" }}',
    },
  ])('accepts $name', ({ value }) => {
    expect(concurrencyFinding(economyFixture(value))).toMatchObject({ severity: 'pass' });
  });

  it.each([
    { name: 'cancellation disabled outright', value: 'false' },
    {
      name: 'an expression that never cancels a pull request',
      value: "${{ github.event_name == 'push' }}",
    },
    { name: 'no concurrency block at all', value: null },
  ])('rejects $name', ({ value }) => {
    expect(concurrencyFinding(economyFixture(value))).toMatchObject({
      severity: 'fail',
      locations: ['pr.yml'],
    });
  });

  it('leaves workflows without a pull-request trigger alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-ci-economy-'));
    roots.push(root);
    const directory = join(root, '.github/workflows');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'tag.yml'),
      "name: tag\non:\n  push:\n    tags: ['v*']\nconcurrency:\n  group: release\n  cancel-in-progress: false\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
    );
    expect(concurrencyFinding(root)).toMatchObject({ severity: 'pass' });
  });

  /**
   * The regression guard this rule never had. Rule 1 failed against this
   * repository from the day the expression allowlist was introduced, because no
   * test asserted the rule's own verdict for the checked-in workflow tree.
   */
  it('passes against this repository, with only advisory findings left', () => {
    const report = checkCiEconomy({ repoRoot: ROOT });
    expect(report.findings.filter((f) => f.severity === 'fail')).toEqual([]);
    expect(report.fail_count).toBe(0);
    expect(report.verdict).not.toBe('fail');
    expect(report.findings.find((f) => f.ruleId === 'ci-economy.concurrency-cancel')).toMatchObject(
      { severity: 'pass' },
    );
  });
});
