import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson } from '@devai-nyx/utils';
import {
  canonicalBytes,
  canonicalSha256,
  sha256Bytes,
  classWriteVerbs,
  type PolicyRegistryEntry,
  type PolicyBindings,
} from './policy-construction.js';
import { prepareAuthoritySourceRules, completeAuthoritySources } from './policy-sources.js';
import {
  prepareBoundAdopterAuthoritySource,
  parseBoundAdopterAuthoritySource,
  prepareBoundAdopterAuthorityCompilation,
  boundAdopterAuthorityCompilePrefix,
  completeBoundAdopterAuthorityCompilation,
  type BoundAdopterAuthorityExtension,
} from './policy-adopter-extension.js';
import { validateAuthorityPolicyIntegrity } from './policy-integrity.js';
import {
  documentationImplementationFiles,
  documentationImplementationProvenanceValid,
  documentationImplementationRules,
  SUPPORTED_DOCUMENTATION_IMPLEMENTATION_CONSTITUTIONS,
} from '../documentation-implementation.js';

export type DocumentationImplementationContext = object;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (): never => {
  throw new Error('DOCUMENTATION_IMPLEMENTATION_CONTEXT_BINDING_MISMATCH');
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const parse = (value: string): unknown => JSON.parse(value);
const contexts = new WeakMap<
  object,
  {
    readonly files: ReadonlySet<string>;
    readonly document: string;
    readonly fresh: () => boolean;
    readonly repositoryRoot: string;
  }
>();
const RECEIPT = '.devai/config/adopter-policy-binding.json';
const POLICY = '.devai/config/authority-policy.json';
const JOURNAL = '.devai/config/adopter-policy-binding.journal.json';

/** Resolve only this running module's installation. No caller path, callback, registry
 * or version chooses the package which supplies executable authority. */
function owningPackage() {
  let directory = dirname(realpathSync(fileURLToPath(import.meta.url)));
  while (true) {
    const path = join(directory, 'package.json');
    if (existsSync(path)) {
      const manifest = parse(readFileSync(path, 'utf8'));
      if (record(manifest) && manifest['name'] === '@aarusso-nyx/devai') {
        return { assetRoot: directory, manifestPath: path, lawRoot: join(directory, 'dist/law') };
      }
      if (record(manifest) && manifest['name'] === '@devai-nyx/authority') {
        // The same real workspace installation used by the normal source compiler.
        const workspace = resolve(directory, '../..');
        if (!existsSync(join(workspace, 'pnpm-workspace.yaml'))) fail();
        return {
          assetRoot: workspace,
          manifestPath: join(workspace, 'packages/cli/package.json'),
          lawRoot: join(workspace, 'law'),
        };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return fail();
    directory = parent;
  }
}

function regularPath(root: string, path: string, mayBeAbsent = false): string {
  if (
    path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    /[\\:*?]/u.test(path)
  )
    fail();
  let current = root;
  const segments = path.split('/');
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (
        stat.isSymbolicLink() ||
        (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())
      )
        fail();
    } catch (error) {
      if (mayBeAbsent && record(error) && error['code'] === 'ENOENT') continue;
      throw error;
    }
  }
  return current;
}

function repositoryId(root: string, project: Record<string, unknown>): string {
  const normalize = (value: string) => value.trim().replaceAll(/[^A-Za-z0-9._-]/gu, '-');
  if (typeof project['name'] === 'string' && normalize(project['name']) !== '')
    return normalize(project['name']);
  let base = root;
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (common !== '') base = dirname(common);
  } catch {
    /* Same fresh-adopter fallback as the trusted policy compiler. */
  }
  return normalize(basename(base)) || 'adopter-repository';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return fail();
  return value.map((item: unknown) => {
    if (typeof item !== 'string') return fail();
    return item;
  });
}

/** Project the schema-validated native registry into only the fields used by the
 * shared rule builders. Preserve registry order; per-rule action sorting remains shared. */
function nativePolicyRegistryEntries(values: readonly unknown[]): PolicyRegistryEntry[] {
  return values.map((entry) => {
    if (
      !record(entry) ||
      typeof entry['action_id'] !== 'string' ||
      typeof entry['effect'] !== 'string'
    )
      return fail();
    const contract = entry['authority_contract'];
    if (!record(contract) || !record(contract['subject'])) return fail();
    const capabilities = stringArray(contract['capabilities']);
    const raw = contract['subject'];
    let subject: PolicyRegistryEntry['authority_contract']['subject'];
    if (raw['kind'] === 'none') {
      subject = { kind: 'none' };
    } else if (raw['kind'] === 'human') {
      subject = { kind: 'human', allowed_roles: stringArray(raw['allowed_roles']) };
    } else if (raw['kind'] === 'derived-machine') {
      if (typeof raw['actor'] !== 'string') return fail();
      const rawInitiator = raw['initiator'];
      if (rawInitiator === 'none') {
        subject = { kind: 'derived-machine', actor: raw['actor'], initiator: 'none' };
      } else {
        if (!record(rawInitiator)) return fail();
        subject = {
          kind: 'derived-machine',
          actor: raw['actor'],
          initiator: { allowed_roles: stringArray(rawInitiator['allowed_roles']) },
        };
      }
    } else return fail();
    return {
      name: entry['action_id'],
      effects: entry['effect'],
      authority_contract: { capabilities, subject },
    };
  });
}

