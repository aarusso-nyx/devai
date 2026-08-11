import { describe, expect, it } from 'vitest';
import { deriveEvidenceId, type IdDerivationInputs } from '../../src/evidence/id-generator.js';

function baseInputs(): IdDerivationInputs {
  return {
    timestamp: '2026-05-11T00:00:00.000Z',
    actor: 'harness',
    actor_role: 'harness',
    action: 'harness.bootstrap',
    status: 'completed',
    git_head_sha: null,
    artifact_sha256s: [],
    previous_run_hash: null,
  };
}

describe('deriveEvidenceId', () => {
  it('returns an id matching ^EV-[a-f0-9]{16}$', () => {
    const id = deriveEvidenceId(baseInputs());
    expect(id).toMatch(/^EV-[a-f0-9]{16}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = deriveEvidenceId(baseInputs());
    const b = deriveEvidenceId(baseInputs());
    expect(a).toBe(b);
  });

  it('changes when any input changes', () => {
    const base = baseInputs();
    const baseId = deriveEvidenceId(base);
    expect(deriveEvidenceId({ ...base, action: 'task.spawn' })).not.toBe(baseId);
    expect(deriveEvidenceId({ ...base, actor: 'alice' })).not.toBe(baseId);
    expect(deriveEvidenceId({ ...base, timestamp: '2026-05-11T00:00:01.000Z' })).not.toBe(baseId);
    expect(deriveEvidenceId({ ...base, previous_run_hash: 'a'.repeat(64) })).not.toBe(baseId);
  });

  it('is insensitive to artifact-sha256 ordering (sorts before hashing)', () => {
    const a = deriveEvidenceId({
      ...baseInputs(),
      artifact_sha256s: ['a'.repeat(64), 'b'.repeat(64)],
    });
    const b = deriveEvidenceId({
      ...baseInputs(),
      artifact_sha256s: ['b'.repeat(64), 'a'.repeat(64)],
    });
    expect(a).toBe(b);
  });
});
// Invariants: INV-DEVAI-001
