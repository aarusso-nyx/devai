// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Inspector acceptance for ADR-AUT-0004 IA-001, IA-002, IA-003, and the declaration half of
// IA-005 (over ADR-AUT-0003 IA-001, IA-009, and IA-002): the reference source is bound through
// `init bind --adopter-policy` in a fixture repository pinned at constitution 1.0.2, and every
// cell of the decision matrix is a real broker decision over the materialized authority policy
// (bootstrap_policy false), requested with the registry entry exactly as registered: `check`
// declared by the Inspector, `task start` declared by the Engineer, and `round seal` declared
// by the Architect. No subject is substituted and no decision is computed by re-implementing
// the ladder: the broker loads the bound policy and resolves the write, and the resolution it
// reached is read back unchanged to name the matched rules.
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

type Resolution = { readonly outcome: string; readonly code: string; readonly matched: string[] };

// A passthrough over the policy resolver: it returns the resolver's own result unchanged and
// records it, so a cell names the rules the broker matched without recomputing them.
const resolutions = vi.hoisted(() => [] as Resolution[]);

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const resolve = actual['resolveAuthorityPolicy'] as (...args: unknown[]) => unknown;
  return {
    ...actual,
    resolveAuthorityPolicy: (...args: unknown[]) => {
      const result = resolve(...args) as {
        outcome?: unknown;
        code?: unknown;
        matched_rule_ids?: unknown;
      };
      resolutions.push({
        outcome: String(result.outcome),
        code: String(result.code),
        matched: Array.isArray(result.matched_rule_ids)
          ? result.matched_rule_ids.map((id) => String(id))
          : [],
      });
      return result;
    },
  };
});

const FIXTURES = resolve(import.meta.dirname, '../fixtures/adopter-path-authority');
const SOURCE = 'law/policy/devai-adoption.json';
const POLICY = '.devai/config/authority-policy.json';

type Role = 'engineer' | 'inspector' | 'architect';
type Verb = 'task start' | 'check' | 'round seal';
type Decision = { readonly outcome: 'allow' } | { readonly outcome: 'deny'; readonly code: string };
type Outcome = { readonly decision: Decision; readonly matched: string[] | undefined };

/** The class role and the registered verb it declares (ADR-AUT-0004 Verbs by class). */
const ROLE_VERBS: ReadonlyArray<readonly [Role, Verb]> = [
  ['engineer', 'task start'],
  ['inspector', 'check'],
  ['architect', 'round seal'],
];
const VERBS: readonly Verb[] = ROLE_VERBS.map(([, verb]) => verb);

const ARGV: Readonly<Record<Verb, readonly string[]>> = {
  'task start': ['task', 'start', '--round', 'R-0007', '--task', 'TASK-7001'],
  check: ['check', '--suite', 'quick'],
  'round seal': ['round', 'seal'],
};

const CLASS_VERBS = {
  root: ['task start'],
  test: ['check'],
  architecture: ['init apply architect', 'release export', 'round plan', 'round seal'],
} as const;

const ALLOW: Decision = { outcome: 'allow' };
const deny = (code: string): Decision => ({ outcome: 'deny', code });
const ACTION_DENIED = deny('AUTHORITY_ACTION_DENIED');
const HUMAN_ROLE_DENIED = deny('AUTHORITY_HUMAN_ROLE_DENIED');
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

/** The registry entry of the verb exactly as registered; its subject is never replaced. */
function registered(verb: Verb): RegistryEntry {
  const entry = entries.find((candidate) => candidate.name === verb);
  if (entry === undefined) throw new Error(`missing action ${verb}`);
  return entry;
}

