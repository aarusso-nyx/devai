// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Inspector acceptance for ADR-AUT-0003 IA-001, IA-009, and IA-002: the reference source is
// bound through `init bind --adopter-policy` in a fixture repository pinned at constitution
// 1.0.2, and every cell of the decision matrix is a real broker decision over the
// materialized authority policy (bootstrap_policy false), requested by each role as the
// human subject and as the harness subject that role initiates. No decision is computed by
// re-implementing the ladder: the broker loads the bound policy and resolves the write.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseConstitutionVersion } from '@devai-nyx/skills';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry, type RegistryEntry } from '../../src/define-command.js';
import { resolveCliVersion } from '../../src/version.js';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/adopter-path-authority');
const SOURCE = 'law/policy/devai-adoption.json';
const POLICY = '.devai/config/authority-policy.json';

type Role = 'engineer' | 'inspector' | 'architect';
type SubjectKind = 'human' | 'harness';
type Verb = 'engineer' | 'architect';
type Decision = { readonly outcome: 'allow' } | { readonly outcome: 'deny'; readonly code: string };

const ROLES: readonly Role[] = ['engineer', 'inspector', 'architect'];
const SUBJECTS: readonly SubjectKind[] = ['human', 'harness'];

const ALLOW: Decision = { outcome: 'allow' };
const deny = (code: string): Decision => ({ outcome: 'deny', code });
const SUBJECT_DENIED = deny('AUTHORITY_SUBJECT_DENIED');
const ACTION_DENIED = deny('AUTHORITY_ACTION_DENIED');
const UNCLASSIFIED = deny('UNCLASSIFIED_RESOURCE');
const ESCAPE = deny('AUTHORITY_FS_SYMLINK_ESCAPE');
const TARGET_INVALID = deny('AUTHORITY_FS_TARGET_INVALID');

const entries: readonly RegistryEntry[] = canonicalRegistry();
let repo = '';
let outside = '';

async function runCli(args: readonly string[]) {
  vi.resetModules();
  const previous = {
    argv: process.argv,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args, '--format', 'json'];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await import('../../src/bin.js');
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

async function expectCliPass(args: readonly string[]) {
  const result = await runCli(args);
  expect(result.exit, `${args.join(' ')}\n${result.stderr}`).toBe(0);
  return result;
}

function put(path: string, content: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

/** The registry entry of the verb, with its subject replaced by the requested kind and role. */
function entryFor(verb: Verb, subject: SubjectKind, role: Role): RegistryEntry {
  const name = verb === 'engineer' ? 'task start' : 'round plan';
  const base = entries.find((candidate) => candidate.name === name);
  if (base === undefined) throw new Error(`missing action ${name}`);
  return {
    ...base,
    authority_contract: {
      ...base.authority_contract,
      subject:
        subject === 'human'
          ? { kind: 'human', allowed_roles: [role] }
          : {
              kind: 'derived-machine',
              actor: 'harness',
              transition: 'harness-write',
              initiator: { allowed_roles: [role], preserve_in_context: true },
            },
    },
  } as RegistryEntry;
}

function brokerFor(verb: Verb, subject: SubjectKind, role: Role) {
  const entry = entryFor(verb, subject, role);
  const argv =
    verb === 'engineer'
      ? ['task', 'start', '--round', 'R-0007', '--task', 'TASK-7001']
      : ['round', 'plan', '--documents', 'cli'];
  return createAuthorityHostBroker({
    entry,
    entries,
    argv: [process.execPath, 'devai', ...argv, '--as-role', role, '--write'],
    role,
    declaration: { as_role: role },
    repository_root: repo,
    package_version: resolveCliVersion(),
    bootstrap_policy: false,
  });
}

function codeOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/u.exec(message)?.[0] ?? message;
}

/** One governed write through the broker; the host effect never reaches the disk. */
function decide(verb: Verb, subject: SubjectKind, role: Role, target: unknown): Decision {
  const host = brokerFor(verb, subject, role);
  let applied = false;
  try {
    const result = host.scope.apply_effect(
      { kind: 'filesystem', symbol: 'writeFileSync', arguments: [target, 'fixture\n'] },
      () => {
        applied = true;
        return 'applied';
      },
    );
    expect(result).toBe('applied');
    expect(applied).toBe(true);
    return ALLOW;
  } catch (error) {
    expect(applied, `a refused write must not apply: ${String(target)}`).toBe(false);
    return deny(codeOf(error));
  } finally {
    host.dispose();
  }
}

const at = (path: string): string => `${repo}/${path}`;

function policyRules(): Array<Record<string, unknown>> {
  const document = JSON.parse(readFileSync(join(repo, POLICY), 'utf8')) as {
    rules: Array<Record<string, unknown>>;
  };
  return document.rules;
}

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'devai-adopter-path-authority-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'devai-adopter-path-outside-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await expectCliPass([
    'init',
    'bind',
    '--full',
    '--tier',
    'tier1',
    '--target',
    repo,
    '--as-role',
    'architect',
    '--write',
  ]);
  put(SOURCE, readFileSync(join(FIXTURES, 'reference.json'), 'utf8'));
  await expectCliPass([
    'init',
    'bind',
    '--adopter-policy',
    SOURCE,
    '--target',
    repo,
    '--as-role',
    'architect',
    '--write',
  ]);
  // Present roots and an undeclared directory; `portal` is declared and left absent.
  for (const path of [
    'apps/dashboard/web/src/.keep',
    'backend/domains/ops/src/.keep',
    'backend/ddl/.keep',
    'vendor/.keep',
    'docs/.keep',
  ]) {
    put(path, '');
  }
  symlinkSync(outside, join(repo, 'apps/escape'));
}, 120_000);

