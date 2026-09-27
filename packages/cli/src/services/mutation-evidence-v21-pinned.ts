import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getValidator } from '@devai-nyx/schemas';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import {
  isVerifiedReleasePackageSnapshot,
  type ReleasePackageSnapshot,
} from './release-package-snapshot.js';

export type JsonObject = Readonly<Record<string, unknown>>;

export interface MutationVerifierProvenanceV21 {
  readonly source: {
    readonly repository: 'devai-verifier';
    readonly commit: string;
    readonly tree: string;
    readonly byteSetDigest: string;
  };
  readonly vendor: {
    readonly root: string;
    readonly manifestPath: string;
    readonly manifestDigest: string;
    readonly sourceCommit: string;
    readonly sourceTree: string;
    readonly byteSetDigest: string;
  };
  readonly byteEquality: true;
}

interface ActivatedPolicy {
  readonly approvedSource: {
    readonly repository: string;
    readonly commit: string;
    readonly tree: string;
  };
  readonly activation: {
    readonly provenanceProof: {
      readonly vendor: MutationVerifierProvenanceV21['vendor'];
      readonly sourceByteSetDigest: string;
    };
  };
  readonly activationModel: {
    readonly runtimeFileCount: number;
    readonly sourceOnlyTestPaths: readonly string[];
    readonly semanticReceiptRepositoryBinding: { readonly wireRepository: 'devai-verifier' };
    readonly semanticReceiptProvenance: MutationVerifierProvenanceV21;
  };
}

export class MutationActivationError extends Error {
  readonly code = 'MUTATION_VENDOR_PROVENANCE_MISMATCH';
  constructor() {
    super('MUTATION_VENDOR_PROVENANCE_MISMATCH');
    this.name = 'MutationActivationError';
  }
}

export function refuse(): never {
  throw new MutationActivationError();
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Pure snapshot validation; a success is data, never a capability to load caller-selected code. */
export function validateMutationV21ActivationSnapshot(input: {
  readonly policy: unknown;
  readonly manifestBytes: Uint8Array;
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}): MutationVerifierProvenanceV21 {
  try {
    if (!getValidator('mutation-evidence-policy-v2.schema.json')(input.policy)) refuse();
    const policy = input.policy as ActivatedPolicy;
    const proof = policy.activation.provenanceProof;
    if (canonicalJson(policy.activationModel.sourceOnlyTestPaths) !== canonicalJson(SOURCE_TESTS))
      refuse();
    if (bytesDigest(input.manifestBytes) !== proof.vendor.manifestDigest) refuse();
    const manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.manifestBytes),
    ) as {
      readonly schemaVersion: string;
      readonly sourceCommit: string;
      readonly files: readonly { readonly path: string; readonly sha256: string }[];
    };
    if (
      canonicalJson(Object.keys(manifest).sort()) !==
        canonicalJson(['files', 'schemaVersion', 'sourceCommit']) ||
      manifest.schemaVersion !== '1.0.0' ||
      manifest.sourceCommit !== policy.approvedSource.commit ||
      manifest.files.length !== policy.activationModel.runtimeFileCount ||
      canonicalSha256(manifest.files) !== proof.vendor.byteSetDigest ||
      canonicalSha256(manifest.files) !== proof.sourceByteSetDigest
    )
      refuse();
    const paths = manifest.files.map((file) => file.path);
    if (
      new Set(paths).size !== paths.length ||
      canonicalJson(paths) !== canonicalJson([...paths].sort()) ||
      input.files.length !== paths.length ||
      new Set(input.files.map((file) => file.path)).size !== paths.length ||
      canonicalJson(input.files.map((file) => file.path).sort()) !== canonicalJson(paths)
    )
      refuse();
    for (const file of manifest.files) {
      if (
        canonicalJson(Object.keys(file).sort()) !== canonicalJson(['path', 'sha256']) ||
        !/^(?:src|schemas)\/[a-z0-9.-]+$/u.test(file.path)
      )
        refuse();
      const actual = input.files.find((entry) => entry.path === file.path);
      if (actual === undefined || bytesDigest(actual.bytes) !== file.sha256) refuse();
    }
    const provenance: MutationVerifierProvenanceV21 = {
      source: {
        repository: policy.activationModel.semanticReceiptRepositoryBinding.wireRepository,
        commit: policy.approvedSource.commit,
        tree: policy.approvedSource.tree,
        byteSetDigest: proof.sourceByteSetDigest,
      },
      vendor: JSON.parse(canonicalJson(proof.vendor)) as MutationVerifierProvenanceV21['vendor'],
      byteEquality: true,
    };
    if (
      canonicalJson(provenance) !== canonicalJson(policy.activationModel.semanticReceiptProvenance)
    )
      refuse();
    return provenance;
  } catch {
    refuse();
  }
}

