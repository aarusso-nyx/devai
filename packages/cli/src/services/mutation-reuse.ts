import { sha256Hex } from './check-runner/canonical.js';

export interface MutationEvidenceIdentity {
  readonly schemaVersion: '1.0.0';
  readonly rosterEntryId: string;
  readonly sourceInputsDigest: string;
  readonly testInputsDigest: string;
  readonly manifestDigest: string;
  readonly mutationConfigDigest: string;
  readonly mutationScriptsDigest: string;
  readonly rosterDigest: string;
  readonly thresholdDigest: string;
  readonly sanitizerDigest: string;
  readonly lockfileDigest: string;
  readonly toolchainDigest: string;
  readonly dependencyResultsDigest: string;
  readonly candidateDigest: string;
  readonly profileDigest: string;
  readonly policyDigest: string;
}

export interface MutationEvidenceCandidate {
  readonly identity: MutationEvidenceIdentity;
  readonly identityDigest: string;
  readonly report: unknown;
  readonly reportDigest: string;
  readonly result: 'pass' | 'fail';
}

export type MutationEvidenceSelection =
  | Readonly<{ status: 'reused'; reason: 'exact-identity'; reportDigest: string }>
  | Readonly<{ status: 'execute'; reason: string }>;

const SHA256 = /^[a-f0-9]{64}$/u;

function assertIdentity(identity: MutationEvidenceIdentity): void {
  for (const [key, value] of Object.entries(identity)) {
    if (key === 'schemaVersion' || key === 'rosterEntryId') continue;
    if (typeof value !== 'string' || !SHA256.test(value)) {
      throw new Error(`CHECK_MUTATION_EVIDENCE_IDENTITY_INVALID:${key}`);
    }
  }
}

export function selectMutationEvidence(
  required: MutationEvidenceIdentity,
  candidate: MutationEvidenceCandidate | undefined,
): MutationEvidenceSelection {
  assertIdentity(required);
  if (candidate === undefined) return { status: 'execute', reason: 'evidence-missing' };
  assertIdentity(candidate.identity);
  if (candidate.result !== 'pass') return { status: 'execute', reason: 'prior-result-not-pass' };
  if (sha256Hex(candidate.identity) !== candidate.identityDigest) {
    return { status: 'execute', reason: 'identity-integrity-mismatch' };
  }
  if (sha256Hex(candidate.report) !== candidate.reportDigest) {
    return { status: 'execute', reason: 'report-integrity-mismatch' };
  }
  if (sha256Hex(required) !== candidate.identityDigest) {
    return { status: 'execute', reason: 'relevant-input-changed' };
  }
  return { status: 'reused', reason: 'exact-identity', reportDigest: candidate.reportDigest };
}
