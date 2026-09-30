import { defined, fsSelector, harnessSubject, rule } from './policy-support.js';

/**
 * ADR-AUT-0003 compiler: turns a validated adopter `authority` block into one additive
 * extension document with a fixed class ladder (root 500 Engineer, test 700 Inspector,
 * architecture 750 Architect) and a harness subject bound to each class role. The
 * function is pure: the same inputs yield the same rules in the same order.
 */

export interface AdopterAuthorityBlock {
  readonly extension_id?: string;
  readonly roots: readonly string[];
  readonly classes?: {
    readonly test?: { readonly selectors: readonly string[] };
    readonly architecture?: { readonly selectors: readonly string[] };
  };
}

type Role = 'engineer' | 'inspector' | 'architect';

export type AdopterAuthorityRule = NonNullable<ReturnType<typeof rule>>;

export interface AdopterAuthorityExtension {
  readonly extension_id: string;
  readonly extension_version: string;
  readonly rules: AdopterAuthorityRule[];
}

/**
 * The package default test selectors ADR-AUT-0003 states. Until the defaults law source
 * `law/policy/adopter-defaults/path-authority-classes.json` lands (R-0502), callers take
 * them from this constant.
 */
export const DEFAULT_ADOPTER_TEST_SELECTORS: readonly string[] = Object.freeze([
  '**/*.spec.*',
  '**/*.test.*',
  '**/test/**',
  '**/tests/**',
]);

/** The minimum bound constitution version that admits an authority block (ADR-GOV-0024). */
export const ADOPTER_AUTHORITY_MIN_CONSTITUTION = '1.0.2';

const RESERVED_EXTENSION_ID = 'devai-adopter-authority';

/** First segments of the Article 6 core table that no adopter root may equal. */
const CORE_TABLE_SEGMENTS: ReadonlySet<string> = new Set([
  'law',
  'product',
  'docs',
  'record',
  'tests',
  'packages',
  'scratch',
  'work',
  '.devai',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
]);

/** The Engineer write verbs the registry declares, as `adopter-engineer-packages` uses. */
const ENGINEER_WRITE_VERBS: readonly string[] = ['round run', 'task finish', 'task start'];

const CLASS_KEYS: ReadonlySet<string> = new Set(['test', 'architecture']);

// Each refusal code is a quoted literal so the error-code reference lists it.
const CODES = {
  constitutionVersion: 'ADOPTER_AUTHORITY_CONSTITUTION_VERSION',
  rootInvalid: 'ADOPTER_AUTHORITY_ROOT_INVALID',
  rootCorePrefix: 'ADOPTER_AUTHORITY_ROOT_CORE_PREFIX',
  rootDuplicate: 'ADOPTER_AUTHORITY_ROOT_DUPLICATE',
  rootNested: 'ADOPTER_AUTHORITY_ROOT_NESTED',
  selectorInvalid: 'ADOPTER_AUTHORITY_SELECTOR_INVALID',
  selectorRooted: 'ADOPTER_AUTHORITY_SELECTOR_ROOTED',
  classUnknown: 'ADOPTER_AUTHORITY_CLASS_UNKNOWN',
  architectureSelectorsRequired: 'ADOPTER_AUTHORITY_ARCHITECTURE_SELECTORS_REQUIRED',
  extensionIdReserved: 'ADOPTER_AUTHORITY_EXTENSION_ID_RESERVED',
} as const;

