import { createHash } from 'node:crypto';
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

type JsonObject = Readonly<Record<string, unknown>>;

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

function refuse(): never {
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
  'export.test.js',
  'mutation-v21-contract.test.js',
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

interface PinnedModules {
  readonly kernel: CanonicalMutationModule;
  readonly safety: {
    readonly validateArtifactContent: (input: {
      bytes: Buffer;
      path: string;
      mediaType: string;
    }) => void;
  };
  readonly canonical: {
    readonly canonicalize: (value: unknown) => string;
    readonly canonicalBytes: (value: unknown) => Buffer;
    readonly sha256Hex: (value: unknown) => string;
    readonly framedDigest: (domain: string, value: unknown) => string;
  };
}

// Cached code is immutable; every invocation still validates the complete on-disk gate.
const pinnedModules = new Map<string, PinnedModules>();

function loadVerifiedSnapshot(
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
  byteSetDigest: string,
): PinnedModules {
  const cached = pinnedModules.get(byteSetDigest);
  if (cached !== undefined) return cached;
  const scope = new URL(`./.verified-mutation-${byteSetDigest}/`, import.meta.url).href;
  const sources = new Map(
    files
      .filter(({ path }) => path.startsWith('src/') && path.endsWith('.js'))
      .map(({ path, bytes }) => [new URL(path, scope).href, Buffer.from(bytes)]),
  );
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
        if (specifier === 'node:crypto' || specifier === 'node:fs')
          return { url: specifier, shortCircuit: true };
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
      return { format: 'module', source: Buffer.from(source), shortCircuit: true };
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
    const loaded = { kernel, safety, canonical };
    pinnedModules.set(byteSetDigest, loaded);
    return loaded;
  } finally {
    hooks.deregister();
  }
}

async function loadPinnedVerifier() {
  try {
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

/** Refinalization reads immutable input documents and launches zero mutation processes. */
export async function finalizeMutationEvidenceV21(input: unknown): Promise<JsonObject> {
  const verifier = await loadPinnedVerifier();
  return finalizeCheckedSnapshot(input, verifier).summary;
}

function finalizeCheckedSnapshot(
  input: unknown,
  verifier: Awaited<ReturnType<typeof loadPinnedVerifier>>,
) {
  const { kernel, safety, policyDigest, canonical } = verifier;
  const contract = (input as { readonly contract?: unknown } | null)?.contract;
  kernel.validateMutationContractV21(contract);
  requirePolicyDigest(contract, policyDigest);
  const snapshot = JSON.parse(canonical.canonicalize(input)) as {
    readonly contract: JsonObject;
    readonly candidate: {
      readonly releaseUnit: string;
      readonly commit: string;
      readonly tree: string;
    };
    readonly packages: readonly JsonObject[];
  };
  const summary = kernel.finalizeMutationReportSetV21(snapshot);
  const inspect = (value: unknown) =>
    safety.validateArtifactContent({
      bytes: canonical.canonicalBytes(value),
      path: 'mutation-finalization.json',
      mediaType: 'application/json',
    });
  // Preserve the canonical per-artifact size boundary, not an accidental whole-roster limit.
  inspect({ contract: snapshot.contract, candidate: snapshot.candidate });
  for (const material of snapshot.packages) {
    const { report, result, ...metadata } = material;
    inspect(metadata);
    if (report !== undefined) inspect(report);
    if (result !== undefined) inspect(result);
  }
  return { snapshot, summary };
}

function requirePolicyDigest(value: unknown, expected: string): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as JsonObject).policyDigest !== expected
  ) {
    throw Object.assign(new Error('MUTATION_SEMANTIC_RECEIPT_MISMATCH'), {
      code: 'MUTATION_SEMANTIC_RECEIPT_MISMATCH',
    });
  }
}

export interface MutationVerificationOptionsV21 {
  readonly releaseUnit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly mutationVerificationMode: 'certify' | 'offline';
  readonly resolveReuseOrigin?: (origin: unknown) => {
    readonly composition: unknown;
    readonly semanticReceipt: unknown;
  };
}

/** Produce candidate-specific composition/receipt bytes without changing package artifacts.
 * Only semantically verified material is returned; custody of execution and signing stays external. */
