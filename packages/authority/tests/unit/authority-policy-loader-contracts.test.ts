import { describe, expect, it, vi } from 'vitest';
import {
  canonicalBytes,
  canonicalSha256,
  engineerRule,
  expectFailure,
  expectSuccess,
  inspectorRule,
  makePolicyPlant,
  runtimeApi,
  sha256Bytes,
} from './authority-runtime-testkit.js';

// Policy loader contracts written against the retained authority mutation diagnostic
// (candidate 3dfdc316, report 414957d9); mutant ids are the report's.

type AnyRecord = Record<string, unknown>;
type Plant = ReturnType<typeof makePolicyPlant>;
const document = (plant: Plant) => plant.document as AnyRecord;
const core = (plant: Plant) => plant.deps.immutableCore as AnyRecord;
const extension = (plant: Plant) => (plant.deps.additiveExtensions as AnyRecord[])[0] as AnyRecord;

async function load(plant: Plant, input: unknown = { document: plant.document }) {
  return (await runtimeApi()).loadAuthorityPolicy(input, plant.deps);
}

/** A plant with two additive extensions so per-extension checks are observable. */
function twoExtensionPlant(): Plant {
  const plant = makePolicyPlant({ additiveRules: [engineerRule] });
  const source = {
    extension_id: 'second-authority',
    extension_version: '1.0.0',
    rules: [inspectorRule],
  };
  const bytes = canonicalBytes(source);
  plant.deps.additiveExtensions = [
    ...plant.additiveExtensions,
    {
      extension_id: 'second-authority',
      extension_version: '1.0.0',
      source_document: source,
      canonical_source_bytes: bytes,
      rules: [inspectorRule],
    },
  ];
  const view = document(plant);
  view.additive_extensions = [
    ...(view.additive_extensions as AnyRecord[]),
    {
      extension_id: 'second-authority',
      extension_version: '1.0.0',
      digest_sha256: sha256Bytes(bytes),
    },
  ];
  view.rules = [...(view.rules as unknown[]), inspectorRule];
  view.resolved_digest_sha256 = canonicalSha256(view.rules);
  return plant;
}

describe('policy version precedence', () => {
  // Mutants 7331, 7366, 7440: a higher minor outranks a higher patch below it; an
  // alphanumeric pre-release identifier outranks a numeric one regardless of width; a
  // pre-release identifier may start with a zero when it is not purely numeric.
  it.each([
    ['1.2.0', '1.1.5'],
    ['1.0.0-a', '1.0.0-10'],
    ['1.0.0-0a1', '1.0.0-0a1'],
  ])('accepts %s at or above the minimum %s', async (version, minimum) => {
    const plant = makePolicyPlant({ policyVersion: version });
    plant.deps.expected_minimum_policy_version = minimum;
    const loaded = expectSuccess<{ provenance: { policy_version: string } }>(await load(plant));
    expect(loaded.provenance.policy_version).toBe(version);
  });

  // Mutants 7380, 7393, 7429: an invalid trusted minimum is a host programming error and is
  // raised as such, never turned into a policy decision.
  it('raises an invalid trusted minimum version instead of deciding', async () => {
    const plant = makePolicyPlant();
    plant.deps.expected_minimum_policy_version = '1.0';
    await expect(load(plant)).rejects.toThrow('invalid trusted SemVer dependency');
  });
});

