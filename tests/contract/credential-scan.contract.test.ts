// ADR-SEC-0001, Inspector Adversarial Acceptance IA-003: a literal token
// shape in any committed configuration file fails the repository-wide
// credential scan, not only the tracking binding.
//
// Red today: scripts/check-release-static-integrity.mjs only scans files
// that `git ls-files` returns for a fixed glob set (packages/*/src/**,
// packages/cli/resources/**, packages/skills/resources/**, law/policy/**,
// law/schemas/**). A committed configuration file outside that set, such as
// config/example.json, is never read by the scan at all, so a `ghp_`-shaped
// literal there passes today. This is red until the scan becomes
// repository-wide (ADR-SEC-0001's decision: "folds into the existing
// secret-scan capability").
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT_RELATIVE = 'scripts/check-release-static-integrity.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, stdio: 'ignore' });
}

/** A throwaway git repository carrying a copy of the static-integrity script
 * at the same relative path, so the script's own `import.meta.dirname`-based
 * root resolution treats this fixture directory as the repository root. */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-credential-scan-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Fixture']);
  const scriptOut = join(root, SCRIPT_RELATIVE);
  mkdirSync(dirname(scriptOut), { recursive: true });
  writeFileSync(scriptOut, readFileSync(resolve(ROOT, SCRIPT_RELATIVE)));
  return root;
}

function runScan(cwd: string): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT_RELATIVE], { cwd, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

it('fails and names the file when a committed configuration file outside the tracking binding carries a token-shaped literal', () => {
  const root = fixtureRepo();
  // Built at runtime so the literal contiguous shape never appears in this
  // test file's own committed source.
  const fakeToken = ['ghp', 'x'.repeat(20)].join('_');
  const configPath = join(root, 'config/example.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ example_setting: true, leaked_token: fakeToken }, null, 2)}\n`,
  );
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'fixture: seed config with a token-shaped literal']);

  const result = runScan(root);

  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toContain('config/example.json');
});

it("law/policy/credential-requirements.json carries names only and never trips the real scan's secret-surface check", () => {
  // The full script also fails closed on an unrelated, unclean working tree
  // (RELEASE_CANDIDATE_NOT_CLEAN) and on absolute-path portability, neither of
  // which this assertion is about; it asserts specifically that this manifest
  // never trips RELEASE_SECRET_SURFACE_DETECTED, i.e. that it is names-only.
  const result = spawnSync(process.execPath, [SCRIPT_RELATIVE], { cwd: ROOT, encoding: 'utf8' });
  expect(result.stderr).not.toContain(
    'RELEASE_SECRET_SURFACE_DETECTED:law/policy/credential-requirements.json',
  );
});