interface PathIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

function noFollowAncestors(path: string): readonly PathIdentity[] {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const identities: PathIdentity[] = [];
  for (const part of relative(root, absolute).split(sep)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) refuse();
    identities.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

function unchangedPaths(identities: readonly PathIdentity[]): void {
  for (const identity of identities) {
    const stat = lstatSync(identity.path);
    if (stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) refuse();
  }
}

function readProtectedFile(path: string): {
  readonly bytes: Buffer;
  readonly identities: readonly PathIdentity[];
} {
  if (typeof constants.O_NOFOLLOW !== 'number') refuse();
  const ancestors = noFollowAncestors(path);
  const before = lstatSync(path);
  if (!before.isFile()) refuse();
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) refuse();
    const bytes = readFileSync(descriptor);
    const after = lstatSync(path);
    noFollowAncestors(path);
    unchangedPaths(ancestors);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.isSymbolicLink()) refuse();
    return { bytes, identities: ancestors };
  } finally {
    closeSync(descriptor);
  }
}

const SOURCE_TESTS = [
  'artifact-safety.test.js',
  'detached-trust.test.js',
  'export.test.js',
  'mutation-v21-contract.test.js',
  'mutation-v22-contract.test.js',
  'mutation.test.js',
  'policy-builder.test.js',
  'publish.test.js',
  'verifier.test.js',
].map((name) => `test/${name}`);

function filesBelow(root: string, directory = root): string[] {
  noFollowAncestors(directory);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) refuse();
    if (entry.isDirectory()) return filesBelow(root, path);
    if (!entry.isFile()) refuse();
    return [relative(root, path).split(sep).join('/')];
  });
}

interface CanonicalMutationModule {
  readonly MUTATION_V21_DIGEST_DOMAINS: Readonly<Record<string, string>>;
  readonly validateMutationContractV21: (contract: unknown) => void;
  readonly finalizeMutationReportSetV21: (input: unknown) => JsonObject;
  readonly verifyMutationReportSetV21: (
    contract: unknown,
    readArtifact: (
      path: string,
      label: string,
    ) => { readonly value: unknown; readonly bytes: Buffer },
    options: JsonObject,
  ) => JsonObject;
}

export interface OfflineCandidateEvidenceInput {
  readonly receipt: unknown;
  readonly taskPolicy: unknown;
  readonly namespaceCensus?: unknown;
  readonly expectedRepository: string;
  readonly expectedCommit: string;
  readonly expectedTree: string;
  readonly expectedPolicyDigest: string;
  readonly readEvidenceFile: (
    kind: 'result' | 'artifact',
    identity: string,
    label: string,
  ) => Buffer;
  readonly mutationExpectations?: Readonly<Record<string, unknown>>;
}

export interface OfflineDetachedSignatureInput {
  readonly trustStore: unknown;
  readonly algorithm: 'ed25519';
  readonly expectedSignerId: string;
  readonly expectedTrustRootId: string;
  readonly expectedTrustStoreDigest: string;
  readonly expectedKeyId: string;
  readonly payloadBytes: Buffer;
  readonly signatureBytes: Buffer;
}

interface PinnedModules {
  readonly evidence: {
    readonly verifyCandidateReceiptEvidence: (input: OfflineCandidateEvidenceInput) => unknown;
  };
  readonly trust: {
    readonly verifyDetachedSignature: (input: OfflineDetachedSignatureInput) => unknown;
  };
  readonly kernel: CanonicalMutationModule;
  readonly safety: {
    readonly validateArtifactContent: (input: {
      bytes: Buffer;
      path: string;
      mediaType?: string;
    }) => void;
  };
  readonly canonical: {
    readonly canonicalize: (value: unknown) => string;
    readonly canonicalBytes: (value: unknown) => Buffer;
    readonly sha256Hex: (value: unknown) => string;
    readonly framedDigest: (domain: string, value: unknown) => string;
  };
}

