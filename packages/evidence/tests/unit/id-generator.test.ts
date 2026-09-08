import { describe, expect, it } from 'vitest';
import { computeManifestHash } from '../../src/evidence/chain.js';
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

  // Independently calculated with Python hashlib over the documented JSON array.
  it.each([
    [[], 'EV-1182f12c66e92605'],
    [['a'.repeat(64)], 'EV-59f71388c68f147d'],
    [['b'.repeat(64), 'a'.repeat(64), null], 'EV-63bae63635c58d5f'],
    [['a'.repeat(64), 'a'.repeat(64)], 'EV-a7acbc93d6ab5a5b'],
  ] as const)(
    'binds the complete artifact population %j to a stable identifier',
    (artifacts, id) => {
      const input = [...artifacts];
      const before = [...input];
      expect(deriveEvidenceId({ ...baseInputs(), artifact_sha256s: input })).toBe(id);
      expect(input).toEqual(before);
      expect(deriveEvidenceId({ ...baseInputs(), artifact_sha256s: [...input].reverse() })).toBe(
        id,
      );
    },
  );

  it('retains the canonical identifier for a large mixed-order artifact population', () => {
    const artifacts = Array.from({ length: 80 }, (_, i) =>
      ((i * 37) % 80).toString(16).padStart(64, '0'),
    );
    const input = [...artifacts];
    expect(deriveEvidenceId({ ...baseInputs(), artifact_sha256s: input })).toBe(
      'EV-6f9ed13ae6880532',
    );
    expect(input).toEqual(artifacts);
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

it('binds null artifacts before numeric-leading hashes in every input ordering', () => {
  const artifacts = [null, '0'.repeat(64), '9'.repeat(64), 'a'.repeat(64)];
  function permutations(values: readonly (string | null)[]): (string | null)[][] {
    if (values.length === 0) return [[]];
    return values.flatMap((value, index) =>
      permutations(values.filter((_item, other) => other !== index)).map((tail) => [
        value,
        ...tail,
      ]),
    );
  }
  const orders = permutations(artifacts);
  expect(orders).toHaveLength(24);
  // Independent Python hashlib vectors over the documented canonical arrays;
  // the ID excludes itself, while the manifest adds the ID and GENESIS domain.
  for (const order of orders) {
    const input = { ...baseInputs(), artifact_sha256s: Object.freeze([...order]) };
    expect(deriveEvidenceId(input)).toBe('EV-c3bbdfa6cbdc1617');
    expect(computeManifestHash({ ...input, id: 'EV-c3bbdfa6cbdc1617' })).toBe(
      'df68767c000334752f33413fb86c4f9b8c2cc3b0e8cfd85ace1bb6f4f3780d43',
    );
    expect(input.artifact_sha256s).toEqual(order);
  }
});
