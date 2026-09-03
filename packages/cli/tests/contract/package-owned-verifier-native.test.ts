import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VERIFIER_ROOT = resolve(import.meta.dirname, '../../vendor/evidence-verification');
const VERIFIER_TEST_ROOT = join(VERIFIER_ROOT, 'test');
const EXPECTED_PROVENANCE = {
  sourceCommit: '098d090013dda34e38d1045ba06274d99bd5aec1',
  manifestDigest: '5319ef6154ca90b0851cc2b7fbce4e16919c9f4b5326a67a452e1c52ffb7027b',
  filePopulationDigest: 'dcb9af5f43f396e4a2a1a09fcdb181ade346575cd111dd532b78269e3fdfc34e',
  runtimeFileCount: 24,
} as const;
const UPSTREAM_TEST_DIGESTS = new Map([
  ['artifact-safety.test.js', 'fd69eb952a381d6e18fcc9de581505ddff7d9f82f9d86c5a8a5e0d9fbaad9a09'],
  ['export.test.js', '1e9519152f254a35e24387398ce1eadf0714233e508d7d4d45d3503c18f3fd95'],
  [
    'mutation-v21-contract.test.js',
    '20569712e944c8b5366b3b52d279addde8862292d1ae9ee8f2875af3e2cdc3a1',
  ],
  ['mutation.test.js', '9a5815d17a17f7e606aaca0f088b23d7bb900e5b171d875cf9903670142dd661'],
  ['policy-builder.test.js', '2f2f1c3cc25edbf21593b692e5d6ff9efceabd6cfe1da9d7ed27ec2cf9403a1e'],
  ['publish.test.js', 'fa32181e7690efc6443080db9c5dd1f5a0d3f9fc6102859d4c99680f7c764666'],
  ['verifier.test.js', 'cf0afb76437f28665ce3bf7080114da03ad04e22b3632c3f5f7dab238bdd79e4'],
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

  it('executes all 105 vendored node:test cases against the packaged implementation', () => {
    const files = readdirSync(VERIFIER_TEST_ROOT)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => join(VERIFIER_TEST_ROOT, name));

    expect(files).toHaveLength(7);
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      cwd: VERIFIER_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(result.signal, output).toBeNull();
    expect(output).toMatch(/# tests 105(?:\r?\n|$)/u);
    expect(output).toMatch(/# pass 105(?:\r?\n|$)/u);
    expect(output).toMatch(/# fail 0(?:\r?\n|$)/u);
  }, 130_000);
});