// Cached code is immutable; every invocation still validates the complete selected
// gate, from captured package bytes when bound or the source installation otherwise.
const pinnedModules = new Map<string, PinnedModules>();
let protectedPackageSnapshot: ReleasePackageSnapshot | undefined;
let verifierUsed = false;

/**
 * Trusted bootstrap only: bind the very snapshot whose runtime bytes were loaded.
 * A snapshot is not by itself proof of loaded-code identity; the host bootstrap
 * establishes that before this call. No candidate/request selects these bytes.
 */
export function bindMutationEvidenceV21PackageSnapshot(snapshot: ReleasePackageSnapshot): void {
  if (
    verifierUsed ||
    protectedPackageSnapshot !== undefined ||
    !isVerifiedReleasePackageSnapshot(snapshot)
  )
    refuse();
  protectedPackageSnapshot = snapshot;
}

function loadVerifiedSnapshot(
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
  byteSetDigest: string,
): PinnedModules {
  const cached = pinnedModules.get(byteSetDigest);
  if (cached !== undefined) return cached;
  // An unguessable first-load namespace prevents pre-populating Node's module
  // cache at predictable synthetic URLs. It is never included in evidence.
  const scope = new URL(`./.verified-mutation-${randomUUID()}-${byteSetDigest}/`, import.meta.url)
    .href;
  const sources = new Map(
    files
      .filter(({ path }) => path.startsWith('src/') && path.endsWith('.js'))
      .map(({ path, bytes }) => [new URL(path, scope).href, Buffer.from(bytes)]),
  );
  // Offline entrypoints receive bytes through explicit readers. Even an accidental
  // legacy path cannot reach the filesystem or launch a process from this graph.
  const deniedFs = new URL('offline-fs.js', scope).href;
  const deniedProcess = new URL('offline-process.js', scope).href;
  const deny = "function refuse() { throw new Error('release-offline-ambient-effect-refused'); }";
  sources.set(
    deniedFs,
    Buffer.from(`${deny}
    export const constants = Object.freeze({});
    export const readFileSync = refuse, writeFileSync = refuse, readdirSync = refuse,
      closeSync = refuse, fstatSync = refuse, lstatSync = refuse, openSync = refuse;`),
  );
  sources.set(deniedProcess, Buffer.from(`${deny} export const spawnSync = refuse;`));
  const filenames = new Map([...sources.keys()].map((url) => [fileURLToPath(url), url]));
  // The Node loader receives only bytes already covered by the activation proof.
  // Synthetic locations never fall through to disk; source replacement after
  // hashing cannot change any byte delivered to the loader.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      const filenameUrl = filenames.get(specifier);
      if (filenameUrl !== undefined) return { url: filenameUrl, shortCircuit: true };
      if (parent?.startsWith(scope)) {
        if (['node:crypto', 'node:path', 'node:util'].includes(specifier))
          return { url: specifier, shortCircuit: true };
        if (specifier === 'node:fs') return { url: deniedFs, shortCircuit: true };
        if (specifier === 'node:child_process') return { url: deniedProcess, shortCircuit: true };
        if (!specifier.startsWith('./')) refuse();
        const url = new URL(specifier, parent).href;
        if (!sources.has(url)) refuse();
        return { url, shortCircuit: true };
      }
      if (specifier.startsWith(scope)) {
        if (!sources.has(specifier)) refuse();
        return { url: specifier, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(scope)) return nextLoad(url, context);
      const source = sources.get(url);
      if (source === undefined) refuse();
      const format: string = 'module';
      if (format !== 'module') refuse();
      return { format, source: Buffer.from(source), shortCircuit: true };
    },
  });
  try {
    // The pinned graph contains no top-level await. Synchronous native ESM loading
    // also prevents another event-loop task from interleaving loader registration.
    const load = createRequire(import.meta.url);
    const kernel = load(fileURLToPath(`${scope}src/mutation-v21.js`)) as PinnedModules['kernel'];
    const safety = load(fileURLToPath(`${scope}src/artifact-safety.js`)) as PinnedModules['safety'];
    const canonical = load(
      fileURLToPath(`${scope}src/canonical-json.js`),
    ) as PinnedModules['canonical'];
    const evidence = load(fileURLToPath(`${scope}src/verify.js`)) as PinnedModules['evidence'];
    const trust = load(fileURLToPath(`${scope}src/trust.js`)) as PinnedModules['trust'];
    const loaded = { kernel, safety, canonical, evidence, trust };
    pinnedModules.set(byteSetDigest, loaded);
    return loaded;
  } finally {
    hooks.deregister();
  }
}

