import { describe, expect, it } from 'vitest';
import * as policySupport from '../../src/authority/policy-support.js';
import { canonicalSha256 } from '../../src/authority/policy-support.js';
import { compileAdopterAuthorityExtension } from '../../src/authority/policy-adopter-extension.js';
import { canonicalRegistry, type RegistryEntry } from '../../src/define-command.js';

// ADR-AUT-0003 Compilation, Constitution gate, and IA-003/IA-004/IA-006: a pure compiler
// turns a validated authority block into one additive extension document with a fixed
// ladder (root 500, test 700, architecture 750), a fixed role per class, and a harness
// subject bound to that role; every malformed source is refused by a named code.
// ADR-AUT-0004 IA-004: each class rule carries exactly the registered write verbs of its class
// role, which the compiler takes as an input derived from the registry; `round run` and
// `task finish` appear on no rule.
const REPOSITORY_ID = 'detran';
const DEFAULT_TEST_SELECTORS = ['**/*.spec.*', '**/*.test.*', '**/test/**', '**/tests/**'];
const ROOTS = ['apps', 'backend', 'frontend', 'mobile', 'portal', 'src'];
const ARCHITECTURE_SELECTORS = ['**/ddl/**/*.sql', '**/blueprints/**'];

type ClassName = 'root' | 'test' | 'architecture';
type ClassVerbs = Record<ClassName, readonly string[]>;

/** The class verb sets ADR-AUT-0004 IA-004 freezes for the registered action registry. */
const CLASS_WRITE_VERBS: ClassVerbs = {
  root: ['task start'],
  test: ['check'],
  architecture: ['init apply architect', 'release export', 'round plan', 'round seal'],
};
const REMOVED_VERBS = ['round run', 'task finish'];

const REFERENCE_AUTHORITY = {
  extension_id: 'detran.path-authority',
  roots: ROOTS,
  classes: {
    test: { selectors: DEFAULT_TEST_SELECTORS },
    architecture: { selectors: ARCHITECTURE_SELECTORS },
  },
};

type Role = 'engineer' | 'inspector' | 'architect';

function compile(
  authority: unknown,
  overrides: {
    constitutionVersion?: string;
    defaultTestSelectors?: readonly string[];
    classWriteVerbs?: ClassVerbs;
  } = {},
) {
  // The class verb sets are an input of the pure compiler (ADR-AUT-0004 Derivation).
  const input = {
    policyId: 'detran.devai-adoption',
    policyVersion: '1.1.0',
    authority: authority as Parameters<typeof compileAdopterAuthorityExtension>[0]['authority'],
    constitutionVersion: overrides.constitutionVersion ?? '1.0.2',
    defaultTestSelectors: overrides.defaultTestSelectors ?? DEFAULT_TEST_SELECTORS,
    repositoryId: REPOSITORY_ID,
    classWriteVerbs: overrides.classWriteVerbs ?? CLASS_WRITE_VERBS,
  };
  return compileAdopterAuthorityExtension(input);
}

const CLASS_OF: Readonly<Record<Role, ClassName>> = {
  engineer: 'root',
  inspector: 'test',
  architect: 'architecture',
};

function expectedRule(id: string, precedence: 500 | 700 | 750, glob: string, role: Role) {
  return {
    rule_id: id,
    origin: 'additive-extension',
    precedence,
    action_ids: CLASS_WRITE_VERBS[CLASS_OF[role]],
    selector: {
      kind: 'fs',
      repository_id: REPOSITORY_ID,
      canonical_relative_path_glob: glob,
      operations: ['create', 'update', 'delete', 'rename'],
    },
    effect: 'allow',
    subjects: [
      { kind: 'human', roles: [role] },
      {
        kind: 'derived-machine',
        actor: 'harness',
        transition: 'harness-write',
        initiator: { allowed_roles: [role], preserve_in_context: true },
      },
    ],
    required_consent: { write: true, allow_publish: false, experimental: false },
    constitutional_anchors: [6, 7, 8, 9, 10],
    rationale: expect.any(String) as unknown,
  };
}