function brokerFor(verb: Verb, role: Role) {
  return createAuthorityHostBroker({
    entry: registered(verb),
    entries,
    argv: [process.execPath, 'devai', ...ARGV[verb], '--as-role', role, '--write'],
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

/**
 * One governed write through the broker; the host effect never reaches the disk. `matched`
 * is the rule ids of the resolution the broker reached, or undefined when the request was
 * refused before any rule was consulted.
 */
function decideWith(verb: Verb, role: Role, target: unknown): Outcome {
  resolutions.length = 0;
  let applied = false;
  let decision: Decision;
  let host: ReturnType<typeof brokerFor> | undefined;
  try {
    host = brokerFor(verb, role);
    const result = host.scope.apply_effect(
      { kind: 'filesystem', symbol: 'writeFileSync', arguments: [target, 'fixture\n'] },
      () => {
        applied = true;
        return 'applied';
      },
    );
    expect(result).toBe('applied');
    expect(applied).toBe(true);
    decision = ALLOW;
  } catch (error) {
    expect(applied, `a refused write must not apply: ${String(target)}`).toBe(false);
    decision = deny(codeOf(error));
  } finally {
    host?.dispose();
  }
  const reached = resolutions.at(-1);
  if (reached !== undefined) {
    expect(reached.outcome, `${verb} ${role} ${String(target)}`).toBe(decision.outcome);
    if (decision.outcome === 'deny') expect(reached.code).toBe(decision.code);
  }
  return { decision, matched: reached === undefined ? undefined : [...reached.matched].sort() };
}

function decide(verb: Verb, role: Role, target: unknown): Decision {
  return decideWith(verb, role, target).decision;
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

describe('ADR-AUT-0003 fixture binding under the ADR-AUT-0004 class verbs', () => {
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
    ['adopter-path-root-apps-tree', 500, 'apps/**', 'engineer', CLASS_VERBS.root],
    ['adopter-path-root-backend-tree', 500, 'backend/**', 'engineer', CLASS_VERBS.root],
    ['adopter-path-root-portal-tree', 500, 'portal/**', 'engineer', CLASS_VERBS.root],
    ['adopter-path-test-apps-1', 700, 'apps/**/*.spec.*', 'inspector', CLASS_VERBS.test],
    ['adopter-path-test-backend-2', 700, 'backend/**/*.test.*', 'inspector', CLASS_VERBS.test],
    ['adopter-path-test-backend-4', 700, 'backend/**/tests/**', 'inspector', CLASS_VERBS.test],
    [
      'adopter-path-architecture-backend-1',
      750,
      'backend/**/ddl/**/*.sql',
      'architect',
      CLASS_VERBS.architecture,
    ],
    [
      'adopter-path-architecture-backend-2',
      750,
      'backend/**/blueprints/**',
      'architect',
      CLASS_VERBS.architecture,
    ],
  ] as const)(
    'materializes %s at %i over %s for the %s role only, under its class verbs',
    (ruleId, precedence, glob, role, verbs) => {
      const rule = policyRules().find((candidate) => candidate['rule_id'] === ruleId);
      expect(rule, ruleId).toMatchObject({
        origin: 'additive-extension',
        precedence,
        effect: 'allow',
        action_ids: [...verbs],
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

/** The precedence of each materialized rule, read from the bound policy. */
function precedenceOf(ruleId: string): unknown {
  return policyRules().find((rule) => rule['rule_id'] === ruleId)?.['precedence'];
}

// Each row: record, path, the decision for the Engineer under `task start`, the Inspector under
// `check`, and the Architect under `round seal`, then the rules that decide every cell and
// their precedence. An allow names them as matched; a deny names them as the classified rules
// that carry no requested verb, and never a rule of a lower precedence.
const MATRIX: ReadonlyArray<
  readonly [string, string, Decision, Decision, Decision, readonly string[], number]
> = [
  [
    'IA-003',
    'apps/dashboard/web/src/example.ts',
    ALLOW,
    ACTION_DENIED,
    ACTION_DENIED,
    ['adopter-path-root-apps-tree'],
    500,
  ],
  [
    'IA-003',
    'backend/domains/ops/src/example.ts',
    ALLOW,
    ACTION_DENIED,
    ACTION_DENIED,
    ['adopter-path-root-backend-tree'],
    500,
  ],
  [
    'IA-003',
    'apps/dashboard/web/README.md',
    ALLOW,
    ACTION_DENIED,
    ACTION_DENIED,
    ['adopter-path-root-apps-tree'],
    500,
  ],
  [
    'IA-003',
    'backend/domains/ops/README.md',
    ALLOW,
    ACTION_DENIED,
    ACTION_DENIED,
    ['adopter-path-root-backend-tree'],
    500,
  ],
  [
    'IA-001',
    'apps/dashboard/web/src/example.spec.ts',
    ACTION_DENIED,
    ALLOW,
    ACTION_DENIED,
    ['adopter-path-test-apps-1'],
    700,
  ],
  [
    'IA-001',
    'backend/domains/ops/tests/example.test.ts',
    ACTION_DENIED,
    ALLOW,
    ACTION_DENIED,
    ['adopter-path-test-backend-2', 'adopter-path-test-backend-4'],
    700,
  ],
  [
    'IA-002',
    'backend/ddl/example.sql',
    ACTION_DENIED,
    ACTION_DENIED,
    ALLOW,
    ['adopter-path-architecture-backend-1'],
    750,
  ],
  [
    'IA-002',
    'backend/blueprints/ops.md',
    ACTION_DENIED,
    ACTION_DENIED,
    ALLOW,
    ['adopter-path-architecture-backend-2'],
    750,
  ],
  [
    'IA-003',
    'portal/src/example.ts',
    ALLOW,
    ACTION_DENIED,
    ACTION_DENIED,
    ['adopter-path-root-portal-tree'],
    500,
  ],
];

const CASES = MATRIX.flatMap(([record, path, ...rest]) => {
  const decisions = rest.slice(0, 3) as Decision[];
  const [ruleIds, precedence] = rest.slice(3) as [readonly string[], number];
  return ROLE_VERBS.map(
    ([role, verb], index) =>
      [record, path, verb, role, decisions[index] as Decision, ruleIds, precedence] as const,
  );
});

describe('IA-001, IA-002, IA-003: the matrix under the registered verbs', () => {
  it.each(CASES)(
    '%s %s under %s declared by the %s',
    (_record, path, verb, role, expected, ruleIds, precedence) => {
      const { decision, matched } = decideWith(verb, role, at(path));
      expect(decision).toEqual(expected);
      expect(matched, 'the decision names exactly the rules of the class precedence').toEqual(
        [...ruleIds].sort(),
      );
      for (const ruleId of matched ?? []) expect(precedenceOf(ruleId), ruleId).toBe(precedence);
    },
  );
});

// IA-005: the registry subjects and the class verbs name the same role, so a cross-role
// request under a class verb is refused at the declaration boundary before any rule.
describe('IA-005: a cross-role declaration is refused before any rule', () => {
  it.each([
    ['task start', 'inspector', 'apps/dashboard/web/src/example.ts'],
    ['task start', 'inspector', 'apps/dashboard/web/src/example.spec.ts'],
    ['check', 'engineer', 'apps/dashboard/web/src/example.spec.ts'],
    ['check', 'engineer', 'apps/dashboard/web/src/example.ts'],
    ['round seal', 'engineer', 'backend/ddl/example.sql'],
    ['round seal', 'inspector', 'backend/ddl/example.sql'],
  ] as const)('%s declared by the %s on %s', (verb, role, path) => {
    expect(decideWith(verb, role, at(path))).toEqual({
      decision: HUMAN_ROLE_DENIED,
      matched: undefined,
    });
  });
});

describe('IA-003: docs/ stays Architect under the core row', () => {
  // The core docs rows admit only the human Architect verbs; the extension never names docs.
  it.each([
    ['task start', 'engineer', ACTION_DENIED],
    ['check', 'inspector', ACTION_DENIED],
    ['round seal', 'architect', ALLOW],
  ] as const)('docs/index.md under %s declared by the %s reads %j', (verb, role, expected) => {
    const { decision, matched } = decideWith(verb, role, at('docs/index.md'));
    expect(decision).toEqual(expected);
    expect(matched?.every((ruleId) => !ruleId.startsWith('adopter-path-'))).toBe(true);
    expect(matched).toContain('core-architect-docs');
  });

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

describe('IA-003: an undeclared directory present in the tree grants nothing', () => {
  it.each(ROLE_VERBS)('vendor/x.ts declared by the %s under %s', (role, verb) => {
    expect(existsSync(join(repo, 'vendor'))).toBe(true);
    expect(decideWith(verb, role, at('vendor/x.ts'))).toEqual({
      decision: UNCLASSIFIED,
      matched: [],
    });
  });
});

describe('IA-003: escapes are refused by canonicalization before any rule', () => {
  const escapes = [
    ['a .. target that leaves the repository', () => at('apps/../../outside.md'), ESCAPE],
    ['a symlink under apps/ that resolves outside', () => at('apps/escape/x.ts'), ESCAPE],
    ['an empty target', () => '', TARGET_INVALID],
    ['a target that is not a path', () => undefined, TARGET_INVALID],
  ] as const;

  it.each(
    escapes.flatMap(([label, target, expected]) =>
      ROLE_VERBS.map(([role, verb]) => [label, verb, role, target, expected] as const),
    ),
  )('%s under %s declared by the %s', (_label, verb, role, target, expected) => {
    expect(decideWith(verb, role, target())).toEqual({ decision: expected, matched: undefined });
  });

  it('a .. target that stays inside canonicalizes to the core law/ row, never the apps root', () => {
    for (const [role, verb] of ROLE_VERBS) {
      const direct = decideWith(verb, role, at('law/x.md'));
      const dotted = decideWith(verb, role, at('apps/../law/x.md'));
      expect(dotted, `${verb} ${role}`).toEqual(direct);
      expect(dotted.matched?.some((ruleId) => ruleId.startsWith('adopter-path-'))).not.toBe(true);
    }
    expect(decide('round seal', 'architect', at('apps/../law/x.md'))).toEqual(ALLOW);
    expect(decide('task start', 'engineer', at('apps/../law/x.md'))).toEqual(ACTION_DENIED);
  });
});

describe('IA-003: a declared but absent root grants exactly what a present root grants', () => {
  it.each(ROLE_VERBS)('portal/ reads as apps/ for the %s under %s', (role, verb) => {
    for (const path of ['src/example.ts', 'src/example.spec.ts', 'README.md']) {
      expect(decide(verb, role, at(`portal/${path}`)), path).toEqual(
        decide(verb, role, at(`apps/${path}`)),
      );
    }
    expect(existsSync(join(repo, 'portal'))).toBe(false);
  });

  it('every registered verb is driven exactly as registered', () => {
    for (const verb of VERBS) {
      expect(registered(verb)).toBe(entries.find((entry) => entry.name === verb));
    }
  });
});