export async function composeMutationEvidenceV21(
  input: unknown,
  resolveReuseOrigin?: MutationVerificationOptionsV21['resolveReuseOrigin'],
): Promise<{
  readonly summary: JsonObject;
  readonly semanticReceipt: JsonObject;
  readonly artifacts: readonly { readonly path: string; readonly bytes: Buffer }[];
}> {
  const verifier = await loadPinnedVerifier();
  const { snapshot, summary } = finalizeCheckedSnapshot(input, verifier);
  const { kernel, canonical, provenance } = verifier;
  const domainDigest = (domain: string, value: unknown) => {
    const literal = kernel.MUTATION_V21_DIGEST_DOMAINS[domain];
    if (literal === undefined) refuse();
    return canonical.framedDigest(literal, value);
  };
  const contract = snapshot.contract as JsonObject & {
    readonly summaryPath: string;
    readonly semanticReceiptPath: string;
    readonly packages: readonly {
      readonly requirement: string;
      readonly reportPath?: string;
      readonly resultPath?: string;
    }[];
  };
  const packages = summary.packages as readonly JsonObject[];
  const outputContractDigest = domainDigest('outputContract', contract);
  const evidenceSetDigest = (summary.aggregate as JsonObject).evidenceSetDigest;
  const resultSet = packages
    .filter((entry) => entry.requirement === 'required')
    .map((entry) => ({
      packageName: entry.packageName,
      resultDigest: entry.resultDigest,
    }));
  const unsignedReceipt = {
    schemaVersion: '2.1.0',
    kind: 'mutation-semantic-verification-receipt-v2',
    receiptId: `MSV2-${canonical.sha256Hex({ candidate: snapshot.candidate, outputContractDigest, evidenceSetDigest }).slice(0, 16)}`,
    candidate: snapshot.candidate,
    outputContractDigest,
    releasePlanReceiptDigest: contract.releasePlanReceiptDigest,
    releaseProfileDigest: contract.releaseProfileDigest,
    policyDigest: contract.policyDigest,
    verifierProvenance: provenance,
    packages: packages.map((entry) => ({
      packageName: entry.packageName,
      disposition: entry.disposition,
      ...(entry.requirement !== 'required'
        ? {}
        : {
            inputDigest: entry.inputDigest,
            reportDigest: entry.reportDigest,
            resultDigest: entry.resultDigest,
          }),
      compositionEntryDigest: domainDigest('compositionEntry', entry),
    })),
    packageResultSetDigest: domainDigest('packageResultSet', resultSet),
    evidenceSetDigest,
    verdict: summary.verdict,
    semanticVerificationPerformed: true,
  };
  const semanticReceipt = {
    ...unsignedReceipt,
    receiptDigest: domainDigest('semanticReceipt', unsignedReceipt),
  };
  const documents = new Map<string, unknown>([
    [contract.summaryPath, summary],
    [contract.semanticReceiptPath, semanticReceipt],
  ]);
  for (const [index, entry] of contract.packages.entries()) {
    if (entry.requirement !== 'required') continue;
    if (entry.reportPath === undefined || entry.resultPath === undefined) refuse();
    documents.set(entry.reportPath, snapshot.packages[index]?.report);
    documents.set(entry.resultPath, snapshot.packages[index]?.result);
  }
  const artifacts = [...documents].map(([path, value]) => ({
    path,
    bytes: canonical.canonicalBytes(value),
  }));
  const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.bytes]));
  await verifyMutationEvidenceV21(
    contract,
    (path) => {
      const bytes = byPath.get(path);
      if (bytes === undefined) refuse();
      return bytes;
    },
    {
      releaseUnit: snapshot.candidate.releaseUnit,
      candidateCommit: snapshot.candidate.commit,
      candidateTree: snapshot.candidate.tree,
      mutationVerificationMode: 'certify',
      resolveReuseOrigin,
    },
  );
  return { summary, semanticReceipt, artifacts };
}

/** Semantic verification is not a substitute for signed bundle verification or execution custody. */
export async function verifyMutationEvidenceV21(
  contract: unknown,
  readArtifact: (path: string) => Uint8Array,
  options: MutationVerificationOptionsV21,
): Promise<JsonObject> {
  const { kernel, provenance, safety, policyDigest, canonical } = await loadPinnedVerifier();
  kernel.validateMutationContractV21(contract);
  requirePolicyDigest(contract, policyDigest);
  const descriptor = contract as {
    readonly paths: readonly string[];
    readonly semanticReceiptPath: string;
  };
  const snapshots = new Map<string, { readonly bytes: Buffer; readonly value: unknown }>();
  for (const path of descriptor.paths) {
    const bytes = Buffer.from(readArtifact(path));
    safety.validateArtifactContent({ bytes, path, mediaType: 'application/json' });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      if (!bytes.equals(canonical.canonicalBytes(value))) throw new Error();
    } catch {
      throw Object.assign(new Error('NON_CANONICAL_JSON'), { code: 'NON_CANONICAL_JSON' });
    }
    snapshots.set(path, { bytes, value });
  }
  const checkReceiptProvenance = (receipt: unknown) => {
    requirePolicyDigest(receipt, policyDigest);
    try {
      if (
        receipt === null ||
        typeof receipt !== 'object' ||
        canonical.canonicalize((receipt as JsonObject).verifierProvenance) !==
          canonical.canonicalize(provenance)
      )
        refuse();
    } catch {
      refuse();
    }
  };
  checkReceiptProvenance(snapshots.get(descriptor.semanticReceiptPath)?.value);
  const resolveReuseOrigin = options.resolveReuseOrigin;
  return kernel.verifyMutationReportSetV21(
    contract,
    (path) => {
      const snapshot = snapshots.get(path);
      if (snapshot === undefined)
        throw Object.assign(new Error('MUTATION_ROSTER_MISMATCH'), {
          code: 'MUTATION_ROSTER_MISMATCH',
        });
      return snapshot;
    },
    {
      ...options,
      ...(resolveReuseOrigin === undefined
        ? {}
        : {
            resolveReuseOrigin: (origin: unknown) => {
              const resolved = resolveReuseOrigin(origin);
              checkReceiptProvenance(resolved.semanticReceipt);
              return resolved;
            },
          }),
    },
  );
}
