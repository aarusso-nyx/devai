// External expanded tranche: genuine registered Git history; no positive binding is fabricated.
// Existing complete commit-range/caller suites remain unchanged and mandatory.
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARCHITECT,
  ENGINEER,
  MACHINE,
  SELECTED,
  registeredDocumentationRepository,
  jsonFile,
} from '../helpers/registered-documentation-git-fixture.js';

const repositories: ReturnType<typeof registeredDocumentationRepository>[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});
function fixture() {
  const repository = registeredDocumentationRepository();
  repositories.push(repository);
  return repository;
}
function selectedPath() {
  const path = SELECTED[0];
  assert(path);
  return path;
}
function expectDenied(
  result: ReturnType<ReturnType<typeof registeredDocumentationRepository>['check']>,
  commit: string,
  path: string,
) {
  const output = result.stdout + result.stderr;
  expect(result.status, output).toBe(1);
  expect(output).toContain(`commit ${commit} `);
  expect(output).toContain(path);
  expect(output).not.toMatch(/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|SyntaxError/);
  expect(output).not.toMatch(
    /DOCUMENTATION_COMMIT_VERIFIER_UNAVAILABLE|DOCUMENTATION_COMMIT_VERIFIER_IDENTITY_MISMATCH/,
  );
  expect(output).not.toMatch(/TypeError|ReferenceError|RangeError/);
  const finding = output.split('\n').find((line) => line.trimStart().startsWith(`path ${path} `));
  assert(finding, 'refusal must be attached to the exact tested path');
  expect(finding).toMatch(
    / is not admitted for any author| admits .+, not the author role | documentation authority refused: DOCUMENTATION_COMMIT_(?:BINDING_INCOMPLETE|BINDING_INVALID|PATH_INVALID|PATH_KIND_INVALID|TREE_INVALID|NATIVE_VERIFICATION_FAILED|SNAPSHOT_CHANGED|REPOSITORY_ID_UNAVAILABLE):/,
  );
  if (finding.includes('DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED:')) {
    expect(finding).toMatch(
      /DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED:(?:DOCUMENTATION_IMPLEMENTATION_CONTEXT_BINDING_MISMATCH|DOCUMENTATION_COMMIT_SNAPSHOT_CHANGED):/,
    );
  }
}