describe('policy source custody', () => {
  // Mutant 7465: canonical bytes must match in length, not only as a prefix.
  it('refuses core bytes that extend the canonical bytes', async () => {
    const plant = makePolicyPlant();
    core(plant).canonical_source_bytes = Uint8Array.from([
      ...(core(plant).canonical_source_bytes as Uint8Array),
      0,
    ]);
    expectFailure(await load(plant), 'refused', 'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH');
  });

  // Mutant 7577: an extension whose compiled rules are not a list is refused as a source
  // mismatch even when its bytes and source document agree with that shape.
  it('refuses extension rules that are not a list even when consistently sourced', async () => {
    const plant = makePolicyPlant();
    const source = { ...(extension(plant).source_document as AnyRecord), rules: {} };
    extension(plant).source_document = source;
    extension(plant).canonical_source_bytes = canonicalBytes(source);
    extension(plant).rules = {};
    expectFailure(await load(plant), 'refused', 'AUTHORITY_POLICY_SOURCE_RULE_MISMATCH');
  });

  // Mutants 7599, 7604: one core-origin rule inside an otherwise additive extension makes
  // the extension non-additive.
  it('refuses an extension carrying one core-origin rule beside additive ones', async () => {
    const plant = makePolicyPlant({
      additiveRules: [engineerRule, { ...inspectorRule, origin: 'immutable-core' }],
    });
    expectFailure(await load(plant), 'refused', 'AUTHORITY_POLICY_EXTENSION_NON_ADDITIVE');
  });

  // Mutants 7633, 7667: each extension's digest and identity are checked on their own.
  it('checks every extension digest and identity, not only the last', async () => {
    expectSuccess(await load(twoExtensionPlant()));
    const digestDrift = twoExtensionPlant();
    const items = document(digestDrift).additive_extensions as AnyRecord[];
    document(digestDrift).additive_extensions = [
      { ...(items[0] as AnyRecord), digest_sha256: 'f'.repeat(64) },
      items[1],
    ];
    expectFailure(await load(digestDrift), 'refused', 'AUTHORITY_POLICY_DIGEST_MISMATCH');
    const identityDrift = twoExtensionPlant();
    const named = document(identityDrift).additive_extensions as AnyRecord[];
    document(identityDrift).additive_extensions = [
      { ...(named[0] as AnyRecord), extension_id: 'renamed-authority' },
      named[1],
    ];
    expectFailure(await load(identityDrift), 'refused', 'AUTHORITY_POLICY_BINDING_MISMATCH');
  });
});

describe('policy document shape', () => {
  // Mutant 7516: a non-record input or document is a schema refusal.
  it.each([[null], ['document'], [{ document: 'policy' }]])(
    'refuses the non-record input %j',
    async (input) => {
      const plant = makePolicyPlant();
      expectFailure(await load(plant, input), 'refused', 'AUTHORITY_POLICY_SCHEMA_INVALID');
    },
  );

  // Mutants 7474, 7475, 7477: a missing version carrier is a semantic refusal, never an
  // exception.
  it.each([
    ['framework_package', (view: AnyRecord) => delete view.framework_package],
    ['source_policy', (view: AnyRecord) => delete view.source_policy],
    ['an additive extension', (view: AnyRecord) => (view.additive_extensions = [null])],
  ])('refuses a document without %s as semantically invalid', async (_name, edit) => {
    const plant = makePolicyPlant();
    edit(document(plant));
    expectFailure(await load(plant), 'refused', 'AUTHORITY_POLICY_SEMANTIC_INVALID');
  });

  // Mutant 7478: a non-list extension carrier is refused by the digest population check.
  it('refuses a non-list extension carrier at the digest check', async () => {
    const plant = makePolicyPlant();
    document(plant).additive_extensions = 'none';
    expectFailure(await load(plant), 'refused', 'AUTHORITY_POLICY_DIGEST_MISMATCH');
  });

  // Mutant 7499: shadow enforcement without its expiry record is semantically invalid.
  it('refuses shadow enforcement without a shadow record', async () => {
    const plant = makePolicyPlant({ enforcement: { mode: 'shadow' } });
    expectFailure(await load(plant), 'refused', 'AUTHORITY_POLICY_SEMANTIC_INVALID');
  });

  // Mutants 7496, 7690: the loader decides on a document without an enforcement record
  // rather than throwing; the schema validator owns that shape.
  it('decides on a document without enforcement instead of throwing', async () => {
    const plant = makePolicyPlant();
    delete document(plant).enforcement;
    const refusal = {
      ok: false,
      category: 'refused',
      code: 'AUTHORITY_POLICY_SCHEMA_INVALID',
      reasons: ['enforcement is required'],
    };
    const validatePolicySchema = vi.fn(() => refusal);
    const result = (await runtimeApi()).loadAuthorityPolicy(
      { document: plant.document },
      { ...plant.deps, validatePolicySchema },
    );
    expect(validatePolicySchema).toHaveBeenCalledExactlyOnceWith(plant.document);
    expect(result).toBe(refusal);
  });

  // Mutant 7528: the caller's document is checked semantically before schema validation,
  // even when the validator would return a corrected view.
  it('refuses a semantically invalid document before consulting the validator view', async () => {
    const plant = makePolicyPlant();
    const corrected = document(plant);
    const invalid = { ...corrected, policy_version: 'invalid' };
    plant.deps.validatePolicySchema = () => ({
      ok: true,
      value: { raw: corrected, canonical_bytes: canonicalBytes(corrected), view: corrected },
    });
    expectFailure(
      await load(plant, { document: invalid }),
      'refused',
      'AUTHORITY_POLICY_SEMANTIC_INVALID',
    );
  });
});
