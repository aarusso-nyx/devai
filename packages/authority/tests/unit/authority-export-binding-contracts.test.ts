import { canonicalSha256 } from '@devai-nyx/utils';
import { describe, expect, it } from 'vitest';
import {
  captureProtectedReleaseExportBinding,
  type ProtectedReleaseExportBinding,
} from '../../src/boundaries/release-export-binding.js';
import { captureExportMutationUnitProjections } from '../../src/boundaries/release-export-mutation.js';

// Export binding and mutation-projection contracts written against the retained authority
// mutation diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's.
// Both captures are pure shape validators, so no scope or repository is involved.

const REFUSED = 'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID';
const LEGACY_SPEC = '77ab8fd69d2b3d4edeaebd12b516eb5c15fe910f93ff4516deadd466f0853f98';
const V3_SPEC = 'aac1c75a539516a38b567aea9be4490eb3f82fe0ab7b75e46e55e46d3166e37f';
const V4_SPEC = '245fba3823b7f80a55b73e8721ac5871a40b90cce8789aa49b87228b8d03ac44';
const sha = (character: string) => character.repeat(64);
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

type AnyRecord = Record<string, unknown>;

function closure(packageId: string, character: string) {
  return {
    package_id: packageId,
    sha256: sha(character),
    size_bytes: 1,
    expected_installed_package: {
      name: '@aarusso-nyx/devai',
      version: '1.5.0',
      archive_sha256: sha('1'),
      content_manifest_sha256: sha('2'),
    },
    policy_resolution_digest_sha256: sha('3'),
  };
}

function legacy(): AnyRecord {
  return {
    action_id: 'release export',
    repository: { id: 'owner/repository', commit: COMMIT, tree: TREE },
    candidate: { commit: COMMIT, tree: TREE },
    plan_receipt_digest_sha256: sha('c'),
    parent_artifact_sink: {
      sink_id: 'fixture-sink',
      transaction_handle: 'transaction-1',
      committed_manifest_handle: 'commit-1',
      committed_manifest_sha256: sha('d'),
      committed_manifest_size_bytes: 1,
      commit_protocol: 'devai.artifact-sink.two-phase.v1',
    },
    sink_id: 'fixture-sink',
    destination: { kind: 'evidence-destination', exact_identifier: 's3://fixture/export' },
    trust: {
      trust_root_id: 'fixture/trust',
      trust_store_digest_sha256: sha('e'),
      key_id: 'fixture-key',
      signature_algorithm: 'ed25519',
    },
    attempt_id: 'RLA-0123456789abcdef',
    export_spec_digest_sha256: LEGACY_SPEC,
    closure_inputs: [closure('@fixture/package', 'f')],
  };
}

function mutationObject(path: string, character: string) {
  return {
    path,
    sha256: sha(character),
    size_bytes: 1,
    evidence_sink_id: 'fixture-sink',
    opaque_handle: `sha256:${sha(character)}`,
  };
}

function mutationUnit(
  releaseUnit: string,
  carriers: readonly string[],
  expected = { id: 'owner/repository', commit: COMMIT, tree: TREE, plan: sha('c') },
) {
  const members = [
    ...carriers.flatMap((carrier, index) => [
      {
        ...mutationObject(`mutation/${releaseUnit}/${String(index)}-report.json`, '7'),
        document_kind: 'mutation-normalized-stryker-report-v2',
        package_name: carrier as string | null,
      },
      {
        ...mutationObject(`mutation/${releaseUnit}/${String(index)}-result.json`, '8'),
        document_kind: 'mutation-package-result-v2',
        package_name: carrier as string | null,
      },
    ]),
    {
      ...mutationObject(`mutation/${releaseUnit}/summary.json`, '9'),
      document_kind: 'mutation-composed-report-set-v2',
      package_name: null as string | null,
    },
    {
      ...mutationObject(`mutation/${releaseUnit}/z-receipt.json`, 'a'),
      document_kind: 'mutation-semantic-verification-receipt-v2',
      package_name: null as string | null,
    },
  ];
  return {
    release_unit: releaseUnit,
    mutation_evidence: {
      carrier_package_id: [...carriers].sort()[0],
      binding: {
        repository_id: expected.id,
        candidate_commit: expected.commit,
        candidate_tree: expected.tree,
        release_unit: releaseUnit,
        release_plan_receipt_digest_sha256: expected.plan,
        release_profile_digest_sha256: sha('d'),
        mutation_policy_digest_sha256: sha('e'),
        task_policy_digests_sha256: [sha('1'), sha('2')],
      },
      closure: { sha256: sha('3'), size_bytes: 1 },
      receipt: { sha256: sha('4'), size_bytes: 1, receipt_digest_sha256: sha('5') },
      output_contract: mutationObject(`mutation/${releaseUnit}/00-output-contract.json`, '6'),
      members,
      member_projection_digest_sha256: canonicalSha256(members),
    },
  };
}

