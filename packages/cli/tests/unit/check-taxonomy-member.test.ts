// ADR-GOV-0017, Inspector Adversarial Acceptance IA-001 and IA-002: the
// change-taxonomy check member fails naming every tracked path no binding
// covers, rejects a path bound to two classes at load instead of resolving it
// by declaration order, and rejects a binding that names a class outside the
// law vocabulary.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import type { ResolvedCheckMember } from '../../src/commands/check/contracts.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');
const UNCLASSIFIED_PATH = 'notes/unclassified.txt';

interface Binding {
  readonly selector: Readonly<{ kind: 'exact' | 'prefix' | 'glob'; pattern: string }>;
  readonly class: string;
}

const CLASSIFIED: readonly Binding[] = [
  { selector: { kind: 'prefix', pattern: 'law/' }, class: 'law' },
  { selector: { kind: 'prefix', pattern: 'product/' }, class: 'plan' },
  { selector: { kind: 'prefix', pattern: 'packages/' }, class: 'code' },
  { selector: { kind: 'prefix', pattern: 'docs/' }, class: 'docs' },
  { selector: { kind: 'prefix', pattern: '.devai/' }, class: 'generated' },
  { selector: { kind: 'exact', pattern: '.gitignore' }, class: 'toolchain' },
];

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(root: string, args: readonly string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function repository(bindings: readonly Binding[], extraPaths: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-taxonomy-member-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  for (const path of ['law/policy/change-taxonomy.json', '.devai/config/change-taxonomy.json']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(REPOSITORY_ROOT, path), join(root, path));
  }
  put(
    root,
    '.devai/config/change-taxonomy-binding.json',
    `${JSON.stringify(
      {
        schemaVersion: '1.0.0',
        id: 'change-taxonomy-binding',
        taxonomy: 'law/policy/change-taxonomy.json',
        bindings,
      },
      null,
      2,
    )}\n`,
  );
  put(root, '.gitignore', '.devai/state/\n');
  put(root, 'product/campaigns/CMP-9999/campaign.json', '{}\n');
  put(root, 'packages/cli/src/index.ts', 'export {};\n');
  put(root, 'docs/guide.md', '# Guide\n');
  for (const path of extraPaths) put(root, path, 'fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

function member(): ResolvedCheckMember {
  return {
    id: 'change-taxonomy',
    source: 'current-selector',
    service_id: 'change-taxonomy',
    binding: { kind: 'runtime-gate', gate_id: 'check-change-taxonomy' },
    effect: 'read',
    cost: 'low',
    output: 'action-envelope-plus-change-taxonomy-report',
  };
}

async function execute(root: string) {
  return withAuthorityHostTestScope(() => executeCheckMember(member(), { repoRoot: root }));
}

describe('change-taxonomy check member (ADR-GOV-0017)', () => {
  it('passes when every tracked path resolves to exactly one class', async () => {
    const result = await execute(repository(CLASSIFIED));
    expect(result.message ?? '').not.toContain('CHECK_SERVICE_UNKNOWN');
    expect(result.status).toBe('pass');
  });

  it('fails naming the unclassified tracked path', async () => {
    const result = await execute(repository(CLASSIFIED, [UNCLASSIFIED_PATH]));
    expect(result.message ?? '').not.toContain('CHECK_SERVICE_UNKNOWN');
    expect(result.status).toBe('fail');
    expect(JSON.stringify(result)).toContain(UNCLASSIFIED_PATH);
  });

  it('fails at load on a path bound to two classes', async () => {
    const overlapping: readonly Binding[] = [
      ...CLASSIFIED,
      { selector: { kind: 'prefix', pattern: 'product/campaigns/' }, class: 'docs' },
    ];
    const result = await execute(repository(overlapping));
    expect(['fail', 'error']).toContain(result.status);
    expect(JSON.stringify(result)).toContain('CHANGE_TAXONOMY_BINDING_OVERLAP');
  });

  it('fails on a binding that names a class outside the law enum', async () => {
    const unknownClass: readonly Binding[] = [
      ...CLASSIFIED,
      { selector: { kind: 'prefix', pattern: 'infra/' }, class: 'infrastructure' },
    ];
    const result = await execute(repository(unknownClass));
    expect(['fail', 'error']).toContain(result.status);
    expect(JSON.stringify(result)).toContain('CHANGE_TAXONOMY_CLASS_UNKNOWN');
  });
});
