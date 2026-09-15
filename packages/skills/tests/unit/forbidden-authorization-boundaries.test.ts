import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, expect, it } from 'vitest';
import { scanForbiddenActions } from '../../src/forbidden-actions/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const receipt = {
  forbidden_id: 'FORBID-FORCE-PUSH',
  commit: 'a'.repeat(40),
  authorized_by: 'Owner',
  reason: '12345678',
};
const document = (authorizations: unknown = []) => ({ schemaVersion: '1.0.0', authorizations });
function fixture(body: unknown, malformed = false) {
  const root = mkdtempSync(join(tmpdir(), 'devai-authorization-boundaries-'));
  roots.push(root);
  const registryPath = join(root, 'registry.json');
  writeFileSync(
    registryPath,
    JSON.stringify({
      actions: [
        {
          id: receipt.forbidden_id,
          action: 'force push',
          rationale: 'history',
          severity: 'critical',
          detect_patterns: ['git push --force'],
        },
      ],
    }),
  );
  const authorizationPath = join(root, 'receipts.json');
  writeFileSync(authorizationPath, malformed ? String(body) : JSON.stringify(body));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'seed',
    ],
    { cwd: root },
  );
  const bytes = readFileSync(authorizationPath);
  let result: ReturnType<typeof scanForbiddenActions> | undefined;
  expect(() => {
    result = scanForbiddenActions({
      repoRoot: root,
      registryPath,
      authorizationPath,
      maxCommits: 1,
    });
  }).not.toThrow();
  if (result === undefined) throw new Error('scanner returned no result');
  expect(readFileSync(authorizationPath)).toEqual(bytes);
  return { result, authorizationPath };
}

it.each([
  {
    label: 'malformed JSON',
    body: '{',
    malformed: true,
    reason: 'authorization receipt bytes are malformed',
  },
  ...[null, [], 'text', 42, true].map((body) => ({
    label: `root ${JSON.stringify(body)}`,
    body,
    reason: 'authorization receipt root must be an object',
  })),
  {
    label: 'unknown root field',
    body: { ...document(), wildcard: true },
    reason: 'authorization receipt root contains an unknown field',
  },
  {
    label: 'non-string schema link',
    body: { ...document(), $schema: 7 },
    reason: 'authorization receipt root contains an unknown field',
  },
  ...[
    { ...document(), schemaVersion: '2.0.0' },
    { authorizations: [] },
    document(null),
    document({}),
    document('all'),
  ].map((body) => ({
    label: `document ${JSON.stringify(body)}`,
    body,
    reason: 'authorization receipts require schemaVersion 1.0.0 and an authorizations array',
  })),
  ...[null, [], 'text', 42, true].map((value) => ({
    label: `entry ${JSON.stringify(value)}`,
    body: document([value]),
    reason: 'every authorization receipt must be an object',
  })),
  {
    label: 'unknown receipt field',
    body: document([{ ...receipt, wildcard: true }]),
    reason: 'authorization receipts contain an unknown field',
  },
  ...['FORBID-UNKNOWN', 1, null].map((forbidden_id) => ({
    label: `action ${forbidden_id}`,
    body: document([{ ...receipt, forbidden_id }]),
    reason: 'authorization receipt names an unknown forbidden action',
  })),
  ...[
    'x' + 'a'.repeat(40),
    'a'.repeat(40) + 'x',
    'A'.repeat(40),
    'a'.repeat(39),
    'a'.repeat(41),
    123,
  ].map((commit) => ({
    label: `commit ${commit}`,
    body: document([{ ...receipt, commit }]),
    reason: 'authorization receipt commit must be a full lowercase SHA',
  })),
  {
    label: 'wrong authority',
    body: document([{ ...receipt, authorized_by: 'Engineer' }]),
    reason: 'authorization receipt has an invalid human authority',
  },
  ...['1234567', ' 1234567 ', '', 123].map((reason) => ({
    label: `reason ${reason}`,
    body: document([{ ...receipt, reason }]),
    reason: 'authorization receipt reason is missing or too short',
  })),
  {
    label: 'duplicate identity',
    body: document([receipt, { ...receipt, reason: 'different explanation' }]),
    reason: 'authorization receipts contain a duplicate action and commit',
  },
])(
  'authorization parser refuses $label with its exact diagnostic',
  ({ body, reason, ...options }) => {
    const { result, authorizationPath } = fixture(
      body,
      'malformed' in options && options.malformed === true,
    );
    expect(result).toEqual({
      registry_entries: 1,
      findings: [
        {
          forbidden_id: 'FORBIDDEN-AUTHORIZATION-INVALID',
          source: 'commit-change',
          ref: authorizationPath,
          matched: '',
          message: reason,
        },
      ],
    });
  },
);

it('authorization parser accepts the minimum reason and distinct exact commit identities', () => {
  const second = { ...receipt, commit: 'b'.repeat(40) };
  const { result, authorizationPath } = fixture({
    ...document([receipt, second]),
    $schema: 'https://example.invalid/receipt.schema.json',
  });
  expect(result.findings).not.toContainEqual(
    expect.objectContaining({ forbidden_id: 'FORBIDDEN-AUTHORIZATION-INVALID' }),
  );
  expect(result.authorization_receipts).toEqual({
    path: authorizationPath,
    declared: 2,
    applied: [],
    unused: [
      `${receipt.forbidden_id}@${receipt.commit}`,
      `${second.forbidden_id}@${second.commit}`,
    ],
  });
});
