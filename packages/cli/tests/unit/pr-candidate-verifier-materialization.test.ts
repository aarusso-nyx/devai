// ADR-REL-0031: PR lanes validate the candidate vendor; protected release lanes keep the published pin.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../../../..');
const VENDOR = join(ROOT, 'packages/cli/vendor/evidence-verification');
const CANDIDATE_VERIFIER_COMMIT = 'ad790aea6f200412da79a3a1bfbaa03cbdb47a2d';
const PRIOR_TRUSTED_VERIFIER_COMMIT = '8b215d706a828af7361f9c6799b9cb0a30c9d00b';
const workflow = parse(
  readFileSync(join(ROOT, '.github/workflows/pull-request-checks.yml'), 'utf8'),
) as {
  jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-pr-candidate-verifier-'));
  roots.push(root);
  const packageRoot = join(root, 'package');
  const verifierRoot = join(root, 'verifier');
  mkdirSync(packageRoot);
  mkdirSync(verifierRoot);
  cpSync(join(ROOT, 'packages/cli/package.json'), join(packageRoot, 'package.json'));
  for (const path of ['schemas', 'src', 'provenance.json']) {
    cpSync(join(VENDOR, path), join(verifierRoot, path), { recursive: true });
  }
  const provenance = JSON.parse(readFileSync(join(verifierRoot, 'provenance.json'), 'utf8')) as {
    sourceCommit: string;
    files: Array<{ path: string; sha256: string }>;
  };
  expect(provenance.sourceCommit).toBe(CANDIDATE_VERIFIER_COMMIT);
  expect(provenance.files).toHaveLength(26);
  return { packageRoot, verifierRoot, provenance };
}

function validate(lane: string, packageRoot: string, verifierRoot: string) {
  const step = workflow.jobs[lane]?.steps.find((candidate) => candidate.id === 'preflight');
  const blocks = [
    ...(step?.run ?? '').matchAll(
      /node - "\$package_root" "\$verifier_root" <<'NODE'\n([\s\S]*?)\nNODE/gu,
    ),
  ];
  expect(blocks, `${lane} has one actual embedded verifier validation block`).toHaveLength(1);
  const block = blocks[0]?.[1];
  if (block === undefined) throw new Error(`missing verifier validation in ${lane}`);
  return spawnSync(process.execPath, ['-', packageRoot, verifierRoot], {
    input: block,
    encoding: 'utf8',
  });
}

describe.each(['gate-cli', 'gate-rest'])('PR candidate verifier materialization: %s', (lane) => {
  it('accepts the exact current candidate vendor population', () => {
    const { packageRoot, verifierRoot } = fixture();
    const result = validate(lane, packageRoot, verifierRoot);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('refuses the prior trusted commit when presented as candidate provenance', () => {
    const { packageRoot, verifierRoot, provenance } = fixture();
    writeFileSync(
      join(verifierRoot, 'provenance.json'),
      JSON.stringify({
        ...provenance,
        sourceCommit: PRIOR_TRUSTED_VERIFIER_COMMIT,
      }),
    );
    const result = validate(lane, packageRoot, verifierRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEVAI_VERIFIER_PACKAGE_PROVENANCE_INVALID');
  });

  it('refuses a missing declared runtime file', () => {
    const { packageRoot, verifierRoot, provenance } = fixture();
    const file = provenance.files[0]?.path;
    if (file === undefined) throw new Error('empty vendor fixture');
    rmSync(join(verifierRoot, file));
    const result = validate(lane, packageRoot, verifierRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID');
  });

  it('refuses changed bytes inside the exact declared population', () => {
    const { packageRoot, verifierRoot, provenance } = fixture();
    const file = provenance.files[0]?.path;
    if (file === undefined) throw new Error('empty vendor fixture');
    writeFileSync(join(verifierRoot, file), '\n', { flag: 'a' });
    const result = validate(lane, packageRoot, verifierRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('DEVAI_VERIFIER_PACKAGE_FILE_DIGEST_INVALID:');
  });
});
