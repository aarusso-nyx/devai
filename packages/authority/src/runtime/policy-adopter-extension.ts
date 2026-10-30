import { getValidator } from '@devai-nyx/schemas';
import {
  type ClassWriteVerbs,
  canonicalBytes,
  defined,
  fsSelector,
  harnessSubject,
  rule,
  sha256Bytes,
} from './policy-construction.js';

/**
 * ADR-AUT-0003 compiler: turns a validated adopter `authority` block into one additive
 * extension document with a fixed class ladder (root 500 Engineer, test 700 Inspector,
 * architecture 750 Architect) and a harness subject bound to each class role. Each class
 * rule carries the registered write verbs of its class role (ADR-AUT-0004), given as an
 * input by `classWriteVerbs` of the registry. The function is pure: the same inputs yield
 * the same rules in the same order.
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
 * The package default test selectors ADR-AUT-0003 states. The bind and the trusted sources
 * read them from the defaults law source through `loadAdopterAuthorityDefaultTestSelectors`;
 * this constant mirrors that source for callers that compile without a package layout.
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
  defaultsUnavailable: 'ADOPTER_AUTHORITY_DEFAULTS_UNAVAILABLE',
  sourceUnavailable: 'ADOPTER_AUTHORITY_SOURCE_UNAVAILABLE',
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
  verbs: readonly string[],
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
    actionIds: verbs,
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
  readonly classWriteVerbs: ClassWriteVerbs;
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
        input.classWriteVerbs.root,
        `adopter-path-root-${root}`,
        500,
        root,
        'engineer',
        `ADR-AUT-0003: the declared root ${root} is Engineer source by remainder.`,
      ),
      classRule(
        input.repositoryId,
        input.classWriteVerbs.root,
        `adopter-path-root-${root}-tree`,
        500,
        `${root}/**`,
        'engineer',
        `ADR-AUT-0003: the tree under the declared root ${root} is Engineer source by remainder.`,
      ),
      ...testSelectors.map((selector, index) =>
        classRule(
          input.repositoryId,
          input.classWriteVerbs.test,
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
          input.classWriteVerbs.architecture,
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

/** SHA-256 of the canonical extension document, as the authority policy records it. */
export function adopterAuthorityExtensionDigest(extension: AdopterAuthorityExtension): string {
  return sha256Bytes(canonicalBytes(extension));
}

