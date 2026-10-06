import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import {
  scanForbiddenActions,
  type ForbiddenActionFinding,
} from '../../src/forbidden-actions/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';
import { disableGitAutoMaintenance } from './git-fixture-maintenance.js';

/*
 * ADR-GOV-0022: validated append-only maintenance of the declared authorization
 * registry is not an invariant mutation. Fixtures are built from the law policy
 * bytes, which declare the exemption on FORBID-MUTATE-INVARIANTS, never from the
 * canonical in-code catalog.
 */

const REPO_ROOT = process.cwd();
const REGISTRY = 'law/policy/forbidden-action-authorizations.json';
const POLICY = 'law/policy/forbidden-actions.json';
const SCHEMA = 'law/schemas/forbidden-action-authorizations.schema.json';
const MUTATE = 'FORBID-MUTATE-INVARIANTS';
const MAINTAINER = 'DEVAI Engineer';
const POLICY_BYTES = readFileSync(join(REPO_ROOT, POLICY), 'utf8');
const SCHEMA_BYTES = readFileSync(join(REPO_ROOT, SCHEMA), 'utf8');

interface PolicyAction {
  readonly id: string;
  readonly maintenance_exemptions?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}
interface PolicyDocument {
  readonly actions: readonly PolicyAction[];
  readonly [key: string]: unknown;
}
const POLICY_DOCUMENT = JSON.parse(POLICY_BYTES) as PolicyDocument;
const ACTION_IDS = POLICY_DOCUMENT.actions.map((action) => action.id);

type Receipt = Record<string, unknown>;
type RegistryDocument = Record<string, unknown>;

const receipt = (index: number, overrides: Receipt = {}): Receipt => ({
  forbidden_id: ACTION_IDS[index % ACTION_IDS.length],
  commit: (index + 1).toString(16).padStart(40, 'c'),
  authorized_by: 'Owner',
  reason: `Owner approved the exact fixture commit number ${String(index)}.`,
  ...overrides,
});
const receipts = (from: number, to: number): Receipt[] =>
  Array.from({ length: to - from }, (_, offset) => receipt(from + offset));
