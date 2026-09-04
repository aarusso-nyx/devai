import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const workspace = resolve(import.meta.dirname, '../..');
const roots: string[] = [];

function checkerFixture(rootVersion: string, cli: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-publishable-version-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages/cli'), { recursive: true });
  cpSync(
    join(workspace, 'scripts/check-publishable-closure.mjs'),
    join(root, 'scripts/check-publishable-closure.mjs'),
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: rootVersion }));
  writeFileSync(join(root, 'packages/cli/package.json'), JSON.stringify(cli));
  return root;
}

function runChecker(root: string): string {
  try {
    execFileSync(process.execPath, [join(root, 'scripts/check-publishable-closure.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    throw new Error('PUBLISHABLE_CLOSURE_FIXTURE_UNEXPECTEDLY_COMPLETED');
  } catch (error) {
    return `${String((error as { stderr?: unknown }).stderr ?? '')}${String(
      (error as Error).message,
    )}`;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('publishable closure package identity versions', () => {
  it.each(['1.4.5', '1.5.0', '1.5.0-rc.0'])(
    'accepts canonical 1.x %s through package identity before repository validation',
    (version) => {
      const root = checkerFixture(version, {
        name: '@aarusso-nyx/devai',
        version,
        // Deliberately absent: this must be the first refusal after a valid version.
      });

      expect(runChecker(root)).toContain('PUBLISHABLE_REPOSITORY_IDENTITY_INVALID');
    },
  );

  it.each([
    ['mismatched root and CLI versions', '1.5.0', '@aarusso-nyx/devai', '1.4.5'],
    ['a leading-zero minor version', '1.05.0', '@aarusso-nyx/devai', '1.05.0'],
    ['a leading-zero patch version', '1.5.00', '@aarusso-nyx/devai', '1.5.00'],
    ['a 2.x version', '2.0.0', '@aarusso-nyx/devai', '2.0.0'],
    ['a foreign CLI package name', '1.5.0', '@devai-nyx/cli', '1.5.0'],
  ])(
    '%s refuses package identity before later closure checks',
    (_label, rootVersion, name, version) => {
      const root = checkerFixture(rootVersion, { name, version });

      const output = runChecker(root);
      expect(output).toContain('PUBLISHABLE_PACKAGE_IDENTITY_INVALID');
      expect(output).not.toContain('PUBLISHABLE_REPOSITORY_IDENTITY_INVALID');
    },
  );
});
