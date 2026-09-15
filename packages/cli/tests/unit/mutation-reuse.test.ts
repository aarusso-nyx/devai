import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../src/services/check-runner/canonical.js';
import {
  selectMutationEvidence,
  type MutationEvidenceIdentity,
} from '../../src/services/mutation-reuse.js';

const identity: MutationEvidenceIdentity = {
  schemaVersion: '1.0.0',
  rosterEntryId: 'packages-cli',
  sourceInputsDigest: '1'.repeat(64),
  testInputsDigest: '2'.repeat(64),
  manifestDigest: '3'.repeat(64),
  mutationConfigDigest: '4'.repeat(64),
  mutationScriptsDigest: '5'.repeat(64),
  rosterDigest: '6'.repeat(64),
  thresholdDigest: '7'.repeat(64),
  sanitizerDigest: '8'.repeat(64),
  lockfileDigest: '9'.repeat(64),
  toolchainDigest: 'a'.repeat(64),
  dependencyResultsDigest: 'b'.repeat(64),
  candidateDigest: 'c'.repeat(64),
  profileDigest: 'd'.repeat(64),
  policyDigest: 'e'.repeat(64),
};
const report = { mutationScore: 95, killed: 19, survived: 1 };
const candidate = {
  identity,
  identityDigest: sha256Hex(identity),
  report,
  reportDigest: sha256Hex(report),
  result: 'pass' as const,
};

describe('mutation evidence reuse', () => {
  it('reuses only exact passing evidence with intact identities and report', () => {
    expect(selectMutationEvidence(identity, undefined)).toEqual({
      status: 'execute',
      reason: 'evidence-missing',
    });
    expect(selectMutationEvidence(identity, candidate)).toEqual({
      status: 'reused',
      reason: 'exact-identity',
      reportDigest: candidate.reportDigest,
    });
  });

  it.each([
    'sourceInputsDigest',
    'testInputsDigest',
    'manifestDigest',
    'mutationConfigDigest',
    'mutationScriptsDigest',
    'rosterDigest',
    'thresholdDigest',
    'sanitizerDigest',
    'lockfileDigest',
    'toolchainDigest',
    'dependencyResultsDigest',
    'candidateDigest',
    'profileDigest',
    'policyDigest',
  ] as const)('invalidates reuse when %s changes by one byte', (field) => {
    const required = { ...identity, [field]: `0${identity[field].slice(1)}` };
    expect(selectMutationEvidence(required, candidate)).toEqual({
      status: 'execute',
      reason: 'relevant-input-changed',
    });
  });

  it('rejects corrupt result evidence and a failed previous result', () => {
    expect(
      selectMutationEvidence(identity, { ...candidate, report: { mutationScore: 0 } }),
    ).toEqual({ status: 'execute', reason: 'report-integrity-mismatch' });
    expect(selectMutationEvidence(identity, { ...candidate, result: 'fail' })).toEqual({
      status: 'execute',
      reason: 'prior-result-not-pass',
    });
  });

  it('checks candidate identity integrity before comparing required inputs', () => {
    const substitutedIdentity = { ...identity, sourceInputsDigest: '0'.repeat(64) };
    expect(
      selectMutationEvidence(identity, {
        ...candidate,
        identity: substitutedIdentity,
        identityDigest: sha256Hex(identity),
      }),
    ).toEqual({ status: 'execute', reason: 'identity-integrity-mismatch' });
  });

  it('rejects digest fields with valid hexadecimal prefixes longer than SHA-256', () => {
    for (const sourceInputsDigest of [
      `${identity.sourceInputsDigest}0`,
      `0${identity.sourceInputsDigest}`,
    ])
      expect(() => selectMutationEvidence({ ...identity, sourceInputsDigest }, candidate)).toThrow(
        'CHECK_MUTATION_EVIDENCE_IDENTITY_INVALID:sourceInputsDigest',
      );
  });

  it('rejects coercible non-string digest fields without invoking caller code', () => {
    const toString = vi.fn(() => identity.sourceInputsDigest);
    const malformed = {
      ...identity,
      sourceInputsDigest: { toString },
    } as unknown as MutationEvidenceIdentity;
    expect(() => selectMutationEvidence(malformed, candidate)).toThrow(
      'CHECK_MUTATION_EVIDENCE_IDENTITY_INVALID:sourceInputsDigest',
    );
    expect(toString).not.toHaveBeenCalled();
  });
});
