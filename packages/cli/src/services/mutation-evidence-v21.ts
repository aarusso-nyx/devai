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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  readonly activationModel: { readonly runtimeFileCount: number };
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
    return {
      source: {
        repository: 'devai-verifier',
        commit: policy.approvedSource.commit,
        tree: policy.approvedSource.tree,
        byteSetDigest: proof.sourceByteSetDigest,
      },
      vendor: JSON.parse(canonicalJson(proof.vendor)) as MutationVerifierProvenanceV21['vendor'],
      byteEquality: true,
    };
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

function readProtectedFile(path: string): Buffer {
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
    return bytes;
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
    const policy = JSON.parse(readProtectedFile(policyPath).toString('utf8')) as unknown;
    const manifestBytes = readProtectedFile(join(vendorRoot, 'provenance.json'));
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
    const provenance = validateMutationV21ActivationSnapshot({
      policy,
      manifestBytes,
      files: runtimeNames.map((path) => ({
        path,
        bytes: readProtectedFile(join(vendorRoot, path)),
      })),
    });
    if (source) for (const path of SOURCE_TESTS) readProtectedFile(join(vendorRoot, path));
    unchangedPaths(rootIdentity);
    const kernel = (await import(
      pathToFileURL(join(vendorRoot, 'src/mutation-v21.js')).href
    )) as CanonicalMutationModule;
    const safety = (await import(
      pathToFileURL(join(vendorRoot, 'src/artifact-safety.js')).href
    )) as {
      validateArtifactContent: (input: { bytes: Buffer; path: string; mediaType: string }) => void;
    };
    const canonical = (await import(
      pathToFileURL(join(vendorRoot, 'src/canonical-json.js')).href
    )) as { readonly framedDigest: (domain: string, value: unknown) => string };
    unchangedPaths(rootIdentity);
    return { kernel, provenance, safety, canonical, policyDigest: canonicalSha256(policy) };
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
  const { kernel, safety, policyDigest } = verifier;
  const contract = (input as { readonly contract?: unknown } | null)?.contract;
  kernel.validateMutationContractV21(contract);
  requirePolicyDigest(contract, policyDigest);
  const snapshot = JSON.parse(canonicalJson(input)) as {
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
      bytes: Buffer.from(canonicalJson(value)),
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
    receiptId: `MSV2-${canonicalSha256({ candidate: snapshot.candidate, outputContractDigest, evidenceSetDigest }).slice(0, 16)}`,
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
    bytes: Buffer.from(canonicalJson(value)),
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
  const { kernel, provenance, safety, policyDigest } = await loadPinnedVerifier();
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
      if (!bytes.equals(Buffer.from(canonicalJson(value)))) throw new Error();
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
        canonicalJson((receipt as JsonObject).verifierProvenance) !== canonicalJson(provenance)
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