function v3(): AnyRecord {
  return {
    ...legacy(),
    export_spec_digest_sha256: V3_SPEC,
    closure_inputs: [
      { ...closure('@fixture/carrier', 'f'), release_unit: 'fixture/required' },
      { ...closure('@fixture/none', '7'), release_unit: 'fixture/none' },
    ],
    mutation_units: [
      { release_unit: 'fixture/none', mutation_evidence: null },
      mutationUnit('fixture/required', ['@fixture/carrier']),
    ],
  };
}

const byteIdentity = (character = 'a') => ({ sha256: sha(character), size_bytes: 1 });
function certificationUnit(releaseUnit: string, carrier: string) {
  return {
    release_unit: releaseUnit,
    carrier_package_id: carrier,
    carrier: byteIdentity(),
    derivation_binding_digest_sha256: sha('a'),
    candidate_receipt: byteIdentity(),
    task_policy: byteIdentity(),
    task_results: [byteIdentity('a'), byteIdentity('b')],
    namespace_census: byteIdentity(),
    census_member_projection_digest_sha256: sha('b'),
    census_member_count: 0,
  };
}

function v4(): AnyRecord {
  return {
    ...v3(),
    export_spec_digest_sha256: V4_SPEC,
    certification_units: [
      certificationUnit('fixture/none', '@fixture/none'),
      certificationUnit('fixture/required', '@fixture/carrier'),
    ],
  };
}

const capture = (value: unknown) => captureProtectedReleaseExportBinding(value);
const refused = (value: unknown) => expect(() => capture(value)).toThrow(REFUSED);
const admitted = (value: AnyRecord) =>
  expect(capture(value)).toEqual(value as unknown as ProtectedReleaseExportBinding);
const withRepository = (objects: { commit: string; tree: string }, base = legacy()) => ({
  ...base,
  repository: { id: 'owner/repository', ...objects },
  candidate: { ...objects },
});
const installed = (change: AnyRecord) => {
  const first = closure('@fixture/package', 'f');
  return {
    ...legacy(),
    closure_inputs: [
      {
        ...first,
        expected_installed_package: { ...first.expected_installed_package, ...change },
      },
    ],
  };
};

describe('export binding versions', () => {
  // Mutants 3561, 3569, 3589, 3590, 3814, 3815: each spec digest selects exactly its own
  // shape; an unknown digest is refused and the v4 certification population is captured.
  it('admits a complete v4 binding and refuses an unknown spec digest', () => {
    admitted(v4());
    refused({ ...legacy(), export_spec_digest_sha256: sha('f') });
    refused({ ...v4(), certification_units: [] });
    refused({ ...v3(), certification_units: v4()['certification_units'] });
  });

  // Mutants 3706, 3707, 3710-3715: legacy and v3 bindings admit every listed algorithm; a
  // v4 offline-certification claim exists only under Ed25519.
  it.each(['ecdsa-p256-sha256', 'rsa-pss-sha256'])(
    'admits %s below v4 and refuses it for v4',
    (algorithm) => {
      const trust = { ...(legacy()['trust'] as AnyRecord), signature_algorithm: algorithm };
      admitted({ ...legacy(), trust });
      admitted({ ...v3(), trust });
      refused({ ...v4(), trust });
    },
  );
});

