import { describe, expect, it } from 'vitest';
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
    expect(selectMutationEvidence(identity, candidate)).toMatchObject({ status: 'reused' });
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
});