const registry = (authorizations: unknown, root: RegistryDocument = {}): RegistryDocument => ({
  schemaVersion: '1.0.0',
  authorizations,
  ...root,
});
const ABSENT = Symbol('absent registry');
const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'devai-registry-maintenance-'));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  disableGitAutoMaintenance(root);
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  const write = (path: string, bytes: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const writeRegistry = (value: unknown, path = REGISTRY) => write(path, serialize(value));
  const remove = (path: string) => rmSync(join(root, path));
  const move = (from: string, to: string) => {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    renameSync(join(root, from), join(root, to));
  };
  const commit = (author = MAINTAINER, message = 'chore: record authorization receipts') => {
    git('add', '-A');
    git('-c', `user.name=${author}`, 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const scan = (options: { maxCommits?: number; sinceRef?: string; authorizationPath?: string }) =>
    scanForbiddenActions({ repoRoot: root, ...options });
  return { root, git, write, writeRegistry, remove, move, commit, scan };
}

/** A repository whose Architect-authored base carries the law policy, schema, and parent registry. */
function seeded(parent: unknown, policy = POLICY_BYTES) {
  const repo = repository();
  repo.write(POLICY, policy);
  repo.write(SCHEMA, SCHEMA_BYTES);
  repo.write('README.md', 'fixture\n');
  if (parent !== ABSENT) repo.writeRegistry(parent);
  const base = repo.commit('DEVAI Architect', 'chore: seed governed fixture');
  return { ...repo, base };
}

const mutations = (findings: readonly ForbiddenActionFinding[]) =>
  findings.filter((finding) => finding.forbidden_id === MUTATE);
const changeFinding = (ref: string) =>
  expect.objectContaining({ forbidden_id: MUTATE, source: 'commit-change', ref });

describe('fixture preconditions', () => {
  it('builds fixtures from law policy bytes that declare the append-only exemption', () => {
    const entry = POLICY_DOCUMENT.actions.find((action) => action.id === MUTATE);
    expect(entry?.maintenance_exemptions).toEqual([
      { path: REGISTRY, schema: SCHEMA, change: 'append-only', collection: '/authorizations' },
    ]);
    const schema = JSON.parse(SCHEMA_BYTES) as {
      properties: { authorizations: { items: { properties: { reason: { minLength: number } } } } };
    };
    // IA-004 relies on a reason of four astral code points: eight UTF-16 units pass
    // the runtime receipt loader, four code points fail the schema minimum.
    expect(schema.properties.authorizations.items.properties.reason.minLength).toBe(8);
    expect('😀'.repeat(4).length).toBe(8);
    expect([...'😀'.repeat(4)].length).toBe(4);
  });
});

describe('IA-001 registry maintenance is not an invariant mutation (#67)', () => {
  it('records eight receipts in one commit with zero findings under --strict', () => {
    const repo = seeded(registry([]));
    repo.writeRegistry(registry(receipts(0, 8)));
    repo.commit();
    const result = repo.scan({ maxCommits: 1 });
    expect(result.findings).toEqual([]);
    expect(result.authorization_receipts?.declared).toBe(8);
  });

  it('appends eight receipts after existing receipts with zero findings', () => {
    const repo = seeded(registry(receipts(0, 2), { $schema: 'https://example.invalid/r.json' }));
    repo.writeRegistry(registry(receipts(0, 10), { $schema: 'https://example.invalid/r.json' }));
    repo.commit();
    expect(repo.scan({ maxCommits: 1 }).findings).toEqual([]);
  });

  it('treats a newly added registry as an empty parent collection', () => {
    const repo = seeded(ABSENT);
    repo.writeRegistry(registry(receipts(0, 8)));
    repo.commit();
    expect(repo.scan({ maxCommits: 1 }).findings).toEqual([]);
  });

  it('treats a root commit that adds the registry as an empty parent collection', () => {
    const repo = repository();
    repo.writeRegistry(registry(receipts(0, 8)));
    const rootCommit = repo.commit();
    repo.write(POLICY, POLICY_BYTES);
    repo.write(SCHEMA, SCHEMA_BYTES);
    repo.commit('DEVAI Architect', 'chore: add governed policy');
    const result = repo.scan({ maxCommits: 2 });
    expect(repo.git('rev-list', '--max-parents=0', 'HEAD')).toBe(rootCommit);
    expect(result.findings).toEqual([]);
  });

  it('accepts consecutive maintenance commits across an exact base', () => {
    const repo = seeded(registry([]));
    for (const end of [3, 5, 8]) {
      repo.writeRegistry(registry(receipts(0, end)));
      repo.commit();
    }
    expect(repo.scan({ sinceRef: repo.base }).findings).toEqual([]);
  });

  it('keeps Architect-authored maintenance clean', () => {
    const repo = seeded(registry([]));
    repo.writeRegistry(registry(receipts(0, 8)));
    repo.commit('DEVAI Architect');
    expect(repo.scan({ maxCommits: 1 }).findings).toEqual([]);
  });

  it('never self-matches receipt bytes that quote a forbidden command', () => {
    const repo = seeded(registry([]));
    repo.writeRegistry(
      registry([
        receipt(0, { reason: 'Owner approved git push --force for this commit.' }),
        receipt(1, { reason: 'Owner approved rm -rf build output for this commit.' }),
      ]),
    );
    repo.commit();
    const others = repo
      .scan({ maxCommits: 1 })
      .findings.filter((finding) => finding.forbidden_id !== MUTATE);
    expect(others).toEqual([]);
  });
});

describe('IA-002 IA-003 a change that is not append-only stays a finding', () => {
  it('IA-002 deleting one receipt yields exactly one invariant finding', () => {
    const repo = seeded(registry(receipts(0, 3)));
    repo.writeRegistry(registry([receipt(0), receipt(2)]));
    const head = repo.commit();
    expect(repo.scan({ maxCommits: 1 }).findings).toEqual([changeFinding(head)]);
  });

  it('truncating the collection to empty yields exactly one invariant finding', () => {
    const repo = seeded(registry(receipts(0, 3)));
    repo.writeRegistry(registry([]));
    const head = repo.commit();
    expect(repo.scan({ maxCommits: 1 }).findings).toEqual([changeFinding(head)]);
  });

  it('IA-003 altering the digest of an existing receipt while appending is a finding', () => {
    const repo = seeded(registry(receipts(0, 2)));
    repo.writeRegistry(registry([receipt(0, { commit: 'd'.repeat(40) }), receipt(1), receipt(2)]));
    const head = repo.commit();
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });

  it('altering the reason of an existing receipt while appending is a finding', () => {
    const repo = seeded(registry(receipts(0, 2)));
    repo.writeRegistry(
      registry([receipt(0), receipt(1, { reason: 'Rewritten after the fact.' }), receipt(2)]),
    );
    const head = repo.commit();
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });

  it('inserting a receipt before existing receipts is a finding', () => {
    const repo = seeded(registry(receipts(1, 3)));
    repo.writeRegistry(registry(receipts(0, 3)));
    const head = repo.commit();
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });

  it.each([
    { label: 'reordering alone', child: [receipt(1), receipt(0)] },
    { label: 'reordering while appending', child: [receipt(1), receipt(0), receipt(2)] },
  ])('$label is a finding', ({ child }) => {
    const repo = seeded(registry(receipts(0, 2)));
    repo.writeRegistry(registry(child));
    const head = repo.commit();
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });

  it.each([
    {
      label: 'adding a $schema root member',
      parent: registry(receipts(0, 1)),
      child: registry(receipts(0, 2), { $schema: 'https://example.invalid/r.json' }),
    },
    {
      label: 'changing the $schema root member',
      parent: registry(receipts(0, 1), { $schema: 'https://example.invalid/a.json' }),
      child: registry(receipts(0, 2), { $schema: 'https://example.invalid/b.json' }),
    },
    {
      label: 'removing the $schema root member',
      parent: registry(receipts(0, 1), { $schema: 'https://example.invalid/r.json' }),
      child: registry(receipts(0, 2)),
    },
  ])('$label while appending is a finding', ({ parent, child }) => {
    const repo = seeded(parent);
    repo.writeRegistry(child);
    const head = repo.commit();
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });

  it('changing schemaVersion in a scanned commit is a finding for that commit', () => {
    const repo = seeded(registry(receipts(0, 1)));
    repo.writeRegistry(registry(receipts(0, 2), { schemaVersion: '1.1.0' }));
    const changed = repo.commit();
    repo.writeRegistry(registry(receipts(0, 2)));
    repo.commit();
    expect(mutations(repo.scan({ sinceRef: repo.base }).findings)).toContainEqual(
      changeFinding(changed),
    );
  });
});

describe('IA-004 a schema-invalid registry is never maintenance', () => {
  it('appending a receipt that the loader admits but the schema refuses is a finding', () => {
    const repo = seeded(registry(receipts(0, 1)));
    repo.writeRegistry(registry([receipt(0), receipt(1, { reason: '😀'.repeat(4) })]));
    const head = repo.commit();
    const result = repo.scan({ maxCommits: 1 });
    expect(result.findings).toEqual([changeFinding(head)]);
    expect(result.authorization_receipts?.declared).toBe(2);
  });

  it.each([
    { label: 'an unknown receipt field', bytes: serialize(registry([receipt(0, { extra: 1 })])) },
    {
      label: 'an unknown forbidden id',
      bytes: serialize(registry([receipt(0, { forbidden_id: 'forbid-x' })])),
    },
    { label: 'an abbreviated commit', bytes: serialize(registry([receipt(0, { commit: 'abc' })])) },
    {
      label: 'a non-Owner authority',
      bytes: serialize(registry([receipt(0, { authorized_by: 'Engineer' })])),
    },
    {
      label: 'an unknown root member',
      bytes: serialize(registry([receipt(0)], { wildcard: true })),
    },
    { label: 'a non-array collection', bytes: serialize(registry({ 0: receipt(0) })) },
    { label: 'malformed JSON bytes', bytes: '{ "schemaVersion": "1.0.0", "authorizations": [' },
  ])('an intermediate commit that appends $label is a finding for that commit', ({ bytes }) => {
    const repo = seeded(registry([]));
    repo.write(REGISTRY, bytes);
    const invalid = repo.commit();
    repo.writeRegistry(registry([]));
    repo.commit();
    expect(mutations(repo.scan({ sinceRef: repo.base }).findings)).toContainEqual(
      changeFinding(invalid),
    );
  });
});

describe('IA-005 other governed paths in a maintenance commit stay findings', () => {
  it('IA-005 appending a receipt and editing law/constitution.md is one finding', () => {
    const repo = seeded(registry([]));
    repo.write('law/constitution.md', '# Constitution\n');
    repo.commit('DEVAI Architect', 'chore: seed constitution');
    repo.writeRegistry(registry(receipts(0, 1)));
    repo.write('law/constitution.md', '# Constitution\n\nAmended.\n');
    const head = repo.commit();
    expect(repo.scan({ maxCommits: 1 }).findings).toEqual([changeFinding(head)]);
  });

  it.each([
    {
      label: 'a deleted law path that sorts after the registry',
      mutate: (repo: ReturnType<typeof seeded>) => repo.remove('law/schemas/zz-retired.json'),
      matched: 'git rm law/',
    },
    {
      label: 'an added product path',
      mutate: (repo: ReturnType<typeof seeded>) => repo.write('product/brief.md', 'brief\n'),
      matched: 'git add product/',
    },
  ])('the finding is evidenced by $label, not by the registry path', ({ mutate, matched }) => {
    const repo = seeded(registry([]));
    repo.write('law/schemas/zz-retired.json', '{}\n');
    repo.commit('DEVAI Architect', 'chore: seed retired schema');
    repo.writeRegistry(registry(receipts(0, 8)));
    mutate(repo);
    const head = repo.commit();
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([
      expect.objectContaining({
        forbidden_id: MUTATE,
        source: 'commit-change',
        ref: head,
        matched,
      }),
    ]);
  });

  it('an append-only change to the forbidden-action policy itself is a finding', () => {
    const repo = seeded(registry([]));
    const extended = {
      ...POLICY_DOCUMENT,
      actions: [
        ...POLICY_DOCUMENT.actions,
        {
          id: 'FORBID-FIXTURE-APPENDED',
          action: 'Fixture action',
          rationale: 'Fixture',
          severity: 'low',
          detect_patterns: ['\\bfixture-appended-command\\b'],
          safer_alternative: 'None',
        },
      ],
    };
    repo.write(POLICY, serialize(extended));
    const head = repo.commit();
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });

  it('an append-only change to the materialized policy copy is a finding', () => {
    const repo = seeded(registry([]));
    repo.write('.devai/config/forbidden-actions.json', POLICY_BYTES);
    repo.commit('DEVAI Architect', 'chore: materialize policy');
    const extended = {
      ...POLICY_DOCUMENT,
      actions: [...POLICY_DOCUMENT.actions, { ...POLICY_DOCUMENT.actions[0], id: 'FORBID-COPY' }],
    };
    repo.write('.devai/config/forbidden-actions.json', serialize(extended));
    const head = repo.commit('Fixture');
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });
});

describe('the exemption binds to the declared path and the declared policy only', () => {
  it('deleting the registry path is a finding', () => {
    const repo = seeded(registry(receipts(0, 2)));
    repo.remove(REGISTRY);
    const head = repo.commit();
    const { findings } = repo.scan({ maxCommits: 1 });
    expect(mutations(findings)).toEqual([changeFinding(head)]);
    expect(findings).toContainEqual(
      expect.objectContaining({ forbidden_id: 'FORBID-DELETE-AUTHORITY-DOCS', ref: head }),
    );
  });

  it('renaming the registry out of its path is a finding', () => {
    const repo = seeded(registry(receipts(0, 2)));
    repo.move(REGISTRY, 'law/policy/archived-authorizations.json');
    const head = repo.commit();
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });

  it('renaming an ungoverned file onto the registry path is a finding', () => {
    const repo = seeded(ABSENT);
    repo.writeRegistry(registry(receipts(0, 8)), 'drafts/receipts.json');
    repo.commit('Fixture', 'chore: draft receipts');
    repo.move('drafts/receipts.json', REGISTRY);
    const head = repo.commit();
    expect(repo.git('diff-tree', '--no-commit-id', '--name-status', '-r', '-M', head)).toMatch(
      /^R\d+\tdrafts\/receipts\.json\tlaw\/policy\/forbidden-action-authorizations\.json$/u,
    );
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([changeFinding(head)]);
  });

  it('an authorizationPath override that differs from the declared path gets no exemption', () => {
    const override = 'law/policy/team-authorizations.json';
    const repo = seeded(registry([]));
    repo.writeRegistry(registry([]), override);
    repo.commit('DEVAI Architect', 'chore: seed override registry');
    repo.writeRegistry(registry(receipts(0, 8)), override);
    const head = repo.commit();
    const result = repo.scan({ maxCommits: 1, authorizationPath: join(repo.root, override) });
    expect(result.authorization_receipts?.declared).toBe(8);
    expect(result.findings).toEqual([changeFinding(head)]);
  });

  it('a policy without the declared exemption leaves the #67 commit a finding', () => {
    const withoutExemption = serialize({
      ...POLICY_DOCUMENT,
      actions: POLICY_DOCUMENT.actions.map(
        ({ maintenance_exemptions: _dropped, ...action }) => action,
      ),
    });
    const repo = seeded(registry([]), withoutExemption);
    repo.writeRegistry(registry(receipts(0, 8)));
    const head = repo.commit();
    expect(repo.scan({ maxCommits: 1 }).findings).toEqual([changeFinding(head)]);
  });
});

describe('every other pattern keeps its finding on a maintenance commit', () => {
  it.each([
    ['git push +HEAD:topic', 'FORBID-FORCE-PUSH'],
    ['git commit --no-verify', 'FORBID-NO-VERIFY'],
    ['git commit --no-gpg-sign', 'FORBID-NO-GPG-SIGN'],
    ['git push origin main', 'FORBID-PUSH-MAIN'],
    ['git reset --hard HEAD', 'FORBID-RESET-HARD'],
    ['git rebase -i HEAD~2', 'FORBID-REBASE-I'],
    ['git branch -D obsolete', 'FORBID-DELETE-BRANCH'],
    ['rm -rf uncommitted-work', 'FORBID-RM-RF'],
    ['gh issue comment 12 --body message', 'FORBID-EXTERNAL-MESSAGES'],
    ['aws kms describe-key --key-id production', 'FORBID-SECRETS-PROD'],
    ['npm publish', 'FORBID-PUBLISH'],
    ['aws s3 rm s3://production/data', 'FORBID-AWS-DELETE-PROD'],
  ])('change evidence %s stays %s', (command, forbiddenId) => {
    const repo = seeded(registry([]));
    repo.writeRegistry(registry(receipts(0, 8)));
    repo.write('unsafe.txt', `${command}\n`);
    const head = repo.commit();
    expect(repo.scan({ maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({ forbidden_id: forbiddenId, source: 'commit-change', ref: head }),
    );
  });

  it('change evidence beside maintenance yields only its own finding', () => {
    const repo = seeded(registry([]));
    repo.writeRegistry(registry(receipts(0, 8)));
    repo.write('unsafe.txt', 'git push --force\n');
    const head = repo.commit();
    expect(repo.scan({ maxCommits: 1 }).findings).toEqual([
      expect.objectContaining({ forbidden_id: 'FORBID-FORCE-PUSH', ref: head }),
    ]);
  });

  it('a forbidden commit message on a maintenance commit stays a message finding', () => {
    const repo = seeded(registry([]));
    repo.writeRegistry(registry(receipts(0, 8)));
    const head = repo.commit(MAINTAINER, 'chore: record receipts then git push --force');
    expect(repo.scan({ maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-FORCE-PUSH',
        source: 'commit-message',
        ref: head,
      }),
    );
  });

  it('a message naming an invariant mutation on a maintenance commit stays a finding', () => {
    const repo = seeded(registry([]));
    repo.writeRegistry(registry(receipts(0, 8)));
    const head = repo.commit(MAINTAINER, 'chore: record receipts and git rm law/constitution.md');
    expect(mutations(repo.scan({ maxCommits: 1 }).findings)).toEqual([
      expect.objectContaining({ forbidden_id: MUTATE, source: 'commit-message', ref: head }),
    ]);
  });
});