function readBound(root: string, requireDocumentation = true) {
  if (existsSync(join(root, JOURNAL))) fail();
  const population = new Map<string, string>();
  const read = (path: string) => {
    const bytes = readFileSync(regularPath(root, path), 'utf8');
    population.set(path, bytes);
    return bytes;
  };
  const receipt = parse(read(RECEIPT));
  const policy = parse(read(POLICY));
  if (!record(receipt) || !record(policy) || !getValidator('authority-policy.schema.json')(policy))
    return fail();
  const time = policy['materialized_at'];
  const enforcement = policy['enforcement'];
  if (
    typeof time !== 'string' ||
    !Number.isFinite(Date.parse(time)) ||
    Date.parse(time) > Date.now()
  )
    fail();
  if (record(enforcement) && enforcement['mode'] === 'shadow') {
    const shadow = enforcement['shadow'];
    if (
      !record(shadow) ||
      typeof shadow['expires_at'] !== 'string' ||
      !Number.isFinite(Date.parse(shadow['expires_at'])) ||
      Date.parse(shadow['expires_at']) <= Date.now()
    )
      fail();
  }
  const rawBound = receipt['documentation_implementation'];
  const bound = documentationImplementationProvenanceValid(rawBound) ? rawBound : undefined;
  if (
    (requireDocumentation || Object.hasOwn(receipt, 'documentation_implementation')) &&
    bound === undefined
  )
    return fail();
  const required = [
    'schemaVersion',
    'policy_id',
    'policy_version',
    'source_path',
    'source_digest_sha256',
    'materialized',
  ];
  const optional = ['retired_keys', 'authority_extension', 'documentation_implementation'];
  if (
    receipt['schemaVersion'] !== '1.0.0' ||
    required.some((key) => !Object.hasOwn(receipt, key)) ||
    Object.keys(receipt).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail();
  const materialized = receipt['materialized'];
  if (!record(materialized) || Object.keys(materialized).length === 0) return fail();
  // The registered projection always emits the first five targets. Optional
  // source blocks select their corresponding target; previously owned optional
  // targets may also remain in the receipt after retirement (ADR-CFG-0002).
  const targets = new Map<string, string | undefined>([
    ['.devai/config/project.json', undefined],
    ['.devai/config/domains.json', undefined],
    ['.devai/config/thresholds.json', undefined],
    ['.devai/config/scorecard-na.json', undefined],
    ['.devai/config/glob-guards.json', undefined],
    ['.devai/config/release-verification.json', 'release_verification'],
    ['.devai/config/sensor-inputs.json', 'sensor_inputs'],
    ['.devai/config/invariant-producers.json', 'invariant_producers'],
    ['.devai/config/reviewed-workflow-steps.json', 'reviewed_workflow_steps'],
  ]);
  for (const [path, digest] of Object.entries(materialized)) {
    if (
      !targets.has(path) ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(digest) ||
      sha(read(path)) !== digest
    )
      fail();
  }
  const retired = receipt['retired_keys'];
  if (
    retired !== undefined &&
    (!Array.isArray(retired) ||
      retired.some((value) => typeof value !== 'string') ||
      new Set(retired).size !== retired.length)
  )
    fail();
  const extension = receipt['authority_extension'];
  if (extension !== undefined) {
    if (
      !record(extension) ||
      Object.keys(extension).length !== 4 ||
      typeof extension['extension_id'] !== 'string' ||
      extension['extension_id'] === '' ||
      typeof extension['extension_version'] !== 'string' ||
      extension['extension_version'] === '' ||
      typeof extension['digest_sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(extension['digest_sha256']) ||
      typeof extension['rule_count'] !== 'number' ||
      !Number.isSafeInteger(extension['rule_count']) ||
      extension['rule_count'] <= 0
    )
      fail();
  }
  const sourcePath = receipt['source_path'];
  if (
    typeof sourcePath !== 'string' ||
    !/^law\/policy\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/u.test(
      sourcePath,
    )
  )
    return fail();
  const sourceBytes = read(sourcePath);
  const source = parse(sourceBytes);
  if (!record(source) || !getValidator('adopter-policy.schema.json')(source)) return fail();
  if (
    source['policy_id'] !== receipt['policy_id'] ||
    source['policy_version'] !== receipt['policy_version'] ||
    sha(sourceBytes) !== receipt['source_digest_sha256'] ||
    (bound !== undefined && sha(sourceBytes) !== bound.source_digest_sha256)
  )
    fail();
  // Digest verification over a caller-truncated receipt is insufficient. Require
  // the source projection's complete target set before registering any context.
  for (const [path, sourceKey] of targets) {
    if (
      (sourceKey === undefined || Object.hasOwn(source, sourceKey)) &&
      !Object.hasOwn(materialized, path)
    )
      fail();
  }
  if (Object.hasOwn(source, 'documentation_implementation') !== (bound !== undefined))
    return fail();
  const files =
    bound === undefined
      ? []
      : documentationImplementationFiles(source['documentation_implementation']);
  for (const path of files) regularPath(root, path, true);
  const pin = read('.devai/pin/constitution.md');
  const supported = SUPPORTED_DOCUMENTATION_IMPLEMENTATION_CONSTITUTIONS.find(
    (candidate) =>
      sha(pin) === candidate.digest_sha256 &&
      (bound === undefined ||
        (candidate.version === bound.constitution.version &&
          candidate.digest_sha256 === bound.constitution.digest_sha256)),
  );
  if (supported === undefined) return fail();
  const owner = owningPackage();
  const packageRead = (path: string) => {
    const bytes = readFileSync(
      regularPath(owner.assetRoot, relative(owner.assetRoot, path).split(sep).join('/')),
      'utf8',
    );
    population.set(`package:${path}`, bytes);
    return bytes;
  };
  const manifest = parse(packageRead(owner.manifestPath));
  const canonicalConstitution = packageRead(join(owner.lawRoot, 'constitution.md'));
  if (
    !record(manifest) ||
    manifest['name'] !== '@aarusso-nyx/devai' ||
    typeof manifest['version'] !== 'string' ||
    (bound !== undefined &&
      (manifest['name'] !== bound.framework_package.name ||
        manifest['version'] !== bound.framework_package.version)) ||
    canonicalConstitution !== pin
  )
    return fail();
  const packageBinding = { name: manifest['name'], version: manifest['version'] };
  const constitutionBinding = { version: supported.version, digest_sha256: sha(pin) };
  const registry = parse(packageRead(join(owner.lawRoot, 'policy/action-registry.json')));
  if (
    !record(registry) ||
    !getValidator('action-registry.schema.json')(registry) ||
    !Array.isArray(registry['entries'])
  )
    return fail();
  const entries = nativePolicyRegistryEntries(registry['entries']);
  const project = parse(read('.devai/config/project.json'));
  if (!record(project)) return fail();
  const id = repositoryId(root, project);
  if (
    (bound !== undefined && id !== bound.repository_id) ||
    policy['repository_id'] !== id ||
    canonicalJson(policy['constitution']) !== canonicalJson(constitutionBinding) ||
    canonicalJson(policy['framework_package']) !== canonicalJson(packageBinding)
  )
    fail();
  const rules =
    bound === undefined
      ? []
      : documentationImplementationRules(files, id, classWriteVerbs(entries).root);
  if (!Array.isArray(policy['rules'])) return fail();
  const selected = policy['rules'].filter(
    (value: unknown) =>
      record(value) &&
      typeof value['rule_id'] === 'string' &&
      value['rule_id'].startsWith('core-documentation-implementation-'),
  );
  if (
    canonicalJson(selected) !== canonicalJson(rules) ||
    (bound !== undefined &&
      (bound.rule_count !== rules.length ||
        bound.compiled_digest_sha256 !== sha(canonicalJson({ files, rules }))))
  )
    fail();
  const bindings: PolicyBindings = {
    repository_id: id,
    package_binding: packageBinding,
    constitution_binding: constitutionBinding,
  };
  const documentation =
    bound === undefined
      ? undefined
      : {
          files,
          rules,
          provenance: {
            capability_id: bound.capability_id,
            repository_id: id,
            source_digest_sha256: sha(sourceBytes),
            constitution: bindings.constitution_binding,
            framework_package: bindings.package_binding,
            compiled_digest_sha256: sha(canonicalJson({ files, rules })),
            rule_count: rules.length,
          },
        };
  const prepared = prepareAuthoritySourceRules(entries, bindings, documentation);
  const request = prepareBoundAdopterAuthoritySource(receipt);
  let adopter: BoundAdopterAuthorityExtension;
  if (request.status !== 'source') {
    adopter = request;
  } else {
    // The already verified closed receipt binds this exact source. Reuse the consumed
    // native bytes; no caller-controlled reader or validator crosses the issuer boundary.
    if (request.sourcePath !== sourcePath) return fail();
    const parsed = parseBoundAdopterAuthoritySource(request, sourceBytes);
    if (parsed.status !== 'validate') return fail();
    const compilation = prepareBoundAdopterAuthorityCompilation(parsed);
    if (compilation.status !== 'compile') {
      adopter = compilation;
    } else {
      const prefix = boundAdopterAuthorityCompilePrefix(compilation, {
        constitutionVersion: bindings.constitution_binding.version,
      });
      const defaults = parse(
        packageRead(join(owner.lawRoot, 'policy/adopter-defaults/path-authority-classes.json')),
      );
      if (!getValidator('path-authority-classes.schema.json')(defaults) || !record(defaults))
        return fail();
      const classes = defaults['classes'];
      if (!record(classes) || !record(classes['test'])) return fail();
      const selectors = stringArray(classes['test']['selectors']);
      adopter = completeBoundAdopterAuthorityCompilation({
        prepared: compilation,
        prefix,
        defaultTestSelectors: selectors,
        repositoryId: id,
        classWriteVerbs: classWriteVerbs(entries),
      });
    }
  }
  const sources = completeAuthoritySources({ bindings, documentation, prepared, adopter });
  // Every complete canonical source/rule check precedes registration. The integrity
  // phase does not import context matching, so no mint-before-validation recursion exists.
  const loaded = validateAuthorityPolicyIntegrity(
    { document: policy },
    {
      now: new Date().toISOString(),
      validatePolicySchema: (value: unknown) =>
        getValidator('authority-policy.schema.json')(value)
          ? { ok: true, value: { raw: value, canonical_bytes: canonicalBytes(value), view: value } }
          : {
              ok: false,
              category: 'refused',
              code: 'AUTHORITY_POLICY_SCHEMA_INVALID',
              reasons: ['AUTHORITY_POLICY_SCHEMA_INVALID'],
            },
      canonicalBytes,
      canonicalSha256,
      sha256Bytes,
      immutableCore: sources.immutableCore,
      additiveExtensions: sources.additiveExtensions,
      expected_repository_id: sources.repository_id,
      expected_policy_id: sources.provenance.policy_id,
      expected_package: sources.package_binding,
      expected_constitution: sources.constitution_binding,
      expected_minimum_policy_version: sources.provenance.policy_version,
    },
  );
  if (!loaded.ok) return fail();

  return {
    sourcePath,
    hasDocumentation: bound !== undefined,
    files,
    document: canonicalJson(policy),
    fingerprint: canonicalJson([...population]),
  };
}

/** Internal commit-provenance proof. This is deliberately not exported from the
 * package entrypoint and never registers or returns a documentation context. */
export function verifyBoundAuthorityPolicy(root: string): {
  readonly sourcePath: string;
  readonly hasDocumentation: boolean;
  readonly fingerprint: string;
} {
  const proof = readBound(realpathSync(root), false);
  return Object.freeze({
    sourcePath: proof.sourcePath,
    hasDocumentation: proof.hasDocumentation,
    fingerprint: proof.fingerprint,
  });
}

/** Actual native boundary: only a repository root is accepted, never verification
 * callbacks, schemas, files, package identity, parsed policies or prebuilt capabilities. */
export function loadBoundDocumentationImplementation(
  root: string,
): DocumentationImplementationContext {
  const repositoryRoot = realpathSync(root);
  const bound = readBound(repositoryRoot);
  const context = Object.freeze({});
  contexts.set(context, {
    files: new Set(bound.files),
    document: bound.document,
    repositoryRoot,
    fresh: () => {
      try {
        return readBound(repositoryRoot).fingerprint === bound.fingerprint;
      } catch {
        return false;
      }
    },
  });
  return context;
}

/** Internal loader check; injected callbacks cannot register an identity. */
export function documentationContextMatchesPolicy(
  context: unknown,
  document: unknown,
  files: unknown,
): boolean {
  if (context === null || typeof context !== 'object') return false;
  const registered = contexts.get(context);
  return (
    registered !== undefined &&
    registered.fresh() &&
    registered.document === canonicalJson(document) &&
    canonicalJson([...registered.files]) === canonicalJson(files)
  );
}

export function documentationImplementationOwnsPath(
  context: DocumentationImplementationContext | undefined,
  path: string,
): boolean {
  if (context === undefined) return false;
  const registered = contexts.get(context);
  if (registered === undefined || !registered.fresh()) return fail();
  return registered.files.has(path);
}

export function assertDocumentationContextRepository(
  context: DocumentationImplementationContext | undefined,
  repositoryRoot: string,
): void {
  if (context === undefined) return;
  const registered = contexts.get(context);
  if (
    registered === undefined ||
    registered.repositoryRoot !== realpathSync(repositoryRoot) ||
    !registered.fresh()
  )
    fail();
}
