import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHelp } from '../../src/command-router.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveCliProvenance, resolveCliVersion } from '../../src/version.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CANDIDATE_RELEASE_VERSION = '1.5.5';
const PUBLISHED_RELEASE_VERSION = '1.5.4';
const TRUSTED_VERIFIER_PACKAGE_VERSION = '1.5.4';

describe('resolveCliVersion', () => {
  it('returns a semver-shaped string', () => {
    expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the selected candidate release version', () => {
    expect(resolveCliVersion()).toBe(CANDIDATE_RELEASE_VERSION);
  });

  it('keeps the root and public package manifests synchronized to the selected candidate release', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const published = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
      version: string;
    };

    expect({ root: root.version, public: published.version }).toEqual({
      root: CANDIDATE_RELEASE_VERSION,
      public: CANDIDATE_RELEASE_VERSION,
    });
  });

  it('exposes the selected candidate release through generated CLI help', () => {
    expect(renderHelp(canonicalRegistry(), resolveCliVersion())).toContain(
      `devai/${CANDIDATE_RELEASE_VERSION}`,
    );
  });

  it('keeps current consumer documentation on the published exact release without mutable installs', () => {
    // The published site's landing page is bound to the staged package version by
    // release-package-staging.test.ts, so it names the candidate rather than the
    // published release. Only the documents carrying install commands belong here.
    const documents = ['README.md', 'docs/adopters/install.md', 'docs/index.md'].map((path) => ({
      path,
      content: readFileSync(join(ROOT, path), 'utf8'),
    }));

    for (const { path, content } of documents) {
      expect.soft(content, path).toContain(PUBLISHED_RELEASE_VERSION);
    }
    const installCommands = documents
      .flatMap(({ content }) => content.split('\n'))
      .filter((line) => line.includes('pnpm add') && line.includes('@aarusso-nyx/devai@'));
    expect(installCommands.length).toBeGreaterThan(0);
    expect(installCommands.every((line) => line.includes(`@${PUBLISHED_RELEASE_VERSION}`))).toBe(
      true,
    );
    expect(installCommands.join('\n')).not.toMatch(/@(?:latest|next)|@[~^*]|@[<>]=?/u);
  });

  it('binds the exact released verifier package identity', () => {
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'law/policy/trusted-local-rc-verifier-package.json'), 'utf8'),
    ) as {
      package: {
        version: string;
        tarball: string;
        shasum_sha1: string;
        integrity_sri: string;
        release_source: { commit: string; tree: string };
      };
      verifier: { provenance_sha256: string; source_commit: string };
    };
    expect(policy.package.version).toBe(TRUSTED_VERIFIER_PACKAGE_VERSION);
    expect(policy.package).toMatchObject({
      tarball:
        'https://npm.pkg.github.com/download/@aarusso-nyx/devai/1.5.4/e5c34a17bc27b47cc1dba711561e4f9c6394cac8',
      shasum_sha1: 'e5c34a17bc27b47cc1dba711561e4f9c6394cac8',
      integrity_sri:
        'sha512-neGgDPkoCiaex2f6GzSVrZsCIxaQhml6D0EC+bpHb2bgSDb4nm78Evx+Lo49VmH81gTwSI1WQFWb48PWj0/arQ==',
      release_source: {
        commit: '8b600ed16ebd101ff88ecfaac9cc04abcf0ce174',
        tree: 'd2f60e0602ffc849e9b5b1b52ca54731eca7c8b1',
      },
    });
    expect(policy.verifier).toMatchObject({
      provenance_sha256: '1035c8aad52f4b2beb6a6f010106a4d1866c92dadf3fbae1c6e36e1a4d2ceddf',
      source_commit: '8174749ebcfabab246031281a036032f636b8a39',
    });
    const currentReleaseNotes = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
      .split(`## ${CANDIDATE_RELEASE_VERSION}`)[1]
      ?.split('\n## ')[0];
    expect(currentReleaseNotes).toContain(`@aarusso-nyx/devai@${TRUSTED_VERIFIER_PACKAGE_VERSION}`);
    expect(
      readFileSync(join(ROOT, 'docs/dev/operations/adopter-package-contract.md'), 'utf8'),
    ).toContain(`@aarusso-nyx/devai@${TRUSTED_VERIFIER_PACKAGE_VERSION}`);
  });

  it('binds the candidate verifier bytes to the exact trusted 1.5.4 provider policy', () => {
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'law/policy/trusted-local-rc-verifier-package.json'), 'utf8'),
    ) as {
      package: {
        version: string;
        release_source: { commit: string; tree: string };
      };
      verifier: {
        provenance_sha256: string;
        source_commit: string;
        payload_file_count: number;
      };
    };
    expect(policy.package.release_source).toEqual({
      repository: 'aarusso-nyx/devai',
      commit: '8b600ed16ebd101ff88ecfaac9cc04abcf0ce174',
      tree: 'd2f60e0602ffc849e9b5b1b52ca54731eca7c8b1',
    });
    const provenanceBytes = readFileSync(
      join(ROOT, 'packages/cli/vendor/evidence-verification/provenance.json'),
    );
    const provenance = JSON.parse(provenanceBytes.toString('utf8')) as {
      schemaVersion: string;
      sourceCommit: string;
      files: unknown[];
    };
    const candidateProvenanceSha256 = createHash('sha256').update(provenanceBytes).digest('hex');
    expect(candidateProvenanceSha256).toBe(
      '1035c8aad52f4b2beb6a6f010106a4d1866c92dadf3fbae1c6e36e1a4d2ceddf',
    );
    expect(provenance).toMatchObject({
      schemaVersion: '1.0.0',
      sourceCommit: '8174749ebcfabab246031281a036032f636b8a39',
    });
    expect(provenance.files).toHaveLength(policy.verifier.payload_file_count);
    expect(candidateProvenanceSha256).toBe(policy.verifier.provenance_sha256);
    expect(provenance.sourceCommit).toBe(policy.verifier.source_commit);
  });
});

describe('resolveCliProvenance', () => {
  it('reports the supported package consumption mode', () => {
    const provenance = resolveCliProvenance();
    expect(provenance.source).toBe('npm-package');
    expect(provenance.resolvedPath.length).toBeGreaterThan(0);
  });

  it('is cached across calls (same object identity is not required, but the value is stable)', () => {
    const first = resolveCliProvenance();
    const second = resolveCliProvenance();
    expect(second).toEqual(first);
  });
});
// Invariants: INV-DEVAI-001
