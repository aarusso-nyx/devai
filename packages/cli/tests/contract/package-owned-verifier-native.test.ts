import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const VERIFIER_ROOT = resolve(import.meta.dirname, '../../vendor/evidence-verification');
const VERIFIER_TEST_ROOT = join(VERIFIER_ROOT, 'test');
const UPSTREAM_TEST_DIGESTS = new Map([
  ['artifact-safety.test.js', '9bfc6ca5111be89b9bcb29466d5337e5093a80b38e172242e880949ab864d7bb'],
  ['export.test.js', '56b197c54e569410c395ea5ca95be4e064631e8f0e572ee44534e8e0fcc98ad3'],
  ['mutation.test.js', '88968fe06bda5b5fbacc41097d273e58a1b8b6bdb213cd8f95e4c602c56e9fc1'],
  ['policy-builder.test.js', '502a8657a03650e0aa3b787526b05fc90c8d14c33e0610aeda5e180b0b12acd4'],
  ['publish.test.js', '9d6e6d5de5a1dc365a435fc9fbfb02f530bd708daea15fd3a880ec2d505e6db5'],
  ['verifier.test.js', 'ea5fd7da37bd4a06406913227ed556cfae73cf1b5d41befbbe42f301c63ceb1c'],
]);

describe('package-owned evidence verifier native suite', () => {
  it('keeps upstream tests byte-identical and outside the runtime provenance population', () => {
    const provenance = JSON.parse(
      readFileSync(join(VERIFIER_ROOT, 'provenance.json'), 'utf8'),
    ) as { files: Array<{ path: string }> };
    const declared = provenance.files.map((entry) => entry.path);
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

  it(
    'executes all 48 vendored node:test cases against the packaged implementation',
    () => {
      const files = readdirSync(VERIFIER_TEST_ROOT)
        .filter((name) => name.endsWith('.test.js'))
        .sort()
        .map((name) => join(VERIFIER_TEST_ROOT, name));

      expect(files).toHaveLength(6);
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
        cwd: VERIFIER_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(0);
      expect(result.signal, output).toBeNull();
      expect(output).toMatch(/# tests 48(?:\r?\n|$)/u);
      expect(output).toMatch(/# pass 48(?:\r?\n|$)/u);
      expect(output).toMatch(/# fail 0(?:\r?\n|$)/u);
    },
    130_000,
  );
});
