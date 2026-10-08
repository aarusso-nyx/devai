import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHelp } from '../../src/command-router.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveCliProvenance, resolveCliVersion } from '../../src/version.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CANDIDATE_RELEASE_VERSION = '2.3.0';
const PUBLISHED_RELEASE_VERSION = '2.2.0';
const TRUSTED_VERIFIER_PACKAGE_VERSION = '1.9.0';
const VENDORED_PROVENANCE = 'packages/cli/vendor/evidence-verification/provenance.json';
// The verifier inside the published 1.9.0 package that the law policy trusts (step 4 pin).
const TRUSTED_VERIFIER = {
  sourceCommit: '8b215d706a828af7361f9c6799b9cb0a30c9d00b',
  provenanceSha256: '302161f378e54d0a2b14b743a68577f4bfc43a147a1f17568941e08e14e767a0',
} as const;
// The in-repository vendored copy, re-vendored at step 2 for ADR-REL-0031.
const VENDORED_VERIFIER = {
  sourceCommit: '8b215d706a828af7361f9c6799b9cb0a30c9d00b',
  provenanceSha256: '302161f378e54d0a2b14b743a68577f4bfc43a147a1f17568941e08e14e767a0',
  payloadFileCount: 26,
} as const;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBytes(args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 16 * 1024 * 1024 });
}

function git(args: readonly string[]): string {
  return gitBytes(args).toString('utf8').trim();
}

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
        'https://npm.pkg.github.com/download/@aarusso-nyx/devai/1.9.0/37594fb078f5098b83b3938a3bc70ac5488c3162',
      shasum_sha1: '37594fb078f5098b83b3938a3bc70ac5488c3162',
      integrity_sri:
        'sha512-5XPsmj5rOCEETMNAoGSN5WRqhrTgIEVcIHmWsU1aNpNPdfBjqh9IsAyHEUDka2csLQ1J1y7JuV3+A1VH+IfzAg==',
      release_source: {
        commit: '75343991140c223240b51cea80c060c516226945',
        tree: '90f0f5b64bf594677f96eebf26ae80cf7da1149e',
      },
    });
    expect(policy.verifier).toMatchObject({
      provenance_sha256: '302161f378e54d0a2b14b743a68577f4bfc43a147a1f17568941e08e14e767a0',
      source_commit: '8b215d706a828af7361f9c6799b9cb0a30c9d00b',
    });
    const currentReleaseNotes = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
      .split(`## ${CANDIDATE_RELEASE_VERSION}`)[1]
      ?.split('\n## ')[0];
    expect(currentReleaseNotes).toContain(`@aarusso-nyx/devai@${TRUSTED_VERIFIER_PACKAGE_VERSION}`);
    expect(
      readFileSync(join(ROOT, 'docs/dev/operations/adopter-package-contract.md'), 'utf8'),
    ).toContain(`@aarusso-nyx/devai@${TRUSTED_VERIFIER_PACKAGE_VERSION}`);
  });

  it('binds the trusted verifier pin to the published 1.9.0 package, not to the vendored copy', () => {
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'law/policy/trusted-local-rc-verifier-package.json'), 'utf8'),
    ) as {
      package: {
        version: string;
        release_source: { repository: string; commit: string; tree: string };
      };
      verifier: {
        provenance_sha256: string;
        source_commit: string;
        payload_file_count: number;
      };
      repin: { rule: string; order: string[] };
    };
    expect(policy.package.version).toBe(TRUSTED_VERIFIER_PACKAGE_VERSION);
    expect(policy.package.release_source).toEqual({
      repository: 'aarusso-nyx/devai',
      commit: '75343991140c223240b51cea80c060c516226945',
      tree: '90f0f5b64bf594677f96eebf26ae80cf7da1149e',
    });
    // The trusted identity is read from the published release's own vendored provenance,
    // at the release-source commit the policy pins, never from the working tree.
    const releaseCommit = policy.package.release_source.commit;
    expect(git(['rev-parse', `${releaseCommit}^{tree}`])).toBe(policy.package.release_source.tree);
    const trustedBytes = gitBytes(['show', `${releaseCommit}:${VENDORED_PROVENANCE}`]);
    const trusted = JSON.parse(trustedBytes.toString('utf8')) as {
      sourceCommit: string;
      files: unknown[];
    };
    expect(sha256(trustedBytes)).toBe(TRUSTED_VERIFIER.provenanceSha256);
    expect(trusted.sourceCommit).toBe(TRUSTED_VERIFIER.sourceCommit);
    expect(policy.verifier.provenance_sha256).toBe(sha256(trustedBytes));
    expect(policy.verifier.source_commit).toBe(trusted.sourceCommit);
    expect(policy.verifier.payload_file_count).toBe(trusted.files.length);
  });

  it('binds the vendored verifier copy to its own provenance manifest', () => {
    const root = join(ROOT, 'packages/cli/vendor/evidence-verification');
    const provenanceBytes = readFileSync(join(ROOT, VENDORED_PROVENANCE));
    const provenance = JSON.parse(provenanceBytes.toString('utf8')) as {
      schemaVersion: string;
      sourceCommit: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(provenance).toMatchObject({
      schemaVersion: '1.0.0',
      sourceCommit: VENDORED_VERIFIER.sourceCommit,
    });
    expect(sha256(provenanceBytes)).toBe(VENDORED_VERIFIER.provenanceSha256);
    expect(provenance.files).toHaveLength(VENDORED_VERIFIER.payloadFileCount);
    for (const entry of provenance.files) {
      expect(sha256(readFileSync(join(root, entry.path))), entry.path).toBe(entry.sha256);
    }
  });

  it('binds the trusted pin to the vendored copy once the step-4 repin lands', () => {
    // Repin order (ADR-REL-0031, release-discipline.md): the vendored copy is rewritten at
    // step 2, a release ships it under the still-pinned verifier at step 3, and only a
    // law(release) change at step 4 moves the trusted pin. Between steps 2 and 4 the two
    // identities differ by design; step 4 (the 1.9.0 repin, #243) makes them equal again
    // until the next re-vendor opens step 2.
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'law/policy/trusted-local-rc-verifier-package.json'), 'utf8'),
    ) as {
      verifier: { provenance_sha256: string; source_commit: string };
      repin: { rule: string; order: string[]; partial_repin: boolean };
    };
    expect(policy.repin.rule).toBe(
      'trusted-verifier-trails-vendored-copy-by-one-published-release',
    );
    expect(policy.repin.order).toEqual([
      'canonical-verifier-source-change-with-tests',
      'vendored-copy-rewritten-with-new-provenance-and-in-repository-restatements',
      'release-published-under-current-pin',
      'law-repin-from-published-release',
    ]);
    expect(policy.repin.partial_repin).toBe(false);
    expect(policy.verifier.provenance_sha256).toBe(TRUSTED_VERIFIER.provenanceSha256);
    expect(policy.verifier.source_commit).toBe(TRUSTED_VERIFIER.sourceCommit);
    const vendoredBytes = readFileSync(join(ROOT, VENDORED_PROVENANCE));
    expect(sha256(vendoredBytes)).toBe(VENDORED_VERIFIER.provenanceSha256);
    expect(VENDORED_VERIFIER.provenanceSha256).toBe(TRUSTED_VERIFIER.provenanceSha256);
    expect(VENDORED_VERIFIER.sourceCommit).toBe(TRUSTED_VERIFIER.sourceCommit);
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
