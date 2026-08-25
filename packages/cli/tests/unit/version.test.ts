import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHelp } from '../../src/command-router.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { resolveCliProvenance, resolveCliVersion } from '../../src/version.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const SELECTED_RELEASE_VERSION = '1.2.13';
const TRUSTED_VERIFIER_PACKAGE_VERSION = '1.2.12';

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

  it('preserves the exact historical verifier-provider pin at 1.2.12', () => {
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'law/policy/trusted-local-rc-verifier-package.json'), 'utf8'),
    ) as { package: { version: string; tarball: string } };
    expect(policy.package.version).toBe(TRUSTED_VERIFIER_PACKAGE_VERSION);
    expect(policy.package.tarball).toContain(
      `/@aarusso-nyx/devai/${TRUSTED_VERIFIER_PACKAGE_VERSION}/`,
    );
    expect(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')).toContain(
      `@aarusso-nyx/devai@${TRUSTED_VERIFIER_PACKAGE_VERSION}`,
    );
    expect(
      readFileSync(join(ROOT, 'docs/dev/operations/adopter-package-contract.md'), 'utf8'),
    ).toContain(`@aarusso-nyx/devai@${TRUSTED_VERIFIER_PACKAGE_VERSION}`);
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
