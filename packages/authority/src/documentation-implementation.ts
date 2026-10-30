import { createHash } from 'node:crypto';
import { canonicalJson } from '@devai-nyx/utils';
/** Proposed candidate capability; not a claim of constitutional acceptance/publication. */
export const DOCUMENTATION_IMPLEMENTATION_CAPABILITY = 'documentation-executable-core-v1';
export const SUPPORTED_DOCUMENTATION_IMPLEMENTATION_CONSTITUTIONS = Object.freeze([
  Object.freeze({
    version: '1.2.1',
    digest_sha256: '4dbb9caa8961cf3bbf8070faf7525711b018b1aaa3b47b17ae9a85f55cf4b57c',
  }),
]);

export interface DocumentationImplementationProvenance {
  readonly capability_id: typeof DOCUMENTATION_IMPLEMENTATION_CAPABILITY;
  readonly repository_id: string;
  readonly source_digest_sha256: string;
  readonly constitution: { readonly version: string; readonly digest_sha256: string };
  readonly framework_package: { readonly name: string; readonly version: string };
  readonly compiled_digest_sha256: string;
  readonly rule_count: number;
}

export function documentationProtectedClass(path: string): 'test' | 'architecture' | undefined {
  if (
    /(^|\/)(?:test|tests|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) ||
    /(^|\/)(?:vitest(?:\.[^/]*)?|jest|playwright|cypress)\.config\.[cm]?[jt]s$/u.test(path)
  )
    return 'test';
  if (
    /(^|\/)(?:architecture|architectures|schema|schemas|spec|specs|specification|specifications|blueprint|blueprints|adr|adrs)(?:\/|\.[^/]+$)/iu.test(
      path,
    ) ||
    /(?:^|\/)(?:README|AGENTS|CLAUDE)(?:\.|$)/iu.test(path) ||
    /\.(?:schema|blueprint|specification)\.[cm]?[jt]sx?$/iu.test(path) ||
    /\.(?:md|mdx|markdown)$/iu.test(path)
  )
    return 'architecture';
  return undefined;
}

export function documentationImplementationFiles(block: unknown): readonly string[] {
  const fail = (): never => {
    throw new Error('DOCUMENTATION_IMPLEMENTATION_INVALID');
  };
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return fail();
  if (Object.keys(block).length !== 1 || !('files' in block) || !Object.hasOwn(block, 'files'))
    return fail();
  const files: unknown = block.files;
  if (!Array.isArray(files) || files.length === 0) return fail();
  const result = files.map((path: unknown) => {
    if (
      typeof path !== 'string' ||
      path !== path.normalize('NFC') ||
      !/^docs\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:[cm]?[jt]sx?)$/u.test(
        path,
      ) ||
      documentationProtectedClass(path) !== undefined
    )
      return fail();
    return path;
  });
  if (new Set(result).size !== result.length) return fail();
  return Object.freeze(result.sort());
}

export function documentationImplementationProvenanceValid(
  value: unknown,
): value is DocumentationImplementationProvenance {
  const record = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, expected: readonly string[]) =>
    Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
  if (
    !record(value) ||
    !keys(value, [
      'capability_id',
      'repository_id',
      'source_digest_sha256',
      'constitution',
      'framework_package',
      'compiled_digest_sha256',
      'rule_count',
    ])
  )
    return false;
  const constitution = value['constitution'];
  const pkg = value['framework_package'];
  return (
    value['capability_id'] === DOCUMENTATION_IMPLEMENTATION_CAPABILITY &&
    typeof value['repository_id'] === 'string' &&
    value['repository_id'].length > 0 &&
    hash(value['source_digest_sha256']) &&
    hash(value['compiled_digest_sha256']) &&
    typeof value['rule_count'] === 'number' &&
    Number.isSafeInteger(value['rule_count']) &&
    value['rule_count'] > 0 &&
    record(constitution) &&
    keys(constitution, ['version', 'digest_sha256']) &&
    typeof constitution['version'] === 'string' &&
    hash(constitution['digest_sha256']) &&
    record(pkg) &&
    keys(pkg, ['name', 'version']) &&
    pkg['name'] === '@aarusso-nyx/devai' &&
    typeof pkg['version'] === 'string'
  );
}

/** Pure rules, not authority: callers still need the bound native loader below. */
export function documentationImplementationRules(
  files: readonly string[],
  repositoryId: string,
  actionIds: readonly string[],
) {
  if (actionIds.length === 0)
    throw new Error(
      'DOCUMENTATION_IMPLEMENTATION_INVALID:registered Engineer write verbs unavailable',
    );
  return files.map((path) => ({
    rule_id: `core-documentation-implementation-${createHash('sha256').update(canonicalJson(path)).digest('hex')}`,
    origin: 'immutable-core',
    precedence: 700,
    action_ids: [...actionIds],
    selector: {
      kind: 'fs',
      repository_id: repositoryId,
      canonical_relative_path_glob: path,
      operations: ['create', 'update', 'delete', 'rename'],
    },
    effect: 'allow',
    subjects: [
      { kind: 'human', roles: ['engineer'] },
      {
        kind: 'derived-machine',
        actor: 'harness',
        transition: 'harness-write',
        initiator: { allowed_roles: ['engineer'], preserve_in_context: true },
      },
    ],
    required_consent: { write: true, allow_publish: false, experimental: false },
    constitutional_anchors: [6, 7, 8, 9, 10],
    rationale: 'Exact constitution-authorized bound documentation implementation file.',
  }));
}
