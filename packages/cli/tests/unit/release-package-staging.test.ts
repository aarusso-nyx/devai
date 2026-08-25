import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const output = mkdtempSync(join(tmpdir(), 'devai-release-stage-test-'));
const SELECTED_RELEASE_VERSION = '1.2.13';
const TRUSTED_VERIFIER_PACKAGE_VERSION = '1.2.12';

afterAll(() => rmSync(output, { recursive: true, force: true }));

describe('normalized release package staging', () => {
  it('requires two byte-identical packs and excludes private workspace packages', () => {
    const staged = JSON.parse(
      execFileSync(
        process.execPath,
        [join(root, 'scripts/stage-release-package.mjs'), '--output', output],
        { cwd: root, encoding: 'utf8' },
      ),
    ) as {
      tarball: string;
      sha256: string;
      sbom: string;
      sbom_subject_sha256: string;
      reproductions: number;
      version: string;
    };
    expect(staged.reproductions).toBe(2);
    expect(staged.version).toBe(SELECTED_RELEASE_VERSION);
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(staged.sbom_subject_sha256).toBe(staged.sha256);
    const sbom = JSON.parse(readFileSync(staged.sbom, 'utf8')) as {
      metadata: { component: { hashes: Array<{ alg: string; content: string }> } };
    };
    expect(staged.sbom).toMatch(
      new RegExp(`devai-${SELECTED_RELEASE_VERSION.replaceAll('.', '\\.')}\\.cdx\\.json$`, 'u'),
    );
    expect(sbom.metadata.component.hashes).toContainEqual({
      alg: 'SHA-256',
      content: staged.sha256,
    });
    expect(JSON.stringify(sbom)).not.toContain('@devai-nyx/');
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', staged.tarball, 'package/package.json'], {
        encoding: 'utf8',
      }),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: '@aarusso-nyx/devai',
      version: SELECTED_RELEASE_VERSION,
    });
    expect(manifest).not.toHaveProperty('devDependencies');
    expect(JSON.stringify(manifest)).not.toMatch(/workspace:|@devai-nyx\//u);
    const packagePopulation = execFileSync('tar', ['-tzf', staged.tarball], {
      encoding: 'utf8',
    });
    expect(packagePopulation).toContain('package/dist/runtime/evidence-verification/src/cli.js');
    expect(packagePopulation).not.toContain('package/dist/runtime/evidence-verification/test/');
  }, 60_000);

  it('keeps the published landing page bound to the package version', () => {
    const packageVersion = (
      JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const landingPage = readFileSync(join(root, 'docs/site/src/pages/index.tsx'), 'utf8');
    expect(packageVersion).toBe(SELECTED_RELEASE_VERSION);
    expect(landingPage).toContain(`@aarusso-nyx/devai@${SELECTED_RELEASE_VERSION}`);
  });

  it('records a stable release and latest dist-tag for version 1.2.13', () => {
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
        RELEASE_TAG: `v${SELECTED_RELEASE_VERSION}`,
        PACKAGE_TARBALL: packageTarball,
        SITE_ARCHIVE: siteArchive,
        SBOM_FILE: sbom,
        OUTPUT_FILE: manifest,
        COMMIT_SHA: 'b'.repeat(40),
        TREE_SHA: 'c'.repeat(40),
        LEDGER_VERIFIER_PACKAGE_VERSION: TRUSTED_VERIFIER_PACKAGE_VERSION,
        LEDGER_VERIFIER_PROVENANCE_SHA256: digest,
        LEDGER_POLICY_DIGEST: digest,
        LEDGER_ENVELOPE_SHA256: digest,
        LEDGER_RESULTS_SHA256: digest,
        LEDGER_ARTIFACTS_SHA256: digest,
        LEDGER_TASK_POLICY_SHA256: digest,
        LEDGER_TRUST_STORE_SHA256: digest,
        LEDGER_TOOLCHAIN_SHA256: digest,
        LEDGER_ENVIRONMENT_SHA256: digest,
        LEDGER_RELEASE_SIGNERS_SHA256: digest,
      },
    });
    const value = JSON.parse(readFileSync(manifest, 'utf8')) as {
      release: Record<string, unknown>;
      ledger: Record<string, unknown>;
    };
    expect(value.release).toMatchObject({
      tag: `v${SELECTED_RELEASE_VERSION}`,
      version: SELECTED_RELEASE_VERSION,
      release_type: 'stable',
      prerelease: false,
      dist_tag: 'latest',
    });
    expect(value.ledger).toMatchObject({
      verifier_package: '@aarusso-nyx/devai',
      verifier_package_version: TRUSTED_VERIFIER_PACKAGE_VERSION,
      verifier_provenance_sha256: digest,
      verifier_source_commit: '9e115014f8da5a16be526c7da5207bc0aae0801b',
    });
  });

  it('keeps release closure bound to the selected public package version', () => {
    const closure = JSON.parse(
      execFileSync(process.execPath, [join(root, 'scripts/check-publishable-closure.mjs')], {
        cwd: root,
        encoding: 'utf8',
      }),
    ) as { package: string };
    expect(closure.package).toBe(`@aarusso-nyx/devai@${SELECTED_RELEASE_VERSION}`);
  });
});