afterAll(() => {
  for (const path of [repo, outside]) {
    if (path !== '') rmSync(path, { recursive: true, force: true });
  }
});

describe('ADR-AUT-0003 fixture binding', () => {
  it('pins constitution 1.0.2 and binds the reference source', () => {
    expect(
      parseConstitutionVersion(readFileSync(join(repo, '.devai/pin/constitution.md'), 'utf8')),
    ).toBe('1.0.2');
    expect(
      JSON.parse(readFileSync(join(repo, '.devai/config/adopter-policy-binding.json'), 'utf8')),
    ).toMatchObject({ policy_id: 'detran.devai-adoption', source_path: SOURCE });
    expect(existsSync(join(repo, 'portal'))).toBe(false);
  });

  // The "decided by" column of the matrix names these rules; they are read from the
  // materialized policy, never recomputed here.
  it.each([
    ['adopter-path-root-apps-tree', 500, 'apps/**', 'engineer'],
    ['adopter-path-root-backend-tree', 500, 'backend/**', 'engineer'],
    ['adopter-path-root-portal-tree', 500, 'portal/**', 'engineer'],
    ['adopter-path-test-apps-1', 700, 'apps/**/*.spec.*', 'inspector'],
    ['adopter-path-test-backend-2', 700, 'backend/**/*.test.*', 'inspector'],
    ['adopter-path-test-backend-4', 700, 'backend/**/tests/**', 'inspector'],
    ['adopter-path-architecture-backend-1', 750, 'backend/**/ddl/**/*.sql', 'architect'],
    ['adopter-path-architecture-backend-2', 750, 'backend/**/blueprints/**', 'architect'],
  ] as const)(
    'materializes %s at %i over %s for the %s role only',
    (ruleId, precedence, glob, role) => {
      const rule = policyRules().find((candidate) => candidate['rule_id'] === ruleId);
      expect(rule, ruleId).toMatchObject({
        origin: 'additive-extension',
        precedence,
        effect: 'allow',
        action_ids: ['round run', 'task finish', 'task start'],
        selector: { kind: 'fs', canonical_relative_path_glob: glob },
        subjects: [
          { kind: 'human', roles: [role] },
          {
            kind: 'derived-machine',
            actor: 'harness',
            initiator: { allowed_roles: [role] },
          },
        ],
      });
    },
  );
});

// Each row: path, then the decision for Engineer, Inspector, and Architect under the
// Engineer write verb (`task start`), identical for the human subject and the harness.
const MATRIX: ReadonlyArray<readonly [string, string, Decision, Decision, Decision]> = [
  ['IA-001', 'apps/dashboard/web/src/example.ts', ALLOW, SUBJECT_DENIED, SUBJECT_DENIED],
  ['IA-001', 'backend/domains/ops/src/example.ts', ALLOW, SUBJECT_DENIED, SUBJECT_DENIED],
  ['IA-001', 'apps/dashboard/web/README.md', ALLOW, SUBJECT_DENIED, SUBJECT_DENIED],
  ['IA-001', 'backend/domains/ops/README.md', ALLOW, SUBJECT_DENIED, SUBJECT_DENIED],
  ['IA-009', 'apps/dashboard/web/src/example.spec.ts', SUBJECT_DENIED, ALLOW, SUBJECT_DENIED],
  ['IA-009', 'backend/domains/ops/tests/example.test.ts', SUBJECT_DENIED, ALLOW, SUBJECT_DENIED],
  ['IA-009', 'backend/ddl/example.sql', SUBJECT_DENIED, SUBJECT_DENIED, ALLOW],
  ['IA-009', 'backend/blueprints/ops.md', SUBJECT_DENIED, SUBJECT_DENIED, ALLOW],
  ['IA-002', 'vendor/x.ts', UNCLASSIFIED, UNCLASSIFIED, UNCLASSIFIED],
  ['IA-002', 'portal/src/example.ts', ALLOW, SUBJECT_DENIED, SUBJECT_DENIED],
];

