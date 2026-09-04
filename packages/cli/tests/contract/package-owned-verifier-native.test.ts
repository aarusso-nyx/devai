import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VERIFIER_ROOT = resolve(import.meta.dirname, '../../vendor/evidence-verification');
const VERIFIER_TEST_ROOT = join(VERIFIER_ROOT, 'test');
const EXPECTED_PROVENANCE = {
  sourceCommit: '9f849f117fe1e460b5e3c647515f5ccbe783cbfb',
  manifestDigest: 'f61cccd8a0c0c5e7020cc6055f254c1a5ab56388fc9fc220ea76b1f9dc9a196c',
  filePopulationDigest: '9ce3f981f51fb4fa5f628cd5d2249bf8146aa44017b06603b797589ebe6505d4',
  runtimeFileCount: 26,
} as const;
const UPSTREAM_TEST_DIGESTS = new Map([
  ['artifact-safety.test.js', 'fd69eb952a381d6e18fcc9de581505ddff7d9f82f9d86c5a8a5e0d9fbaad9a09'],
  ['detached-trust.test.js', '0233d302a5f796c539bf300a88325569e3c6a3638e906cb00dca67e061c8b4ba'],
  ['export.test.js', '1e9519152f254a35e24387398ce1eadf0714233e508d7d4d45d3503c18f3fd95'],
  [
    'mutation-v21-contract.test.js',
    '20569712e944c8b5366b3b52d279addde8862292d1ae9ee8f2875af3e2cdc3a1',
  ],
  [
    'mutation-v22-contract.test.js',
    '9496d28bfffa1731fc4fc92a02255b64e13174d3cba999e6e5e47c7a95078065',
  ],
  ['mutation.test.js', '9a5815d17a17f7e606aaca0f088b23d7bb900e5b171d875cf9903670142dd661'],
  ['policy-builder.test.js', '2f2f1c3cc25edbf21593b692e5d6ff9efceabd6cfe1da9d7ed27ec2cf9403a1e'],
  ['publish.test.js', 'fa32181e7690efc6443080db9c5dd1f5a0d3f9fc6102859d4c99680f7c764666'],
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

  it('executes all 129 vendored node:test cases against the packaged implementation', () => {
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
    expect(output).toMatch(/# tests 129(?:\r?\n|$)/u);
    expect(output).toMatch(/# pass 129(?:\r?\n|$)/u);
    expect(output).toMatch(/# fail 0(?:\r?\n|$)/u);
  }, 130_000);
});