function expectedRules(
  roots: readonly string[],
  testSelectors: readonly string[],
  architectureSelectors: readonly string[],
) {
  return roots.flatMap((root) => [
    expectedRule(`adopter-path-root-${root}`, 500, root, 'engineer'),
    expectedRule(`adopter-path-root-${root}-tree`, 500, `${root}/**`, 'engineer'),
    ...testSelectors.map((selector, index) =>
      expectedRule(
        `adopter-path-test-${root}-${String(index + 1)}`,
        700,
        `${root}/${selector}`,
        'inspector',
      ),
    ),
    ...architectureSelectors.map((selector, index) =>
      expectedRule(
        `adopter-path-architecture-${root}-${String(index + 1)}`,
        750,
        `${root}/${selector}`,
        'architect',
      ),
    ),
  ]);
}

function refusal(code: string): RegExp {
  return new RegExp(`^ADOPTER_AUTHORITY_${code}(?::|$)`, 'u');
}

describe('adopter authority extension compiler: reference source', () => {
  it('compiles the reference source to the exact rule set of ADR-AUT-0003 and ADR-AUT-0004 in declared order', () => {
    const extension = compile(REFERENCE_AUTHORITY);
    expect(extension.extension_id).toBe('detran.path-authority');
    expect(extension.extension_version).toBe('1.1.0');
    expect(Object.keys(extension).sort()).toEqual(['extension_id', 'extension_version', 'rules']);
    expect(extension.rules).toHaveLength(48);
    expect(extension.rules).toEqual(
      expectedRules(ROOTS, DEFAULT_TEST_SELECTORS, ARCHITECTURE_SELECTORS),
    );
  });

  it('fixes the ladder and binds each class to one role for the human and the harness', () => {
    const { rules } = compile(REFERENCE_AUTHORITY);
    const roleAt = new Map<number, Set<string>>();
    for (const rule of rules) {
      const [human, harness] = rule.subjects as [
        { roles: string[] },
        { initiator: { allowed_roles: string[] } },
      ];
      expect(human.roles).toHaveLength(1);
      expect(harness.initiator.allowed_roles).toEqual(human.roles);
      const roles = roleAt.get(rule.precedence) ?? new Set<string>();
      roles.add(human.roles[0] ?? '');
      roleAt.set(rule.precedence, roles);
    }
    // IA-006: no valid source yields two rules of equal precedence with different roles.
    expect(
      Object.fromEntries([...roleAt].map(([precedence, roles]) => [precedence, [...roles]])),
    ).toEqual({ 500: ['engineer'], 700: ['inspector'], 750: ['architect'] });
    expect(new Set(rules.map((rule) => rule.rule_id)).size).toBe(rules.length);
  });

  it.each([
    ['adopter-path-root-', 500, CLASS_WRITE_VERBS.root],
    ['adopter-path-test-', 700, CLASS_WRITE_VERBS.test],
    ['adopter-path-architecture-', 750, CLASS_WRITE_VERBS.architecture],
  ] as const)(
    'carries on every %s rule at %i exactly the class verbs %j (IA-004)',
    (prefix, precedence, verbs) => {
      const rules = compile(REFERENCE_AUTHORITY).rules.filter((rule) =>
        rule.rule_id.startsWith(prefix),
      );
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.precedence, rule.rule_id).toBe(precedence);
        expect(rule.action_ids, rule.rule_id).toEqual(verbs);
      }
    },
  );

  it('names round run and task finish on no rule (IA-004)', () => {
    const { rules } = compile(REFERENCE_AUTHORITY);
    const named = rules.filter((rule) =>
      rule.action_ids.some((actionId) => REMOVED_VERBS.includes(actionId)),
    );
    expect(named.map((rule) => rule.rule_id)).toEqual([]);
  });

  it('compiles the sets the registry-derived package function yields to the frozen verbs', () => {
    const derive = (policySupport as Record<string, unknown>)['classWriteVerbs'];
    expect(typeof derive, 'policy-support.ts must export classWriteVerbs(entries)').toBe(
      'function',
    );
    const derived = (derive as (entries: readonly RegistryEntry[]) => ClassVerbs)(
      canonicalRegistry(),
    );
    expect(derived).toEqual(CLASS_WRITE_VERBS);
    expect(compile(REFERENCE_AUTHORITY, { classWriteVerbs: derived })).toEqual(
      compile(REFERENCE_AUTHORITY),
    );
  });

  it('takes the class verb sets as an input, so a changed set changes the rules and the digest', () => {
    const widened: ClassVerbs = {
      ...CLASS_WRITE_VERBS,
      test: ['check', 'synthetic inspector write'],
    };
    const reference = compile(REFERENCE_AUTHORITY);
    const changed = compile(REFERENCE_AUTHORITY, { classWriteVerbs: widened });
    for (const rule of changed.rules) {
      const verbs = rule.rule_id.startsWith('adopter-path-test-')
        ? widened.test
        : rule.rule_id.startsWith('adopter-path-architecture-')
          ? widened.architecture
          : widened.root;
      expect(rule.action_ids, rule.rule_id).toEqual(verbs);
    }
    expect(canonicalSha256(changed)).not.toBe(canonicalSha256(reference));
  });

  it('yields identical bytes and digest when compiled twice', () => {
    const first = compile(REFERENCE_AUTHORITY);
    const second = compile(structuredClone(REFERENCE_AUTHORITY));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(canonicalSha256(second)).toBe(canonicalSha256(first));
  });

  it('changes the extension digest when one selector changes', () => {
    const changed = structuredClone(REFERENCE_AUTHORITY);
    changed.classes.architecture.selectors = ['**/ddl/**/*.sql', '**/blueprint/**'];
    expect(canonicalSha256(compile(changed))).not.toBe(
      canonicalSha256(compile(REFERENCE_AUTHORITY)),
    );
  });

  it('defaults the extension id to <policy_id>.path-authority', () => {
    const { extension_id: extensionId, ...rest } = REFERENCE_AUTHORITY;
    expect(extensionId).toBe('detran.path-authority');
    expect(compile(rest).extension_id).toBe('detran.devai-adoption.path-authority');
  });

  it('takes the declared default test selectors when the test class is absent', () => {
    expect(compile({ roots: ['apps'] }).rules).toEqual(
      expectedRules(['apps'], DEFAULT_TEST_SELECTORS, []),
    );
    expect(
      compile({ roots: ['apps'] }, { defaultTestSelectors: ['**/__tests__/**'] }).rules,
    ).toEqual(expectedRules(['apps'], ['**/__tests__/**'], []));
  });

  it('uses the source test selectors instead of the defaults when the test class is declared', () => {
    expect(
      compile({ roots: ['apps'], classes: { test: { selectors: ['**/*.spec.*'] } } }).rules,
    ).toEqual(expectedRules(['apps'], ['**/*.spec.*'], []));
  });
});