describe('export binding identity fields', () => {
  // Mutant 3593: the binding's own action is checked.
  it('refuses another release action', () => {
    refused({ ...legacy(), action_id: 'release prepare' });
  });

  // Mutants 3543, 3544: a nested record must be a plain own-value object, never a proxy.
  it('refuses a proxied repository record without reading through it', () => {
    let reads = 0;
    const repository = new Proxy(legacy()['repository'] as AnyRecord, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    refused({ ...legacy(), repository });
    expect(reads).toBe(0);
  });

  // Mutants 3604, 3605, 3611, 3612, 3618: object names are anchored on both sides and share
  // one width, even when the candidate repeats them exactly.
  it.each([
    ['a leading character', { commit: 'x' + COMMIT, tree: 'x' + TREE }],
    ['a trailing character', { commit: COMMIT + 'x', tree: TREE + 'x' }],
    ['mixed widths', { commit: COMMIT, tree: 'b'.repeat(64) }],
  ])('refuses object names with %s', (_name, objects) => {
    refused(withRepository(objects));
  });

  // Mutants 3608, 3609, 3615, 3616: a SHA-256 repository is admitted whole.
  it('admits 64-character object names', () => {
    admitted(withRepository({ commit: 'a'.repeat(64), tree: 'b'.repeat(64) }));
  });

  // Mutants 3625-3630: the candidate must repeat the repository identity field by field.
  it.each(['commit', 'tree'] as const)('refuses a candidate %s that differs', (key) => {
    refused({ ...legacy(), candidate: { commit: COMMIT, tree: TREE, [key]: 'd'.repeat(40) } });
  });

  // Mutants 3635, 3636: the attempt id grammar is anchored on both sides.
  it.each(['xRLA-0123456789abcdef', 'RLA-0123456789abcdefx'])('refuses attempt id %s', (id) => {
    refused({ ...legacy(), attempt_id: id });
  });

  // Mutants 3649-3654: the parent sink must be the export sink under the two-phase protocol.
  it('refuses a parent sink for another sink id or protocol', () => {
    const parent = legacy()['parent_artifact_sink'] as AnyRecord;
    refused({ ...legacy(), parent_artifact_sink: { ...parent, sink_id: 'other-sink' } });
    refused({
      ...legacy(),
      parent_artifact_sink: { ...parent, commit_protocol: 'devai.artifact-sink.two-phase.v2' },
    });
  });

  // Mutants 3667, 3668, 3675, 3676, 3678: the destination kind is one of the four listed
  // strings, each admitted on its own.
  it('admits every listed destination kind and refuses others', () => {
    for (const kind of ['local-staging', 'external-trust-input', 'publication-destination'])
      admitted({ ...legacy(), destination: { kind, exact_identifier: 'fixture' } });
    refused({ ...legacy(), destination: { kind: 'other', exact_identifier: 'fixture' } });
    refused({ ...legacy(), destination: { kind: 42, exact_identifier: 'fixture' } });
  });

  // Mutants 3681, 3682, 3804, 3805: control characters are refused at either end of the
  // destination identifier and the installed version.
  it.each(['\u0001fixture', 'fixture\u0001'])('refuses control characters in %j', (value) => {
    refused({ ...legacy(), destination: { kind: 'local-staging', exact_identifier: value } });
    refused(installed({ version: value }));
  });

  // Mutant 3697: the algorithm must be a string before it is matched.
  it('refuses a non-string signature algorithm', () => {
    refused({
      ...legacy(),
      trust: { ...(legacy()['trust'] as AnyRecord), signature_algorithm: 42 },
    });
  });

  // Mutant 3799: the installed package is exactly the DEVAI CLI.
  it('refuses another installed package name', () => {
    refused(installed({ name: 'other' }));
  });

  // Mutant 3514: the sink id bound is inclusive at 200 characters.
  it('admits a 200-character sink id and refuses 201', () => {
    for (const [length, expectation] of [
      [200, admitted],
      [201, refused],
    ] as const) {
      const sink = 'a'.repeat(length);
      expectation({
        ...legacy(),
        sink_id: sink,
        parent_artifact_sink: { ...(legacy()['parent_artifact_sink'] as AnyRecord), sink_id: sink },
      });
    }
  });

  // Mutants 3733, 3734, 3736: the closure population is bounded inclusively at 8192 and must
  // be a plain dense array.
  it('admits 8192 closures, refuses 8193 and refuses a decorated array', () => {
    const closures = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        closure(`p${String(index).padStart(5, '0')}`, 'f'),
      );
    admitted({ ...legacy(), closure_inputs: closures(8192) });
    refused({ ...legacy(), closure_inputs: closures(8193) });
    refused({ ...legacy(), closure_inputs: Object.assign(closures(1), { extra: true }) });
  });
});

