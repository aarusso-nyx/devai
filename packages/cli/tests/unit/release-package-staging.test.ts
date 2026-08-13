import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('records an RC Release and next dist-tag for version 1.1.0-rc.7', () => {
    const packageTarball = join(output, 'package.tgz');
    const siteArchive = join(output, 'site.tar.gz');
    const sbom = join(output, 'sbom.json');
    const manifest = join(output, 'release-manifest.json');
    writeFileSync(packageTarball, 'package');
    writeFileSync(siteArchive, 'site');
    writeFileSync(sbom, '{}');
    const digest = 'a'.repeat(64);
    execFileSync(process.execPath, [join(root, 'scripts/create-release-manifest.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        PACKAGE_NAME: '@aarusso-nyx/devai',
        RELEASE_TAG: 'v1.1.0-rc.7',
        PACKAGE_TARBALL: packageTarball,
        SITE_ARCHIVE: siteArchive,
        SBOM_FILE: sbom,
        OUTPUT_FILE: manifest,
        COMMIT_SHA: 'b'.repeat(40),
        TREE_SHA: 'c'.repeat(40),
        VERIFIER_COMMIT: 'd'.repeat(40),
        LEDGER_POLICY_DIGEST: digest,
        LEDGER_ENVELOPE_SHA256: digest,
        LEDGER_RESULTS_SHA256: digest,
        LEDGER_TASK_POLICY_SHA256: digest,
        LEDGER_TRUST_STORE_SHA256: digest,
        LEDGER_TOOLCHAIN_SHA256: digest,
        LEDGER_ENVIRONMENT_SHA256: digest,
        LEDGER_RELEASE_SIGNERS_SHA256: digest,
      },
    });
    const value = JSON.parse(readFileSync(manifest, 'utf8')) as {
      release: Record<string, unknown>;
    };
    expect(value.release).toMatchObject({
      tag: 'v1.1.0-rc.7',
      version: '1.1.0-rc.7',
      release_type: 'prerelease',
      prerelease: true,
      dist_tag: 'next',
    });
  });
});