function boundSourcePathValid(sourcePath: string): boolean {
  return (
    sourcePath.startsWith('law/policy/') &&
    sourcePath.endsWith('.json') &&
    !/[\\:*?]/u.test(sourcePath) &&
    ![...sourcePath].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) &&
    !sourcePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

export type BoundAdopterAuthorityExtension =
  | { readonly status: 'none' }
  | { readonly status: 'compiled'; readonly extension: AdopterAuthorityExtension }
  | { readonly status: 'refused'; readonly reason: string };

/** Ordinary, non-authoritative resolution state. It is never a context or proof handle. */
export interface BoundAdopterSourceRequest {
  readonly status: 'source';
  readonly receipt: Record<string, unknown>;
  readonly sourcePath: string;
  readonly strict: boolean;
  readonly bound: unknown;
  readonly rebind: string;
}

function unavailable(
  request: BoundAdopterSourceRequest,
  detail: string,
): BoundAdopterAuthorityExtension {
  return request.strict
    ? { status: 'refused', reason: `${CODES.sourceUnavailable}:${detail}; ${request.rebind}` }
    : { status: 'none' };
}
function drifted(
  request: BoundAdopterSourceRequest,
  detail: string,
): BoundAdopterAuthorityExtension {
  return request.strict
    ? { status: 'refused', reason: `AUTHORITY_POLICY_DIGEST_MISMATCH:${detail}; ${request.rebind}` }
    : { status: 'none' };
}

export function prepareBoundAdopterAuthoritySource(
  receipt: unknown,
): BoundAdopterAuthorityExtension | BoundAdopterSourceRequest {
  if (!isRecord(receipt)) return { status: 'none' };
  const bound = receipt['authority_extension'];
  const strict = bound !== undefined;
  const sourcePath = receipt['source_path'];
  const rebind = `rerun devai init bind --adopter-policy ${String(sourcePath)} --write`;
  const absent = (detail: string): BoundAdopterAuthorityExtension =>
    strict
      ? { status: 'refused', reason: `${CODES.sourceUnavailable}:${detail}; ${rebind}` }
      : { status: 'none' };
  if (typeof sourcePath !== 'string' || !boundSourcePathValid(sourcePath))
    return absent('the binding receipt names no admissible source path');
  if (strict && (!isRecord(bound) || typeof bound['digest_sha256'] !== 'string'))
    return absent('the binding receipt records no adopter extension digest');
  return { status: 'source', receipt, sourcePath, strict, bound, rebind };
}

export interface BoundAdopterCompilation {
  readonly status: 'compile';
  readonly request: BoundAdopterSourceRequest;
  readonly text: string;
  readonly document: Record<string, unknown>;
}

function completeBoundAdopterAuthoritySource(
  input: { readonly request: BoundAdopterSourceRequest; readonly text: string },
  extension: AdopterAuthorityExtension | undefined,
): BoundAdopterAuthorityExtension {
  const { request, text } = input;
  const { sourcePath, bound, strict, receipt } = request;
  if (sha256Bytes(new TextEncoder().encode(text)) !== receipt['source_digest_sha256'])
    return drifted(request, `${sourcePath} changed after it was bound`);
  if (extension === undefined)
    return drifted(request, `${sourcePath} no longer declares the bound authority block`);
  if (
    strict &&
    (!isRecord(bound) || adopterAuthorityExtensionDigest(extension) !== bound['digest_sha256'])
  )
    return drifted(
      request,
      `the adopter extension compiled from ${sourcePath} differs from the digest the binding receipt records`,
    );
  return { status: 'compiled', extension };
}

export interface BoundAdopterParsedSource {
  readonly status: 'validate';
  readonly request: BoundAdopterSourceRequest;
  readonly text: string;
  readonly document: unknown;
}

export function parseBoundAdopterAuthoritySource(
  request: BoundAdopterSourceRequest,
  text: string | undefined,
): BoundAdopterAuthorityExtension | BoundAdopterParsedSource {
  if (text === undefined) return unavailable(request, `${request.sourcePath} is absent`);
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return unavailable(request, `${request.sourcePath} is not JSON`);
  }
  return { status: 'validate', request, text, document };
}

export function prepareBoundAdopterAuthorityCompilation(
  parsed: BoundAdopterParsedSource,
  validator: typeof getValidator = getValidator,
): BoundAdopterAuthorityExtension | BoundAdopterCompilation {
  const { request, text, document } = parsed;
  const validate = validator('adopter-policy.schema.json');
  if (validate(document) !== true || !isRecord(document))
    return unavailable(
      request,
      `${request.sourcePath} does not validate against adopter-policy.schema.json`,
    );
  if (document['authority'] === undefined)
    return completeBoundAdopterAuthoritySource({ request, text }, undefined);
  return { status: 'compile', request, text, document };
}

/** Capture the original compile argument prefix before loading default selectors. */
export function boundAdopterAuthorityCompilePrefix(
  prepared: BoundAdopterCompilation,
  input: { readonly constitutionVersion: string },
) {
  return {
    policyId: String(prepared.document['policy_id']),
    policyVersion: String(prepared.document['policy_version']),
    authority: prepared.document['authority'] as AdopterAuthorityBlock,
    constitutionVersion: input.constitutionVersion,
  };
}

export function boundAdopterAuthorityCompilationFailure(
  input: BoundAdopterCompilation,
  error: unknown,
): BoundAdopterAuthorityExtension {
  return unavailable(
    input.request,
    `${input.request.sourcePath} does not compile: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function completeBoundAdopterAuthorityCompilation(input: {
  readonly prepared: BoundAdopterCompilation;
  readonly prefix: ReturnType<typeof boundAdopterAuthorityCompilePrefix>;
  readonly defaultTestSelectors: readonly string[];
  readonly repositoryId: string;
  readonly classWriteVerbs: ClassWriteVerbs;
}): BoundAdopterAuthorityExtension {
  const { prepared } = input;
  let extension: AdopterAuthorityExtension;
  try {
    extension = compileAdopterAuthorityExtension({
      ...input.prefix,
      defaultTestSelectors: input.defaultTestSelectors,
      repositoryId: input.repositoryId,
      classWriteVerbs: input.classWriteVerbs,
    });
  } catch (error) {
    return boundAdopterAuthorityCompilationFailure(prepared, error);
  }
  return completeBoundAdopterAuthoritySource(prepared, extension);
}
