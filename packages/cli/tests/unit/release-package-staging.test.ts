import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const output = mkdtempSync(join(tmpdir(), 'devai-release-stage-test-'));

afterAll(() => rmSync(output, { recursive: true, force: true }));

describe('normalized release package staging', () => {
  it('requires two byte-identical packs and excludes private workspace packages', () => {
    const staged = JSON.parse(
      execFileSync(
        process.execPath,
        [join(root, 'scripts/stage-release-package.mjs'), '--output', output],
        { cwd: root, encoding: 'utf8' },
      ),
    ) as { tarball: string; sha256: string; reproductions: number };
    expect(staged.reproductions).toBe(2);
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', staged.tarball, 'package/package.json'], {
        encoding: 'utf8',
      }),
    ) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('devDependencies');
    expect(JSON.stringify(manifest)).not.toMatch(/workspace:|@devai-nyx\//u);
  });
});