describe('registered documentation authority in immutable commit history', () => {
  it('admits a genuine Architect binding checkpoint then Engineer selected edit', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.put(selectedPath(), 'export const version = 2;\n');
    const edit = r.commit('docs: update selected implementation', ENGINEER);
    const result = r.check(r.seed, edit);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('2 first-parent commits, 0 offending');
  });

  it('refuses Architect implementation after a genuine selected binding', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.put(selectedPath(), 'export const version = 2;\n');
    const edit = r.commit('docs: update selected implementation', ARCHITECT);
    expectDenied(r.check(bound, edit), edit, selectedPath());
  });

  it('does not rescue an earlier unbound Engineer edit with a later binding', () => {
    const r = fixture();
    r.put(selectedPath(), 'export const version = 2;\n');
    const edit = r.commit('docs: update unbound implementation', ENGINEER);
    const bound = r.bind();
    assert(bound);
    expectDenied(r.check(r.seed, bound), edit, selectedPath());
  });

  it('does not revoke a valid historical edit when a later Architect binding removes selection', () => {
    const r = fixture();
    r.bind();
    r.put(selectedPath(), 'export const version = 2;\n');
    r.commit('docs: update selected implementation', ENGINEER);
    const removed = r.bind(null);
    assert(removed);
    const result = r.check(r.seed, removed);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('3 first-parent commits, 0 offending');
  });

  it('does not read an uncommitted current source as authority for a frozen historical edit', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.put(selectedPath(), 'export const version = 2;\n');
    const edit = r.commit('docs: update selected implementation', ENGINEER);
    const source = readFileSync(join(r.cwd, r.sourcePath));
    const before = r.check(bound, edit);
    expect(before.status, before.stdout + before.stderr).toBe(0);
    try {
      r.put(r.sourcePath, Buffer.concat([source, Buffer.from('\n')]));
      const after = r.check(bound, edit);
      expect(after).toEqual(before);
    } finally {
      r.put(r.sourcePath, source);
    }
  });

  it('refuses the selected path itself when Engineer creates binding and implementation together', () => {
    const r = fixture();
    r.bind(SELECTED, false);
    r.put(selectedPath(), 'export const version = 2;\n');
    const selfGrant = r.commit('law: attempt source and implementation self grant', ENGINEER);
    expectDenied(r.check(r.seed, selfGrant), selfGrant, selectedPath());
  });

  it.each([ARCHITECT, MACHINE])('refuses standalone compiled policy output by $name', (role) => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    const policy = readFileSync(join(r.cwd, r.policyPath));
    r.put(r.policyPath, Buffer.concat([policy, Buffer.from('\n')]));
    const outputOnly = r.commit('law: change standalone compiled authority', role);
    expectDenied(r.check(bound, outputOnly), outputOnly, r.policyPath);
  });

  it.each([
    { from: 'docs/site/version.ts', to: 'docs/site/api.ts', admitted: true },
    { from: 'docs/site/version.ts', to: 'docs/site/sidebars.ts', admitted: false },
    { from: 'docs/site/sidebars.ts', to: 'docs/site/version.ts', admitted: false },
  ])('checks actual rename endpoints $from to $to independently', ({ from, to, admitted }) => {
    const r = fixture();
    r.remove(to);
    r.commit('docs: prepare absent rename destination', ARCHITECT);
    const bound = r.bind();
    assert(bound);
    r.rename(from, to);
    const renamed = r.commit('docs: rename implementation fixture', ENGINEER);
    expect(
      r.git(['diff-tree', '--no-commit-id', '--name-status', '--no-renames', '-r', renamed]),
    ).toContain(`D\t${from}`);
    expect(
      r.git(['diff-tree', '--no-commit-id', '--name-status', '--no-renames', '-r', renamed]),
    ).toContain(`A\t${to}`);
    const result = r.check(bound, renamed);
    if (admitted) expect(result.status, result.stdout + result.stderr).toBe(0);
    else expectDenied(result, renamed, from.includes('sidebars') ? from : to);
  });

  it.each([
    { role: ENGINEER, admitted: false },
    { role: ARCHITECT, admitted: true },
  ])('registered removal restores legacy docs routing for $role.name', ({ role, admitted }) => {
    const r = fixture();
    r.bind();
    const removed = r.bind(null);
    assert(removed);
    r.put(selectedPath(), 'export const version = 3;\n');
    const edit = r.commit('docs: change formerly selected implementation', role);
    const result = r.check(removed, edit);
    if (admitted) expect(result.status, result.stdout + result.stderr).toBe(0);
    else expectDenied(result, edit, selectedPath());
  });

  it('refuses residual old selected rules after genuine registered removal', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    const oldPolicy = readFileSync(join(r.cwd, r.policyPath));
    r.bind(null, false);
    r.put(r.policyPath, oldPolicy);
    const residual = r.commit('law: retain invalid residual selected rules', ARCHITECT);
    const result = r.check(bound, residual);
    expectDenied(result, residual, r.policyPath);
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED');
  });

  it('refuses stale no-block source bytes despite a same-commit source/output pairing', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.bind(null, false);
    const source = readFileSync(join(r.cwd, r.sourcePath));
    r.put(r.sourcePath, Buffer.concat([source, Buffer.from('\n')]));
    const stale = r.commit('law: retain stale no-block source digest', ARCHITECT);
    const result = r.check(bound, stale);
    expectDenied(result, stale, r.policyPath);
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED');
  });

  it('refuses a no-block unrelated-core policy forgery after genuine removal', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.bind(null, false);
    const policy: unknown = JSON.parse(readFileSync(join(r.cwd, r.policyPath), 'utf8'));
    assert(policy !== null && typeof policy === 'object' && 'rules' in policy);
    assert(Array.isArray(policy.rules));
    const row: unknown = policy.rules.find(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === 'object' &&
        'origin' in entry &&
        entry.origin === 'immutable-core',
    );
    assert(row !== null && typeof row === 'object' && 'rationale' in row);
    assert(typeof row.rationale === 'string');
    row.rationale += ' Inspector no-block forgery sentinel.';
    r.put(r.policyPath, JSON.stringify(policy));
    const forged = r.commit('law: retain forged no-block immutable core', ARCHITECT);
    const result = r.check(bound, forged);
    expectDenied(result, forged, r.policyPath);
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED');
  });

  it('refuses a stale selected receipt fragment grafted onto real no-block output', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    const receiptPath = '.devai/config/adopter-policy-binding.json';
    const original: unknown = JSON.parse(readFileSync(join(r.cwd, receiptPath), 'utf8'));
    assert(
      original !== null &&
        typeof original === 'object' &&
        'documentation_implementation' in original,
    );
    const genuinePriorFragment = original.documentation_implementation;
    r.bind(null, false);
    const removed: unknown = JSON.parse(readFileSync(join(r.cwd, receiptPath), 'utf8'));
    assert(removed !== null && typeof removed === 'object');
    assert.equal(Object.hasOwn(removed, 'documentation_implementation'), false);
    r.put(
      receiptPath,
      JSON.stringify({ ...removed, documentation_implementation: genuinePriorFragment }),
    );
    const stale = r.commit('law: retain stale selected receipt fragment', ARCHITECT);
    const result = r.check(bound, stale);
    expectDenied(result, stale, r.policyPath);
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED');
  });

  it.each([
    { role: ARCHITECT, admitted: true },
    { role: ENGINEER, admitted: false },
  ])('preserves unselected documentation routing for $role.name', ({ role, admitted }) => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    const path = 'docs/site/sidebars.ts';
    r.put(path, 'export const untouchedPolicy = true;\n');
    const edit = r.commit('docs: edit unselected implementation', role);
    const result = r.check(bound, edit);
    if (admitted) expect(result.status, result.stdout + result.stderr).toBe(0);
    else expectDenied(result, edit, path);
  });

  it.each(['add', 'delete'] as const)(
    'admits an actual selected %s with unchanged parent binding',
    (operation) => {
      const r = fixture();
      const path = selectedPath();
      if (operation === 'add') {
        r.remove(path);
        r.commit('docs: prepare selected absent path', ARCHITECT);
      }
      const bound = r.bind();
      assert(bound);
      if (operation === 'add') r.put(path, 'export const created = true;\n');
      else r.remove(path);
      const edit = r.commit(`docs: ${operation} selected implementation`, ENGINEER);
      const changes = r.git([
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '--no-renames',
        '-r',
        edit,
      ]);
      expect(changes).toContain(`${operation === 'add' ? 'A' : 'D'}\t${path}`);
      const result = r.check(bound, edit);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it('refuses an actual orphan root self-grant despite genuine bound data', () => {
    const r = fixture();
    r.bind();
    r.git(['checkout', '--orphan', 'self-grant-root']);
    r.put(selectedPath(), 'export const rootGrant = true;\n');
    const rootCommit = r.commit('law: attempt root implementation self grant', ENGINEER);
    expect(r.git(['rev-list', '--parents', '-n', '1', rootCommit])).toBe(rootCommit);
    expectDenied(r.check(r.seed, rootCommit), rootCommit, selectedPath());
  });

  it.each(['docs/site/probe.spec.ts', 'docs/site/schema.js'])(
    'refuses protected selection %s without partial output',
    (path) => {
      const r = fixture();
      const bound = r.bind();
      assert(bound);
      const rejected = r.rejectedSelection(path);
      expect(rejected.status, rejected.stdout + rejected.stderr).toBe(2);
      expect(rejected.stdout + rejected.stderr).toContain('DOCUMENTATION_IMPLEMENTATION_INVALID');
      r.put(path, 'export const protectedEdit = true;\n');
      const edit = r.commit('docs: attempt protected implementation edit', ENGINEER);
      expectDenied(r.check(bound, edit), edit, path);
    },
  );

  it.each([
    { label: 'source bytes', path: 'law/policy/inspector-documentation.json' },
    { label: 'receipt source digest', path: '.devai/config/adopter-policy-binding.json' },
    { label: 'receipt package identity', path: '.devai/config/adopter-policy-binding.json' },
    { label: 'materialized project', path: '.devai/config/project.json' },
    { label: 'unrelated core rationale', path: '.devai/config/authority-policy.json' },
    { label: 'pinned law', path: '.devai/pin/constitution.md' },
    { label: 'pending journal', path: '.devai/config/adopter-policy-binding.journal.json' },
    { label: 'future timestamp', path: '.devai/config/authority-policy.json' },
    { label: 'expired shadow', path: '.devai/config/authority-policy.json' },
  ])('refuses selected implementation with committed $label tamper', ({ label, path }) => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    if (label === 'pending journal')
      r.put(path, '{}\n'); // Presence alone is the native pending-boundary predicate.
    else if (
      label === 'source bytes' ||
      label === 'pinned law' ||
      label === 'materialized project'
    ) {
      r.put(path, Buffer.concat([readFileSync(join(r.cwd, path)), Buffer.from('\n')]));
    } else {
      const value = jsonFile(join(r.cwd, path));
      if (label === 'receipt source digest') value.source_digest_sha256 = '0'.repeat(64);
      else if (label === 'receipt package identity') {
        const selected = value.documentation_implementation;
        assert(
          selected !== null && typeof selected === 'object' && 'framework_package' in selected,
        );
        const framework = selected.framework_package;
        assert(framework !== null && typeof framework === 'object' && 'version' in framework);
        framework.version = '999.0.0-inspector-negative';
      } else if (label === 'future timestamp')
        value.materialized_at = new Date(Date.now() + 86_400_000).toISOString();
      else if (label === 'expired shadow')
        value.enforcement = {
          mode: 'shadow',
          shadow: {
            reason: 'Inspector expired-shadow negative',
            approved_by: { role: 'architect', declaration_source: 'cli-flag' },
            expires_at: '2000-01-01T00:00:00.000Z',
          },
        };
      else {
        assert(Array.isArray(value.rules));
        const rule: unknown = value.rules.find(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === 'object' &&
            'origin' in entry &&
            entry.origin === 'immutable-core',
        );
        assert(
          rule !== null &&
            typeof rule === 'object' &&
            'rationale' in rule &&
            typeof rule.rationale === 'string',
        );
        rule.rationale += ' Inspector committed forgery.';
      }
      r.put(path, JSON.stringify(value));
    }
    const tampered = r.commit('law: record invalid bound dependency', ARCHITECT);
    r.put(selectedPath(), 'export const afterTamper = true;\n');
    const edit = r.commit('docs: attempt selected edit after dependency tamper', ENGINEER);
    const result = r.check(tampered, edit);
    expectDenied(result, edit, selectedPath());
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED');
  });

  it('refuses compiled package identity mismatch without loading historical executable code', () => {
    const r = fixture();
    r.bind();
    const path = r.policyPath;
    const value = jsonFile(join(r.cwd, path));
    const framework = value.framework_package;
    assert(framework !== null && typeof framework === 'object' && 'version' in framework);
    framework.version = '999.0.0-inspector-negative';
    r.put(path, JSON.stringify(value));
    const tampered = r.commit('law: record unsupported receipt package identity', ARCHITECT);
    r.put(selectedPath(), 'export const afterPackageTamper = true;\n');
    const edit = r.commit('docs: attempt mismatched package edit', ENGINEER);
    const result = r.check(tampered, edit);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`commit ${edit} `);
    expect(result.stderr).toContain(
      `path ${selectedPath()} documentation authority refused: DOCUMENTATION_COMMIT_VERIFIER_IDENTITY_MISMATCH`,
    );
    expect(result.stderr).not.toMatch(
      /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|DOCUMENTATION_COMMIT_VERIFIER_UNAVAILABLE/,
    );
  });

  it('cannot replace an omitted historical compiled policy with current working-tree bytes', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    const policy = readFileSync(join(r.cwd, r.policyPath));
    r.remove(r.policyPath);
    const missing = r.commit('law: omit required retained authority artifact', ARCHITECT);
    r.put(selectedPath(), 'export const missingHistoricalPolicy = true;\n');
    const edit = r.commit('docs: attempt edit without historical authority', ENGINEER);
    // Restore only untracked current bytes after the immutable commits exist.
    r.put(r.policyPath, policy);
    const result = r.check(missing, edit);
    expectDenied(result, edit, selectedPath());
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_BINDING_INCOMPLETE');
    expect(r.git(['ls-tree', edit, '--', r.policyPath])).toBe('');
  });

  it.each(['.devai/pin/constitution.md', 'docs/site/version.ts'])(
    'refuses actual Git symlink mode for %s',
    (path) => {
      const r = fixture();
      r.bind();
      const original = readFileSync(join(r.cwd, path));
      r.put('symlink-target.fixture', original);
      r.remove(path);
      symlinkSync('../../symlink-target.fixture', join(r.cwd, path));
      const modeChange = r.commit('law: retain invalid symlink dependency', ARCHITECT);
      expect(r.git(['ls-tree', modeChange, '--', path])).toMatch(/^120000 blob /);
      const other = SELECTED[1];
      assert(other);
      r.put(other, 'export const symlinkDenied = true;\n');
      const edit = r.commit('docs: attempt selected edit with symlink', ENGINEER);
      const result = r.check(modeChange, edit);
      expectDenied(result, edit, other);
      expect(result.stderr).toContain('DOCUMENTATION_COMMIT_PATH_KIND_INVALID');
    },
  );

  it('refuses an actual Git gitlink at a bound dependency', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    const path = '.devai/pin/constitution.md';
    r.remove(path);
    r.git(['update-index', '--add', '--cacheinfo', `160000,${bound},${path}`]);
    r.git(['commit', '-qm', 'law: retain invalid gitlink dependency'], ARCHITECT);
    const gitlink = r.git(['rev-parse', 'HEAD']);
    expect(r.git(['ls-tree', gitlink, '--', path])).toMatch(/^160000 commit /);
    r.put(selectedPath(), 'export const gitlinkDenied = true;\n');
    // Stage only this regular endpoint: preserve the actual gitlink in the new tree.
    r.git(['add', selectedPath()]);
    r.git(['commit', '-qm', 'docs: attempt selected edit with gitlink'], ENGINEER);
    const edit = r.git(['rev-parse', 'HEAD']);
    const result = r.check(gitlink, edit);
    expectDenied(result, edit, selectedPath());
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_PATH_KIND_INVALID');
  });

  it('preserves actual common-repository identity from a linked worktree with another basename', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.put(selectedPath(), 'export const linkedWorktree = true;\n');
    const edit = r.commit('docs: update selected implementation', ENGINEER);
    const linked = join(r.parent, 'different-checkout-name');
    r.git(['worktree', 'add', '--detach', linked, edit]);
    const result = r.check(bound, edit, linked);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each([
    {
      label: 'wrong author email',
      author: { name: 'DEVAI Engineer', email: 'engineer@example.invalid' },
      committer: ENGINEER,
      reason: 'not an exact DEVAI role identity',
    },
    {
      label: 'different role committer',
      author: ENGINEER,
      committer: ARCHITECT,
      reason: "neither the author's role",
    },
  ])('retains selected-path metadata refusal for $label', ({ author, committer, reason }) => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.put(selectedPath(), 'export const metadata = true;\n');
    const edit = r.commit('docs: edit selected implementation', author, committer);
    const result = r.check(bound, edit);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`commit ${edit} `);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).not.toContain('DOCUMENTATION_COMMIT_VERIFIER_UNAVAILABLE');
  });

  it('retains the existing exact update-branch App committer exception', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.put(selectedPath(), 'export const appUpdated = true;\n');
    const edit = r.commit('docs: update selected implementation', ENGINEER, {
      name: 'devai-update-branch[bot]',
      email: '123456789+devai-update-branch[bot]@users.noreply.github.com',
    });
    const result = r.check(bound, edit);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('does not let a selected implementation grant authorize accompanying unselected prose', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.put(selectedPath(), 'export const selected = true;\n');
    r.put('docs/site/sidebars.ts', 'export const unselected = true;\n');
    const edit = r.commit('docs: attempt mixed ownership edit', ENGINEER);
    expectDenied(r.check(bound, edit), edit, 'docs/site/sidebars.ts');
  });

  it('keeps private generic proof separate from the unchanged public documentation issuer', () => {
    const r = fixture();
    r.bind(null);
    const observation = r.inspectNativeIssuers();
    const proof = observation.proof;
    assert(proof !== null && typeof proof === 'object');
    expect(observation.frozen).toBe(true);
    expect(Object.keys(proof).sort()).toEqual(['fingerprint', 'hasDocumentation', 'sourcePath']);
    assert('sourcePath' in proof && 'hasDocumentation' in proof && 'fingerprint' in proof);
    expect(proof.sourcePath).toBe(r.sourcePath);
    expect(proof.hasDocumentation).toBe(false);
    expect(typeof proof.fingerprint).toBe('string');
    expect(observation.publicError).toBe('DOCUMENTATION_IMPLEMENTATION_CONTEXT_BINDING_MISMATCH');
  });

  it.each([
    { path: 'fixtures/unrelated\\legacy.txt', selected: false },
    { path: 'fixtures/control\tname.txt', selected: false },
    { path: 'fixtures/unrelated\\legacy.txt', selected: true },
    { path: 'fixtures/control\tname.txt', selected: true },
  ])(
    'does not globally reject unrelated Git path $path (selected=$selected)',
    ({ path, selected }) => {
      const r = fixture();
      r.put(path, 'unrelated historical bytes\n');
      r.commit('docs: prepare unrelated historical path', ARCHITECT); // Prerequisite, outside judged range.
      const bound = r.bind(selected ? SELECTED : null);
      assert(bound);
      r.put(selectedPath(), 'export const nativeScope = true;\n');
      const edit = r.commit(
        'docs: edit implementation with unrelated historical file',
        selected ? ENGINEER : ARCHITECT,
      );
      expect(r.git(['ls-tree', '-r', '--name-only', '-z', edit])).toContain(path);
      const result = r.check(bound, edit);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it('still refuses an unsafe dependency path before snapshot extraction', () => {
    const r = fixture();
    r.bind();
    const path = '.devai/config/adopter-policy-binding.json';
    const receipt = jsonFile(join(r.cwd, path));
    assert(
      receipt.materialized !== null &&
        typeof receipt.materialized === 'object' &&
        !Array.isArray(receipt.materialized),
    );
    r.put(
      path,
      JSON.stringify({
        ...receipt,
        materialized: {
          ...receipt.materialized,
          '.devai/config/unsafe\\name.json': '0'.repeat(64),
        },
      }),
    );
    const tampered = r.commit('law: retain invalid dependency path', ARCHITECT);
    r.put(selectedPath(), 'export const extractionMustRefuse = true;\n');
    const edit = r.commit('docs: attempt unsafe dependency extraction', ENGINEER);
    const result = r.check(tampered, edit);
    expectDenied(result, edit, selectedPath());
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_PATH_INVALID');
  });

  it('still refuses a Git symlink ancestor of a required dependency', () => {
    const r = fixture();
    r.bind();
    r.rename('.devai/pin', 'saved-pin');
    symlinkSync('../saved-pin', join(r.cwd, '.devai/pin'));
    const tampered = r.commit('law: retain invalid dependency ancestor', ARCHITECT);
    expect(r.git(['ls-tree', tampered, '--', '.devai/pin'])).toMatch(/^120000 blob /);
    r.put(selectedPath(), 'export const ancestorMustRefuse = true;\n');
    const edit = r.commit('docs: attempt symlink ancestor extraction', ENGINEER);
    const result = r.check(tampered, edit);
    expectDenied(result, edit, selectedPath());
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_PATH_KIND_INVALID');
  });

  it('does not admit Machine for a coherent source-paired generated artifact', () => {
    const r = fixture();
    r.bind(SELECTED, false);
    const edit = r.commit('law: attempt Machine native source binding', MACHINE);
    const result = r.check(r.seed, edit);
    expectDenied(result, edit, r.policyPath);
    expect(result.stderr).toContain(
      `path ${r.policyPath} admits Architect, not the author role Machine`,
    );
    expect(result.stderr).not.toContain('DOCUMENTATION_COMMIT_NATIVE_VERIFICATION_FAILED');
  });

  it('retains merge refusal even when both selected edits have genuine parent binding', () => {
    const r = fixture();
    const bound = r.bind();
    assert(bound);
    r.git(['checkout', '-b', 'selected-side']);
    const second = SELECTED[1];
    assert(second);
    r.put(second, 'export const side = true;\n');
    r.commit('docs: update selected side', ENGINEER);
    r.git(['checkout', 'main']);
    r.put(selectedPath(), 'export const main = true;\n');
    r.commit('docs: update selected main', ENGINEER);
    r.git(
      ['merge', '--no-ff', '-m', 'docs: merge selected implementation', 'selected-side'],
      ENGINEER,
    );
    const merged = r.git(['rev-parse', 'HEAD']);
    expect(r.git(['rev-list', '--parents', '-n', '1', merged]).split(' ')).toHaveLength(3);
    const result = r.check(bound, merged);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`commit ${merged} `);
    expect(result.stderr).toContain('merge commit with 2 parents');
  });

  it.each(['fixtures/unrelated\\legacy.txt', 'fixtures/control\tname.txt'])(
    'preserves default unbound docs routing with unrelated Git path %s',
    (path) => {
      const r = fixture();
      r.put(path, 'unrelated historical bytes\n');
      const before = r.commit('docs: prepare unrelated path outside range', ARCHITECT);
      r.put(selectedPath(), 'export const defaultRouting = true;\n');
      const edit = r.commit('docs: edit default implementation', ARCHITECT);
      const result = r.check(before, edit);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it.each(['.devai/config/adopter-policy-binding.json', '.devai/config/authority-policy.json'])(
    'ignores current uncommitted %s when judging immutable history',
    (path) => {
      const r = fixture();
      const bound = r.bind();
      assert(bound);
      r.put(selectedPath(), 'export const immutable = true;\n');
      const edit = r.commit('docs: update selected implementation', ENGINEER);
      const before = r.check(bound, edit);
      expect(before.status, before.stdout + before.stderr).toBe(0);
      const bytes = readFileSync(join(r.cwd, path));
      try {
        r.put(path, 'not historical JSON\n');
        expect(r.check(bound, edit)).toEqual(before);
      } finally {
        r.put(path, bytes);
      }
    },
  );

  it('refuses a missing real receipt-named materialized target in immutable history', () => {
    const r = fixture();
    r.bind();
    const receipt = jsonFile(join(r.cwd, '.devai/config/adopter-policy-binding.json'));
    assert(
      receipt.materialized !== null &&
        typeof receipt.materialized === 'object' &&
        !Array.isArray(receipt.materialized),
    );
    const path = Object.keys(receipt.materialized).find(
      (entry) => entry !== '.devai/config/project.json',
    );
    assert(path && path.startsWith('.devai/config/'));
    r.remove(path);
    const missing = r.commit('law: omit materialized bound target', ARCHITECT);
    r.put(selectedPath(), 'export const missingTarget = true;\n');
    const edit = r.commit('docs: attempt edit with missing materialized target', ENGINEER);
    const result = r.check(missing, edit);
    expectDenied(result, edit, selectedPath());
    expect(result.stderr).toContain('DOCUMENTATION_COMMIT_BINDING_INCOMPLETE');
  });
});