function refuse(code: (typeof CODES)[keyof typeof CODES], detail: string): never {
  throw new Error(`${code}:${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function semver(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function admitsAuthority(constitutionVersion: string): boolean {
  const actual = semver(constitutionVersion);
  const minimum = semver(ADOPTER_AUTHORITY_MIN_CONSTITUTION) as [number, number, number];
  if (actual === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] as number) - (minimum[index] as number);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function validRoots(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    refuse(CODES.rootInvalid, 'roots must be a non-empty list of single path segments');
  }
  const roots = value.map((root: unknown) => {
    if (
      typeof root !== 'string' ||
      root === '.' ||
      root === '..' ||
      !/^[A-Za-z0-9_.-]+$/u.test(root)
    ) {
      refuse(CODES.rootInvalid, JSON.stringify(root));
    }
    return root;
  });
  for (const root of roots) {
    if (CORE_TABLE_SEGMENTS.has(root)) refuse(CODES.rootCorePrefix, root);
  }
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root)) refuse(CODES.rootDuplicate, root);
    seen.add(root);
  }
  for (const root of roots) {
    const nested = roots.find((other) => other !== root && other.startsWith(root));
    if (nested !== undefined) refuse(CODES.rootNested, `${root} prefixes ${nested}`);
  }
  return roots;
}

function selectorInvalid(selector: string): boolean {
  if (selector === '' || selector.startsWith('/') || selector.endsWith('/')) return true;
  if (selector.startsWith('!') || selector.startsWith('#')) return true;
  if (selector.includes('\\') || selector.includes('//')) return true;
  if (selector.includes('{') || selector.includes('}')) return true;
  if (/[@!+*?]\(/u.test(selector)) return true;
  return selector.split('/').some((segment) => segment === '..' || segment === '.');
}

function validSelectors(
  value: unknown,
  className: string,
  roots: readonly string[],
): readonly string[] {
  if (!Array.isArray(value)) refuse(CODES.selectorInvalid, `${className} selectors must be a list`);
  return value.map((selector: unknown) => {
    if (typeof selector !== 'string' || selectorInvalid(selector)) {
      refuse(CODES.selectorInvalid, `${className} ${JSON.stringify(selector)}`);
    }
    const [first] = selector.split('/');
    if (first !== undefined && roots.includes(first)) {
      refuse(CODES.selectorRooted, `${className} ${selector}`);
    }
    return selector;
  });
}

function classRule(
  repositoryId: string,
  id: string,
  precedence: 500 | 700 | 750,
  glob: string,
  role: Role,
  rationale: string,
) {
  return rule({
    id,
    origin: 'additive-extension',
    precedence,
    actionIds: ENGINEER_WRITE_VERBS,
    selector: fsSelector(repositoryId, glob),
    subjects: [{ kind: 'human', roles: [role] }, harnessSubject([role])],
    rationale,
  });
}

/**
 * Compile a validated adopter authority block into its additive extension document, or
 * throw `ADOPTER_AUTHORITY_<CODE>:<detail>` without emitting a rule.
 */
export function compileAdopterAuthorityExtension(input: {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly authority: AdopterAuthorityBlock;
  readonly constitutionVersion: string;
  readonly defaultTestSelectors: readonly string[];
  readonly repositoryId: string;
}): AdopterAuthorityExtension {
  if (!admitsAuthority(input.constitutionVersion)) {
    refuse(
      CODES.constitutionVersion,
      `bound constitution ${input.constitutionVersion} is below ${ADOPTER_AUTHORITY_MIN_CONSTITUTION}`,
    );
  }
  const authority: unknown = input.authority;
  if (!isRecord(authority)) refuse(CODES.rootInvalid, 'authority block must be an object');

  const declaredId = authority['extension_id'];
  if (declaredId === RESERVED_EXTENSION_ID) refuse(CODES.extensionIdReserved, declaredId);
  const extensionId =
    typeof declaredId === 'string' ? declaredId : `${input.policyId}.path-authority`;

  const classes = authority['classes'] ?? {};
  if (!isRecord(classes)) refuse(CODES.classUnknown, 'classes must be an object');
  const unknownClass = Object.keys(classes).find((key) => !CLASS_KEYS.has(key));
  if (unknownClass !== undefined) refuse(CODES.classUnknown, unknownClass);
  const testClass = classes['test'];
  const architectureClass = classes['architecture'];
  if (testClass !== undefined && !isRecord(testClass)) {
    refuse(CODES.selectorInvalid, 'test class must be an object');
  }
  if (architectureClass !== undefined) {
    const selectors = isRecord(architectureClass) ? architectureClass['selectors'] : undefined;
    if (!Array.isArray(selectors) || selectors.length === 0) {
      refuse(CODES.architectureSelectorsRequired, 'architecture class names no selectors');
    }
  }

  const roots = validRoots(authority['roots']);
  const testSelectors = validSelectors(
    testClass === undefined ? input.defaultTestSelectors : testClass['selectors'],
    'test',
    roots,
  );
  const architectureSelectors =
    architectureClass === undefined
      ? []
      : validSelectors(
          (architectureClass as Record<string, unknown>)['selectors'],
          'architecture',
          roots,
        );

  const rules = roots.flatMap((root) =>
    defined([
      classRule(
        input.repositoryId,
        `adopter-path-root-${root}`,
        500,
        root,
        'engineer',
        `ADR-AUT-0003: the declared root ${root} is Engineer source by remainder.`,
      ),
      classRule(
        input.repositoryId,
        `adopter-path-root-${root}-tree`,
        500,
        `${root}/**`,
        'engineer',
        `ADR-AUT-0003: the tree under the declared root ${root} is Engineer source by remainder.`,
      ),
      ...testSelectors.map((selector, index) =>
        classRule(
          input.repositoryId,
          `adopter-path-test-${root}-${String(index + 1)}`,
          700,
          `${root}/${selector}`,
          'inspector',
          `ADR-AUT-0003: the test class selector ${selector} under ${root} is Inspector.`,
        ),
      ),
      ...architectureSelectors.map((selector, index) =>
        classRule(
          input.repositoryId,
          `adopter-path-architecture-${root}-${String(index + 1)}`,
          750,
          `${root}/${selector}`,
          'architect',
          `ADR-AUT-0003: the architecture class selector ${selector} under ${root} is Architect.`,
        ),
      ),
    ]),
  );
  return { extension_id: extensionId, extension_version: input.policyVersion, rules };
}
