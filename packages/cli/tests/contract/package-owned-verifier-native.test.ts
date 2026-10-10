import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The package-owned verifier intentionally ships native ESM without declarations.
import { canonicalize } from '../../vendor/evidence-verification/src/canonical.js';
// @ts-expect-error The package-owned verifier intentionally ships native ESM without declarations.
import { verifyPreparedBundle } from '../../vendor/evidence-verification/src/publish.js';

const VERIFIER_ROOT = resolve(import.meta.dirname, '../../vendor/evidence-verification');
const VERIFIER_TEST_ROOT = join(VERIFIER_ROOT, 'test');
const EXPECTED_PROVENANCE = {
  sourceCommit: 'ad790aea6f200412da79a3a1bfbaa03cbdb47a2d',
  manifestDigest: 'fc79da07d4d4dfa466548337a4944ae1b7e0bfdcf2f1c334b341bb1ad477cd4d',
  filePopulationDigest: '9fabc74bec014c4d8690984194d6ca5871490ed6ae1c244c90e17ba854ed482f',
  runtimeFileCount: 26,
} as const;
const UPSTREAM_TEST_DIGESTS = new Map([
  ['artifact-safety.test.js', 'fd69eb952a381d6e18fcc9de581505ddff7d9f82f9d86c5a8a5e0d9fbaad9a09'],
  ['detached-trust.test.js', '0233d302a5f796c539bf300a88325569e3c6a3638e906cb00dca67e061c8b4ba'],
  ['export.test.js', '82ef4d8233521c66fcff1c40917dc13891d65d8ec432a79a4dc5ca0c86464803'],
  [
    'mutation-v21-contract.test.js',
    '20569712e944c8b5366b3b52d279addde8862292d1ae9ee8f2875af3e2cdc3a1',
  ],
  [
    'mutation-v22-contract.test.js',
    '9496d28bfffa1731fc4fc92a02255b64e13174d3cba999e6e5e47c7a95078065',
  ],
  ['mutation.test.js', '9a5815d17a17f7e606aaca0f088b23d7bb900e5b171d875cf9903670142dd661'],
  ['policy-builder.test.js', '82857d592d0c3160e2ad44178d866da3ee40ccd9a3ad341cedebb2c4f6d9dc73'],
  ['publish.test.js', '74a4472721b84efef62ea3ce5e28eca6f5d706323bb4d488c42d96ade6cdf70c'],
  ['verifier.test.js', '0bffed225e86fdf59900b8c86eafa685af06b2fd17ceff56eac2133792613ed1'],
]);

describe('package-owned evidence verifier native suite', () => {
  it('keeps upstream tests byte-identical and outside the runtime provenance population', () => {
    const provenanceBytes = readFileSync(join(VERIFIER_ROOT, 'provenance.json'));
    const provenance = JSON.parse(provenanceBytes.toString('utf8')) as {
      sourceCommit: string;
      files: Array<{ path: string }>;
    };
    const declared = provenance.files.map((entry) => entry.path);
    expect(provenance.sourceCommit).toBe(EXPECTED_PROVENANCE.sourceCommit);
    expect(provenance.files).toHaveLength(EXPECTED_PROVENANCE.runtimeFileCount);
    expect(createHash('sha256').update(provenanceBytes).digest('hex')).toBe(
      EXPECTED_PROVENANCE.manifestDigest,
    );
    expect(createHash('sha256').update(JSON.stringify(provenance.files)).digest('hex')).toBe(
      EXPECTED_PROVENANCE.filePopulationDigest,
    );
    expect(declared.every((path) => /^(?:schemas|src)\//u.test(path))).toBe(true);
    expect(declared.some((path) => path.startsWith('test/'))).toBe(false);

    const names = readdirSync(VERIFIER_TEST_ROOT)
      .filter((name) => name.endsWith('.test.js'))
      .sort();
    expect(names).toEqual([...UPSTREAM_TEST_DIGESTS.keys()].sort());
    for (const name of names) {
      const digest = createHash('sha256')
        .update(readFileSync(join(VERIFIER_TEST_ROOT, name)))
        .digest('hex');
      expect(digest, name).toBe(UPSTREAM_TEST_DIGESTS.get(name));
    }
  });

  it('executes all 169 vendored node:test cases against the packaged implementation', () => {
    const files = readdirSync(VERIFIER_TEST_ROOT)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => join(VERIFIER_TEST_ROOT, name));

    expect(files).toHaveLength(9);
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      cwd: VERIFIER_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(result.signal, output).toBeNull();
    expect(output).toMatch(/# tests 169(?:\r?\n|$)/u);
    expect(output).toMatch(/# pass 169(?:\r?\n|$)/u);
    expect(output).toMatch(/# fail 0(?:\r?\n|$)/u);
  }, 130_000);

  it('keeps a declared artifact mandatory during pre-tag bundle verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'devai-missing-declared-artifact-'));
    const resultDigest = 'a'.repeat(64);
    const artifactDigest = 'b'.repeat(64);
    const policyDigest = 'c'.repeat(64);
    const put = (path: string, value: unknown) => {
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, `${canonicalize(value)}\n`);
    };

    try {
      put(join(root, 'manifest.json'), {
        schemaVersion: '1.1.0',
        repositoryId: 'fixture/repository',
        commit: 'd'.repeat(40),
        tree: 'e'.repeat(40),
        profile: 'rc',
        signerId: 'fixture-signer',
        taskPolicyDigest: policyDigest,
        envelopeDigest: 'f'.repeat(64),
        resultDigests: [resultDigest],
        artifacts: [
          {
            path: 'declared.json',
            mediaType: 'application/json',
            sha256: artifactDigest,
          },
        ],
      });
      put(join(root, 'task-policy.json'), {
        schemaVersion: '1.1.0',
        repositoryId: 'fixture/repository',
        requiredNodes: [
          {
            nodeId: 'test:rc',
            taskKey: '1'.repeat(64),
            dependencies: [],
            outputContract: {
              kind: 'files',
              paths: ['declared.json'],
              requiredResult: 'pass',
            },
          },
        ],
      });
      put(join(root, 'envelope.json'), {});
      put(join(root, 'results', `${resultDigest}.json`), {});

      expect(() =>
        verifyPreparedBundle({
          bundleDir: root,
          trustStorePath: join(root, 'unused-trust.json'),
        }),
      ).toThrow(expect.objectContaining({ code: 'BUNDLE_POPULATION_MISMATCH' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