describe('adopter authority extension compiler: constitution gate', () => {
  it.each(['1.0.1', '1.0.0', '0.9.9'])('refuses a block under constitution %s', (version) => {
    expect(() => compile(REFERENCE_AUTHORITY, { constitutionVersion: version })).toThrow(
      refusal('CONSTITUTION_VERSION'),
    );
  });

  it.each(['1.0.2', '1.0.10', '1.1.0', '2.0.0'])(
    'admits the block under constitution %s',
    (version) => {
      expect(compile(REFERENCE_AUTHORITY, { constitutionVersion: version }).rules).toHaveLength(48);
    },
  );
});

describe('adopter authority extension compiler: malformed sources (IA-003)', () => {
  const withRoots = (roots: string[]) => ({ ...REFERENCE_AUTHORITY, roots });
  const withSelector = (className: 'test' | 'architecture', selector: string) => ({
    ...REFERENCE_AUTHORITY,
    classes: {
      ...REFERENCE_AUTHORITY.classes,
      [className]: { selectors: [...REFERENCE_AUTHORITY.classes[className].selectors, selector] },
    },
  });

  it.each([
    ['a root with a separator', withRoots(['apps/web']), 'ROOT_INVALID'],
    ['a root with a backslash', withRoots(['apps\\web']), 'ROOT_INVALID'],
    ['the dot segment', withRoots(['.']), 'ROOT_INVALID'],
    ['the parent segment', withRoots(['..']), 'ROOT_INVALID'],
    ['a root with a glob metacharacter', withRoots(['app*']), 'ROOT_INVALID'],
    ['a root with a brace', withRoots(['{apps,src}']), 'ROOT_INVALID'],
    ['an empty root', withRoots(['']), 'ROOT_INVALID'],
    ['the core root law', withRoots(['law']), 'ROOT_CORE_PREFIX'],
    ['the core root product', withRoots(['apps', 'product']), 'ROOT_CORE_PREFIX'],
    ['the core root docs', withRoots(['docs']), 'ROOT_CORE_PREFIX'],
    ['the core root record', withRoots(['record']), 'ROOT_CORE_PREFIX'],
    ['the core root tests', withRoots(['tests']), 'ROOT_CORE_PREFIX'],
    ['the core root packages', withRoots(['packages']), 'ROOT_CORE_PREFIX'],
    ['the core root scratch', withRoots(['scratch']), 'ROOT_CORE_PREFIX'],
    ['the core root work', withRoots(['work']), 'ROOT_CORE_PREFIX'],
    ['the core root .devai', withRoots(['.devai']), 'ROOT_CORE_PREFIX'],
    ['the root prose file README.md', withRoots(['README.md']), 'ROOT_CORE_PREFIX'],
    ['the root prose file AGENTS.md', withRoots(['AGENTS.md']), 'ROOT_CORE_PREFIX'],
    ['the root prose file CLAUDE.md', withRoots(['CLAUDE.md']), 'ROOT_CORE_PREFIX'],
    ['two equal roots', withRoots(['apps', 'src', 'apps']), 'ROOT_DUPLICATE'],
    ['a root that prefixes a later root', withRoots(['app', 'apps']), 'ROOT_NESTED'],
    ['a root that prefixes an earlier root', withRoots(['apps', 'app']), 'ROOT_NESTED'],
    ['an absolute test selector', withSelector('test', '/apps/**/*.spec.ts'), 'SELECTOR_INVALID'],
    [
      'an absolute architecture selector',
      withSelector('architecture', '/ddl/**'),
      'SELECTOR_INVALID',
    ],
    ['a leading parent selector', withSelector('test', '../law/**'), 'SELECTOR_INVALID'],
    ['an inner parent selector', withSelector('architecture', '**/../law/**'), 'SELECTOR_INVALID'],
    ['a backslash selector', withSelector('test', '**\\*.spec.ts'), 'SELECTOR_INVALID'],
    ['a brace selector', withSelector('test', '**/*.{spec,test}.ts'), 'SELECTOR_INVALID'],
    ['an extglob + selector', withSelector('architecture', '**/+(ddl|sql)/**'), 'SELECTOR_INVALID'],
    ['an extglob @ selector', withSelector('test', '**/@(test)/**'), 'SELECTOR_INVALID'],
    ['an extglob ! selector', withSelector('test', '**/!(src)/**'), 'SELECTOR_INVALID'],
    ['a double-slash selector', withSelector('architecture', '**//ddl/**'), 'SELECTOR_INVALID'],
    ['a trailing-slash selector', withSelector('architecture', '**/ddl/'), 'SELECTOR_INVALID'],
    ['an empty selector', withSelector('test', ''), 'SELECTOR_INVALID'],
    [
      'a selector led by its own root',
      withSelector('test', 'apps/**/*.spec.ts'),
      'SELECTOR_ROOTED',
    ],
    [
      'a selector led by another root',
      withSelector('architecture', 'backend/**/*.sql'),
      'SELECTOR_ROOTED',
    ],
    [
      'a class outside the closed set',
      {
        ...REFERENCE_AUTHORITY,
        classes: { ...REFERENCE_AUTHORITY.classes, docs: { selectors: ['**/*.md'] } },
      },
      'CLASS_UNKNOWN',
    ],
    [
      'an architecture class with an empty selector list',
      { ...REFERENCE_AUTHORITY, classes: { architecture: { selectors: [] } } },
      'ARCHITECTURE_SELECTORS_REQUIRED',
    ],
    [
      'an architecture class without a selector list',
      { ...REFERENCE_AUTHORITY, classes: { architecture: {} } },
      'ARCHITECTURE_SELECTORS_REQUIRED',
    ],
    [
      'the package extension id',
      { ...REFERENCE_AUTHORITY, extension_id: 'devai-adopter-authority' },
      'EXTENSION_ID_RESERVED',
    ],
  ])('refuses %s with its named code and emits no rule', (_label, authority, code) => {
    let emitted: unknown;
    expect(() => {
      emitted = compile(authority);
    }).toThrow(refusal(code));
    expect(emitted).toBeUndefined();
  });
});
