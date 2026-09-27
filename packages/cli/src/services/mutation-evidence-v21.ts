import {
  type JsonObject,
  loadPinnedVerifier,
  refuse,
  type OfflineCandidateEvidenceInput,
  type OfflineDetachedSignatureInput,
} from './mutation-evidence-v21-pinned.js';
export {
  bindMutationEvidenceV21PackageSnapshot,
  validateMutationV21ActivationSnapshot,
  MutationActivationError,
  type MutationVerifierProvenanceV21,
  type OfflineCandidateEvidenceInput,
  type OfflineDetachedSignatureInput,
} from './mutation-evidence-v21-pinned.js';

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

/** Offline semantic checking through exactly the activated verifier bytes. No ambient reads. */
export async function verifyPinnedCandidateReceiptEvidence(
  input: OfflineCandidateEvidenceInput,
): Promise<unknown> {
  if (typeof input.readEvidenceFile !== 'function')
    throw new Error('release-offline-reader-required');
  const verifier = await loadPinnedVerifier();
  return verifier.evidence.verifyCandidateReceiptEvidence(input);
}

/** Verify a reconstructed export transcript against independently supplied protected trust. */
export async function verifyPinnedDetachedSignature(
  input: OfflineDetachedSignatureInput,
): Promise<unknown> {
  const verifier = await loadPinnedVerifier();
  return verifier.trust.verifyDetachedSignature(input);
}

/** Apply the activated content-safety kernel to retained evidence bytes. */
export async function verifyPinnedArtifactContent(input: {
  readonly bytes: Buffer;
  readonly path: string;
  readonly mediaType?: string;
}): Promise<void> {
  const verifier = await loadPinnedVerifier();
  verifier.safety.validateArtifactContent(input);
}