describe('mutation unit projection', () => {
  const expected = {
    repository: { id: 'owner/repository', commit: COMMIT, tree: TREE },
    plan_receipt_digest_sha256: sha('c'),
  };
  const packages = [{ package_id: '@fixture/carrier', release_unit: 'core' }];
  const unit = () => mutationUnit('core', ['@fixture/carrier']);
  const project = (value: unknown, roster: unknown = packages, maximum = 10) =>
    captureExportMutationUnitProjections(value, roster as typeof packages, expected, maximum);
  const rejects = (value: unknown, roster: unknown = packages, maximum = 10) =>
    expect(() => project(value, roster, maximum)).toThrow(REFUSED);

  // Mutants 4071, 4073, 4075: a unit record has exactly its keys as enumerable own values.
  it('refuses an extra key and an accessor on a unit', () => {
    rejects([{ ...unit(), extra: true }]);
    const accessor = unit();
    Object.defineProperty(accessor, 'release_unit', { enumerable: true, get: () => 'core' });
    rejects([accessor]);
  });

  // Mutants 4092, 4097, 4102, 4104, 4106: the unit list is a plain dense array of own values.
  it('refuses a decorated, extended or accessor-bearing unit list', () => {
    rejects(Object.setPrototypeOf([unit()], { map: () => [] }));
    rejects(Object.assign([unit()], { extra: true }));
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => unit() });
    rejects(accessor);
  });

  // Mutants 4094, 4095, 4225-4229: the package bound is inclusive and must be a positive
  // safe integer.
  it('bounds the roster inclusively', () => {
    expect(project([unit()], packages, 1)).toHaveLength(1);
    rejects([unit()], [...packages, { package_id: '@fixture/other', release_unit: 'core' }], 1);
    rejects([unit()], packages, 0);
    rejects([unit()], packages, 1.5);
  });

  // Mutants 4125, 4127, 4128, 4130: release-unit text is non-empty, at most 200 characters
  // and NFC.
  it('bounds release-unit text and requires NFC', () => {
    const named = (name: string): [unknown, unknown] => [
      [mutationUnit(name, ['@fixture/carrier'])],
      [{ package_id: '@fixture/carrier', release_unit: name }],
    ];
    expect(project(...named('u'.repeat(200)))).toHaveLength(1);
    rejects(...named('u'.repeat(201)));
    rejects(...named(''));
    rejects(...named('e\u0301'));
    expect(project(...named('\u00e9'))).toHaveLength(1);
  });

  // Mutants 4145, 4162: the receipt identity carries its own validated receipt digest.
  it('refuses an invalid receipt digest', () => {
    const value = unit();
    value.mutation_evidence.receipt.receipt_digest_sha256 = 'z'.repeat(64);
    rejects([value]);
  });

  // Mutants 4154, 4155, 4158: byte sizes are positive safe integers.
  it.each([0, -1, 1.5])('refuses closure size %s', (size) => {
    const value = unit();
    value.mutation_evidence.closure.size_bytes = size;
    rejects([value]);
  });

  // Mutants 4179, 4180, 4194, 4196: the output contract path follows the same closed path
  // grammar as members.
  it.each(['a\\b', 'a:b', 'a/./b', 'a//b', '.'])('refuses output contract path %j', (path) => {
    const value = unit();
    value.mutation_evidence.output_contract.path = path;
    rejects([value]);
  });

  // Mutants 4237, 4238: package ids are well formed and unique across the roster.
  it('refuses a malformed or duplicated roster package id', () => {
    rejects([unit()], [{ package_id: 'Bad Id', release_unit: 'core' }]);
    rejects([unit()], [...packages, ...packages]);
  });

  // Mutant 4243: the carrier is elected from the roster alone.
  it('elects the byte-first package of the unit as carrier', () => {
    const roster = [
      { package_id: 'zeta', release_unit: 'core' },
      { package_id: 'alpha', release_unit: 'core' },
    ];
    expect(project([mutationUnit('core', ['alpha', 'zeta'])], roster)).toHaveLength(1);
    const wrong = mutationUnit('core', ['alpha', 'zeta']);
    wrong.mutation_evidence.carrier_package_id = 'zeta';
    rejects([wrong], roster);
  });

  // Mutant 4247: an empty roster admits no population, not even an empty one.
  it('refuses an empty roster with an empty population', () => {
    rejects([], []);
  });

  // Mutant 4345: a pair member names a well-formed package.
  it('refuses a malformed member package name even as a complete pair', () => {
    const value = unit();
    for (const member of value.mutation_evidence.members.slice(0, 2)) member.package_name = 'Bad';
    value.mutation_evidence.member_projection_digest_sha256 = canonicalSha256(
      value.mutation_evidence.members,
    );
    rejects([value]);
  });

  // Mutant 4380: the member count scales with the number of paired packages.
  it('admits two complete pairs in one unit', () => {
    const roster = [
      { package_id: '@fixture/a', release_unit: 'core' },
      { package_id: '@fixture/b', release_unit: 'core' },
    ];
    const value = mutationUnit('core', ['@fixture/a', '@fixture/b']);
    expect(value.mutation_evidence.members).toHaveLength(6);
    expect(project([value], roster)).toEqual([value]);
  });

  // Mutants 4362, 4364: the projection digest is checked even when the population is right.
  it('refuses a wrong projection digest over a complete population', () => {
    const value = unit();
    value.mutation_evidence.member_projection_digest_sha256 = sha('0');
    rejects([value]);
  });
});
