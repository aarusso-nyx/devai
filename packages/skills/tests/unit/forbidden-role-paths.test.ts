import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, expect, it } from 'vitest';
import {
  CANONICAL_FORBIDDEN_ACTIONS,
  scanForbiddenActions,
} from '../../src/forbidden-actions/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scan(paths: string[], author: string, authorization: 'none' | 'exact' | 'other' = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'devai forbidden role ç '));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  const registryPath = join(root, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ actions: CANONICAL_FORBIDDEN_ACTIONS }));
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'existing governed bytes\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'fixture base');
  for (const path of paths) writeFileSync(join(root, path), 'changed governed bytes\n');
  git('add', '-A');
  git('-c', `user.name=${author}`, 'commit', '-qm', 'change protected fixture');
  const head = git('rev-parse', 'HEAD');
  const index = readFileSync(join(root, '.git/index'));
  const authorizationPath = join(root, 'receipts.json');
  if (authorization !== 'none')
    writeFileSync(
      authorizationPath,
      JSON.stringify({
        schemaVersion: '1.0.0',
        authorizations: [
          {
            forbidden_id: 'FORBID-MUTATE-INVARIANTS',
            commit: authorization === 'exact' ? head : '0'.repeat(40),
            authorized_by: 'Owner',
            reason: 'Exact fixture change approved',
          },
        ],
      }),
    );
  const result = scanForbiddenActions({
    repoRoot: root,
    registryPath,
    maxCommits: 1,
    ...(authorization !== 'none' ? { authorizationPath } : {}),
  });
  expect(git('rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(join(root, '.git/index'))).toEqual(index);
  for (const path of paths)
    expect(readFileSync(join(root, path), 'utf8')).toBe('changed governed bytes\n');
  return {
    head,
    receipts: result.authorization_receipts,
    findings: result.findings.filter(
      (finding) => finding.forbidden_id === 'FORBID-MUTATE-INVARIANTS',
    ),
  };
}

const permissions = [
  ['law/rule.json', 'DEVAI Architect'],
  ['product/brief.json', 'DEVAI Owner'],
  ['record/proofs/run.json', 'DEVAI Machine'],
  ['.devai/config/runtime.json', 'DEVAI Architect'],
  ['.devai/config/runtime.json', 'DEVAI Engineer'],
] as const;
it.each(permissions)('preserves %s authority for %s', (path, author) => {
  expect(scan([path], author).findings).toEqual([]);
});
it.each(permissions)('detects %s edits without the required %s role', (path) => {
  const { head, findings } = scan([path], 'Fixture');
  expect(findings).toEqual([
    expect.objectContaining({
      forbidden_id: 'FORBID-MUTATE-INVARIANTS',
      source: 'commit-change',
      ref: head,
    }),
  ]);
});
it('requires authority over every protected path in a mixed commit', () => {
  const { head, findings } = scan(['law/rule.json', 'product/brief.json'], 'DEVAI Architect');
  expect(findings).toEqual([
    expect.objectContaining({
      forbidden_id: 'FORBID-MUTATE-INVARIANTS',
      source: 'commit-change',
      ref: head,
    }),
  ]);
});

// Current constitutional round state requires authorized actions. A Git author
// label alone is not an authorization receipt for editing that runtime state.
it.each([
  'Fixture',
  'DEVAI Architect',
  'DEVAI Owner',
  'DEVAI Auditor',
  'DEVAI Inspector',
  'DEVAI Engineer',
  'DEVAI Machine',
])('detects current round-state changes attributed to %s without authorization', (author) => {
  const { head, findings } = scan(['.devai/local/rounds/R-0001/audit/status.json'], author);
  expect(findings).toEqual([
    expect.objectContaining({
      forbidden_id: 'FORBID-MUTATE-INVARIANTS',
      source: 'commit-change',
      ref: head,
    }),
  ]);
});

it.each(['exact', 'other'] as const)(
  'binds current round-state authorization to the %s commit',
  (authorization) => {
    const { head, findings, receipts } = scan(
      ['.devai/local/rounds/R-0001/task/result.json'],
      'DEVAI Engineer',
      authorization,
    );
    expect(findings).toHaveLength(authorization === 'exact' ? 0 : 1);
    if (receipts === undefined) throw new Error('scanner omitted authorization reconciliation');
    expect(receipts.applied).toEqual(
      authorization === 'exact' ? [`FORBID-MUTATE-INVARIANTS@${head}`] : [],
    );
    expect(receipts.unused).toEqual(
      authorization === 'other' ? [`FORBID-MUTATE-INVARIANTS@${'0'.repeat(40)}`] : [],
    );
  },
);
