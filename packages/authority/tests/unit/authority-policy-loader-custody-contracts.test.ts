import { describe, expect, it } from 'vitest';
import {
  canonicalBytes,
  expectFailure,
  expectSuccess,
  makePolicyPlant,
  runtimeApi,
} from './authority-runtime-testkit.js';

// Policy loader custody contracts written against the retained round-3 authority mutation
// diagnostic (frozen candidate 3175bd2); mutant ids are that report's.

type AnyRecord = Record<string, unknown>;
type Plant = ReturnType<typeof makePolicyPlant>;

async function load(plant: Plant) {
  return (await runtimeApi()).loadAuthorityPolicy({ document: plant.document }, plant.deps);
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('expected a nonempty policy fixture');
  return item;
}

describe('policy source custody without a source document', () => {
  // Mutants 7629, 7649: the compiled rules of the immutable core and of each additive
  // extension are read defensively, so a trusted source binding whose source document is
  // absent while its canonical bytes agree is refused as a source/rule mismatch. The bytes
  // custody check passes here by construction — the loader recomputes the canonical bytes of
  // the absent document, which is what the binding published — so the rule comparison is the
  // only check left to refuse, and it must decide rather than dereference nothing.
  it('refuses a core that publishes canonical bytes for an absent source document', async () => {
    expectSuccess(await load(makePolicyPlant()));
    const plant = makePolicyPlant();
    const core = plant.deps.immutableCore as AnyRecord;
    plant.deps.immutableCore = {
      ...core,
      source_document: null,
      canonical_source_bytes: canonicalBytes(null),
    };
    const refusal = await load(plant);
    expectFailure(refusal, 'refused', 'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH');
    expect(refusal).toMatchObject({ reasons: ['AUTHORITY_POLICY_SOURCE_RULE_MISMATCH'] });
  });

  it('refuses an extension that publishes canonical bytes for an absent source document', async () => {
    const plant = makePolicyPlant();
    const extension = first(plant.deps.additiveExtensions as AnyRecord[]);
    plant.deps.additiveExtensions = [
      { ...extension, source_document: null, canonical_source_bytes: canonicalBytes(null) },
    ];
    const refusal = await load(plant);
    expectFailure(refusal, 'refused', 'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH');
    expect(refusal).toMatchObject({ reasons: ['AUTHORITY_POLICY_SOURCE_RULE_MISMATCH'] });
  });
});