const CASES = MATRIX.flatMap(([record, path, ...decisions]) =>
  ROLES.flatMap((role, index) =>
    SUBJECTS.map((subject) => [record, path, role, subject, decisions[index] as Decision] as const),
  ),
);

describe('IA-001, IA-009, IA-002: the matrix under the Engineer write verb', () => {
  it.each(CASES)('%s %s as %s (%s subject)', (_record, path, role, subject, expected) => {
    expect(decide('engineer', subject, role, at(path))).toEqual(expected);
  });
});

describe('IA-009: docs/ stays Architect under the core row', () => {
  // The core docs rows admit only the human Architect verbs; the extension never names docs.
  it.each(ROLES.flatMap((role) => SUBJECTS.map((subject) => [role, subject] as const)))(
    'docs/index.md under the Engineer verb as %s (%s subject) reads AUTHORITY_ACTION_DENIED',
    (role, subject) => {
      expect(decide('engineer', subject, role, at('docs/index.md'))).toEqual(ACTION_DENIED);
    },
  );

  it.each([
    ['architect', ALLOW],
    ['engineer', SUBJECT_DENIED],
    ['inspector', SUBJECT_DENIED],
  ] as const)(
    'docs/index.md under the Architect verb as the human %s reads %j',
    (role, expected) => {
      expect(decide('architect', 'human', role, at('docs/index.md'))).toEqual(expected);
    },
  );

  // The matrix doc says the harness reads the same outcome as the human role; the core
  // docs rows bind only the human Architect, so an Architect-initiated harness is refused.
  it.each(ROLES)(
    'docs/index.md under the Architect verb as the harness initiated by %s reads AUTHORITY_SUBJECT_DENIED',
    (role) => {
      expect(decide('architect', 'harness', role, at('docs/index.md'))).toEqual(SUBJECT_DENIED);
    },
  );

  it('an extension rule never names or shadows docs/', () => {
    const extensionGlobs = policyRules()
      .filter((rule) => String(rule['rule_id']).startsWith('adopter-path-'))
      .map((rule) =>
        String((rule['selector'] as Record<string, unknown>)['canonical_relative_path_glob']),
      );
    expect(extensionGlobs.length).toBeGreaterThan(0);
    expect(extensionGlobs.filter((glob) => glob === 'docs' || glob.startsWith('docs/'))).toEqual(
      [],
    );
  });
});

describe('IA-002: escapes are refused by canonicalization before any rule', () => {
  const escapes = [
    ['a .. target that leaves the repository', () => at('apps/../../outside.md'), ESCAPE],
    ['a symlink under apps/ that resolves outside', () => at('apps/escape/x.ts'), ESCAPE],
    ['an empty target', () => '', TARGET_INVALID],
    ['a target that is not a path', () => undefined, TARGET_INVALID],
  ] as const;

  it.each(
    escapes.flatMap(([label, target, expected]) =>
      ROLES.flatMap((role) =>
        SUBJECTS.map((subject) => [label, role, subject, target, expected] as const),
      ),
    ),
  )('%s as %s (%s subject)', (_label, role, subject, target, expected) => {
    expect(decide('engineer', subject, role, target())).toEqual(expected);
  });

  it('a .. target that stays inside canonicalizes to the core law/ row, never the apps root', () => {
    for (const role of ROLES) {
      for (const verb of ['engineer', 'architect'] as const) {
        const direct = decide(verb, 'human', role, at('law/x.md'));
        expect(decide(verb, 'human', role, at('apps/../law/x.md')), `${verb} ${role}`).toEqual(
          direct,
        );
      }
    }
    expect(decide('architect', 'human', 'architect', at('apps/../law/x.md'))).toEqual(ALLOW);
    expect(decide('engineer', 'human', 'engineer', at('apps/../law/x.md'))).toEqual(ACTION_DENIED);
  });
});

describe('IA-002: a declared but absent root grants exactly what a present root grants', () => {
  it.each(ROLES.flatMap((role) => SUBJECTS.map((subject) => [role, subject] as const)))(
    'portal/ reads as apps/ for %s (%s subject)',
    (role, subject) => {
      for (const path of ['src/example.ts', 'src/example.spec.ts', 'README.md']) {
        expect(decide('engineer', subject, role, at(`portal/${path}`)), path).toEqual(
          decide('engineer', subject, role, at(`apps/${path}`)),
        );
      }
      expect(existsSync(join(repo, 'portal'))).toBe(false);
    },
  );

  it('an undeclared directory present in the tree grants nothing', () => {
    expect(existsSync(join(repo, 'vendor'))).toBe(true);
    for (const role of ROLES) {
      expect(decide('engineer', 'harness', role, at('vendor/x.ts'))).toEqual(UNCLASSIFIED);
    }
  });
});
