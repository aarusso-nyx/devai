import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkCiEconomy } from '../../src/commands/check/ci-economy.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WORKFLOW = '.github/workflows/pull-request-checks.yml';
const FILES = [
  WORKFLOW,
  '.github/actions/setup-node-toolchain/action.yml',
  'package.json',
  'scripts/process/bootstrap-check-runner.mjs',
  'scripts/process/validation-runner.mjs',
  'scripts/run-native-apfs-tests.mjs',
];
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-ci-economy-native-'));
  roots.push(root);
  for (const file of FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  return root;
}
function rule(root: string, workflowsDir?: string) {
  return checkCiEconomy({
    repoRoot: root,
    ...(workflowsDir === undefined ? {} : { workflowsDir }),
  }).findings.find((finding) => finding.ruleId === 'ci-economy.no-macos-on-pr');
}

describe('exact reviewed native qualification economy profile (ADR-CHK-0010)', () => {
  it('admits only the exact reviewed canonical workflow and executed bytes', () => {
    expect(rule(fixture())).toMatchObject({
      severity: 'pass',
      message:
        'only the exact reviewed DEVAI native APFS qualification uses macOS on pull requests (ADR-CHK-0010)',
    });
  });

  it.each([
    'comment',
    'runner',
    'expression',
    'optional',
    'guard',
    'dependency',
    'alias',
    'duplicate',
    'malformed',
    'defaults',
    'rename',
    'transplant',
    'extra-macos',
  ])('retains the hard refusal after %s workflow changes', (variant) => {
    const root = fixture();
    const path = join(root, WORKFLOW);
    const original = readFileSync(path, 'utf8');
    let changed = original;
    if (variant === 'comment') changed += '\n# unreviewed macos reference\n';
    if (variant === 'runner')
      changed = changed.replace('runs-on: macos-15', 'runs-on: macos-latest');
    if (variant === 'expression')
      changed = changed.replace('runs-on: macos-15', 'runs-on: ${{ matrix.macos }}');
    if (variant === 'optional')
      changed = changed.replace('  native-apfs:\n', '  native-apfs:\n    if: false\n');
    if (variant === 'guard')
      changed = changed.replace(
        'test "${{ needs.native-apfs.result }}" = "success"',
        'true # native guard removed',
      );
    if (variant === 'dependency')
      changed = changed.replace(
        'needs: [gate-cli, gate-rest, native-apfs]',
        'needs: [gate-cli, gate-rest]',
      );
    if (variant === 'alias') changed = 'anchor: &macos {}\ncopy: *macos\n' + changed;
    if (variant === 'duplicate') changed += '\njobs: {} # macos\n';
    if (variant === 'malformed') changed += '\ninvalid: [macos\n';
    if (variant === 'defaults') changed += '\ndefaults: {run: {shell: "bash -c true {0}"}}\n';
    if (variant === 'rename') changed = changed.replace('  native-apfs:\n', '  other-native:\n');
    if (variant === 'transplant')
      changed = changed.replace(
        'Qualify actual native APFS contracts',
        'Transplanted native APFS contracts',
      );
    if (variant === 'extra-macos') changed += '\n  other-macos:\n    runs-on: macos-15\n';
    expect(changed).not.toBe(original);
    writeFileSync(path, changed);
    expect(rule(root)?.severity).toBe('fail');
  });

  it.each(FILES.slice(1))('refuses missing, altered, nonregular and symlinked %s', (file) => {
    const root = fixture();
    const path = join(root, file);
    const bytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n')]));
    expect(rule(root)?.severity).toBe('fail');
    rmSync(path);
    expect(rule(root)?.severity).toBe('fail');
    mkdirSync(path);
    expect(rule(root)?.severity).toBe('fail');
    rmSync(path, { recursive: true });
    symlinkSync(join(ROOT, file), path);
    expect(rule(root)?.severity).toBe('fail');
  });

  it('refuses copied filenames, custom directories and physical workflow aliases', () => {
    const root = fixture();
    const path = join(root, WORKFLOW);
    cpSync(path, join(dirname(path), 'copied.yml'));
    expect(rule(root)?.severity).toBe('fail');
    rmSync(join(dirname(path), 'copied.yml'));
    mkdirSync(join(root, 'other-workflows'));
    cpSync(path, join(root, 'other-workflows/pull-request-checks.yml'));
    expect(rule(root, 'other-workflows')?.severity).toBe('fail');
    rmSync(path);
    symlinkSync(join(ROOT, WORKFLOW), path);
    expect(rule(root)?.severity).toBe('fail');
  });
});
