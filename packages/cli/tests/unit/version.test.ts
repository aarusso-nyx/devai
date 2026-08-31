import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHelp } from '../../src/command-router.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveCliProvenance, resolveCliVersion } from '../../src/version.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SELECTED_RELEASE_VERSION = '1.4.5';
const TRUSTED_VERIFIER_PACKAGE_VERSION = '1.4.4';

describe('resolveCliVersion', () => {
  it('returns a semver-shaped string', () => {
    expect(resolveCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the selected release version', () => {
    expect(resolveCliVersion()).toBe(SELECTED_RELEASE_VERSION);
  });

  it('keeps the root and public package manifests synchronized to the selected release', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    const published = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
      version: string;
    };

    expect({ root: root.version, public: published.version }).toEqual({
      root: SELECTED_RELEASE_VERSION,
      public: SELECTED_RELEASE_VERSION,
    });
  });

  it('exposes the selected release through generated CLI help', () => {
    expect(renderHelp(canonicalRegistry(), resolveCliVersion())).toContain(
      `devai/${SELECTED_RELEASE_VERSION}`,
    );
  });

  it('keeps current consumer documentation on the selected exact release without mutable installs', () => {
    const documents = [
      'README.md',
      'docs/adopters/install.md',
      'docs/index.md',
      'docs/site/src/pages/index.tsx',
    ].map((path) => ({ path, content: readFileSync(join(ROOT, path), 'utf8') }));

    for (const { path, content } of documents) {
      expect.soft(content, path).toContain(SELECTED_RELEASE_VERSION);
    }
    const installCommands = documents
      .flatMap(({ content }) => content.split('\n'))
      .filter((line) => line.includes('pnpm add') && line.includes('@aarusso-nyx/devai@'));
    expect(installCommands.length).toBeGreaterThan(0);
    expect(installCommands.every((line) => line.includes(`@${SELECTED_RELEASE_VERSION}`))).toBe(
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
        'https://npm.pkg.github.com/download/@aarusso-nyx/devai/1.4.4/fcdf9a21f92094fce10d4cee42440abf44200467',
      shasum_sha1: 'fcdf9a21f92094fce10d4cee42440abf44200467',
      integrity_sri:
        'sha512-B1AJzDAZNw+UM1m7bQjwHT9q0gO3cutNpGPRAXFEBtq3L6AZymI6RvLc4ghh05ssOoREynXKuJyjsayRJbWPEQ==',
      release_source: {
        commit: '3aec624d0c0aecc534e60ee45306a4e5e6a7e94d',
        tree: '2cad519aba8117a1850eee85d41eae452d51a141',
      },
    });
    expect(policy.verifier).toMatchObject({
      provenance_sha256: '8ebafff53524031a3207a2256ebcd0fa6e0cc4271fd4bb6bca5aa003395034bd',
      source_commit: '37e75a5c27569d4cb3fdb4a3dc97a140da4d78de',
    });
    const currentReleaseNotes = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
      .split(`## ${SELECTED_RELEASE_VERSION}`)[1]
      ?.split('\n## ')[0];
    expect(currentReleaseNotes).toContain(`@aarusso-nyx/devai@${TRUSTED_VERIFIER_PACKAGE_VERSION}`);
    expect(
      readFileSync(join(ROOT, 'docs/dev/operations/adopter-package-contract.md'), 'utf8'),
    ).toContain(`@aarusso-nyx/devai@${TRUSTED_VERIFIER_PACKAGE_VERSION}`);
  });

  it('proves the trusted provider release contains the declared verifier provenance', () => {
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
    const releaseCommit = policy.package.release_source.commit;
    const git = (args: string[]): Buffer =>
      execFileSync('git', args, { cwd: ROOT, encoding: 'buffer' });
    const text = (args: string[]): string => git(args).toString('utf8').trim();

    expect(text(['cat-file', '-t', `v${policy.package.version}`])).toBe('tag');
    expect(text(['rev-parse', `v${policy.package.version}^{commit}`])).toBe(releaseCommit);
    expect(text(['rev-parse', `${releaseCommit}^{tree}`])).toBe(policy.package.release_source.tree);

    const provenanceBytes = git([
      'show',
      `${releaseCommit}:packages/cli/vendor/evidence-verification/provenance.json`,
    ]);
    const provenance = JSON.parse(provenanceBytes.toString('utf8')) as {
      schemaVersion: string;
      sourceCommit: string;
      files: unknown[];
    };
    expect(createHash('sha256').update(provenanceBytes).digest('hex')).toBe(
      policy.verifier.provenance_sha256,
    );
    expect(provenance).toMatchObject({
      schemaVersion: '1.0.0',
      sourceCommit: policy.verifier.source_commit,
    });
    expect(provenance.files).toHaveLength(policy.verifier.payload_file_count);
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