export async function loadPinnedVerifier() {
  verifierUsed = true;
  try {
    if (protectedPackageSnapshot !== undefined) {
      const snapshot = protectedPackageSnapshot;
      const vendorPrefix = 'dist/runtime/evidence-verification/';
      const policy = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          snapshot.read('dist/law/policy/mutation-evidence-v2.json'),
        ),
      ) as unknown;
      const manifestBytes = snapshot.read(`${vendorPrefix}provenance.json`);
      const files = snapshot.manifest
        .filter(
          (entry) =>
            entry.path.startsWith(vendorPrefix) && entry.path !== `${vendorPrefix}provenance.json`,
        )
        .map((entry) => ({
          path: entry.path.slice(vendorPrefix.length),
          bytes: snapshot.read(entry.path),
        }));
      const provenance = validateMutationV21ActivationSnapshot({ policy, manifestBytes, files });
      const modules = loadVerifiedSnapshot(files, provenance.source.byteSetDigest);
      return { ...modules, provenance, policyDigest: modules.canonical.sha256Hex(policy) };
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const installed = basename(here) === 'index' && basename(dirname(here)) === 'runtime';
    const source =
      basename(here) === 'services' && ['src', 'dist'].includes(basename(dirname(here)));
    if (!installed && !source) refuse();
    // Both locations derive from this trusted module, never cwd, environment, or candidate options.
    const vendorRoot = resolve(
      here,
      installed ? '../evidence-verification' : '../../vendor/evidence-verification',
    );
    const policyPath = resolve(
      here,
      installed
        ? '../../law/policy/mutation-evidence-v2.json'
        : '../../../../law/policy/mutation-evidence-v2.json',
    );
    const rootIdentity = noFollowAncestors(vendorRoot);
    const captured: {
      readonly path: string;
      readonly bytes: Buffer;
      readonly identities: readonly PathIdentity[];
    }[] = [];
    const capture = (path: string) => {
      const snapshot = readProtectedFile(path);
      captured.push({ path, ...snapshot });
      return snapshot.bytes;
    };
    const policy = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(capture(policyPath)),
    ) as unknown;
    const manifestBytes = capture(join(vendorRoot, 'provenance.json'));
    const names = filesBelow(vendorRoot).sort();
    const runtimeNames = names.filter(
      (path) => path !== 'provenance.json' && !(source && SOURCE_TESTS.includes(path)),
    );
    if (
      source &&
      canonicalJson(names.filter((path) => path.startsWith('test/'))) !==
        canonicalJson([...SOURCE_TESTS].sort())
    )
      refuse();
    const files = runtimeNames.map((path) => ({ path, bytes: capture(join(vendorRoot, path)) }));
    const provenance = validateMutationV21ActivationSnapshot({
      policy,
      manifestBytes,
      files,
    });
    if (source) for (const path of SOURCE_TESTS) capture(join(vendorRoot, path));
    const recheck = () => {
      unchangedPaths(rootIdentity);
      if (canonicalJson(filesBelow(vendorRoot).sort()) !== canonicalJson(names)) refuse();
      for (const snapshot of captured) {
        unchangedPaths(snapshot.identities);
        if (!readProtectedFile(snapshot.path).bytes.equals(snapshot.bytes)) refuse();
      }
    };
    recheck();
    const modules = loadVerifiedSnapshot(files, provenance.source.byteSetDigest);
    recheck();
    return { ...modules, provenance, policyDigest: modules.canonical.sha256Hex(policy) };
  } catch {
    refuse();
  }
}
