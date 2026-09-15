import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@devai-nyx/utils';
import { captureExportMutationUnitProjections } from '../../src/boundaries/release-export-mutation.js';

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture member');
  return value;
}

const sha = (character: string) => character.repeat(64);
const expected = {
  repository: { id: 'repo', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  plan_receipt_digest_sha256: sha('c'),
};
const packages = [
  { package_id: '@fixture/a', release_unit: 'core' },
  { package_id: '@fixture/b', release_unit: 'core' },
];
function object(path: string) {
  return {
    path,
    sha256: sha('d'),
    size_bytes: 17,
    evidence_sink_id: 'sink',
    opaque_handle: `sha256:${sha('d')}`,
  };
}
function fixture() {
  const members = [
    {
      ...object('01-report'),
      document_kind: 'mutation-normalized-stryker-report-v2',
      package_name: '@fixture/a' as string | null,
    },
    {
      ...object('02-result'),
      document_kind: 'mutation-package-result-v2',
      package_name: '@fixture/a' as string | null,
    },
    {
      ...object('03-summary'),
      document_kind: 'mutation-composed-report-set-v2',
      package_name: null as string | null,
    },
    {
      ...object('04-receipt'),
      document_kind: 'mutation-semantic-verification-receipt-v2',
      package_name: null as string | null,
    },
  ];
  return {
    release_unit: 'core',
    mutation_evidence: {
      carrier_package_id: '@fixture/a',
      binding: {
        repository_id: expected.repository.id,
        candidate_commit: expected.repository.commit,
        candidate_tree: expected.repository.tree,
        release_unit: 'core',
        release_plan_receipt_digest_sha256: expected.plan_receipt_digest_sha256,
        release_profile_digest_sha256: sha('e'),
        mutation_policy_digest_sha256: sha('f'),
        task_policy_digests_sha256: [sha('1'), sha('2')],
      },
      closure: { sha256: sha('3'), size_bytes: 19 },
      receipt: { sha256: sha('4'), size_bytes: 23, receipt_digest_sha256: sha('5') },
      output_contract: object('00-contract'),
      members,
      member_projection_digest_sha256: canonicalSha256(members),
    },
  };
}
const capture = (value: unknown) =>
  captureExportMutationUnitProjections(value, packages, expected, 10);
const refused = (value: unknown) =>
  expect(() => capture(value)).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');

describe('mutation export population identity', () => {
  it('captures complete paired evidence by value and elects the same carrier for an unordered roster', () => {
    const source = fixture();
    const result = captureExportMutationUnitProjections(
      [source],
      [...packages].reverse(),
      expected,
      10,
    );
    expect(result).toEqual([source]);
    present(source.mutation_evidence.members[0]).path = 'changed';
    source.mutation_evidence.binding.task_policy_digests_sha256.reverse();
    expect(result).not.toEqual([source]);
  });

  it.each([
    'repository_id',
    'candidate_commit',
    'candidate_tree',
    'release_unit',
    'release_plan_receipt_digest_sha256',
  ] as const)('refuses independent %s drift', (key) => {
    const unit = fixture();
    unit.mutation_evidence.binding[key] = '0'.repeat(64);
    refused([unit]);
  });

  it.each([
    { tasks: [] },
    { tasks: [sha('2'), sha('1')] },
    { tasks: [sha('1'), sha('1')] },
    { tasks: ['g'.repeat(64)] },
    { tasks: [sha('a').toUpperCase()] },
  ])('refuses invalid task-policy population $tasks', ({ tasks }) => {
    const unit = fixture();
    unit.mutation_evidence.binding.task_policy_digests_sha256 = tasks;
    refused([unit]);
  });

  it.each([
    'missing-report',
    'missing-result',
    'missing-summary',
    'missing-receipt',
    'duplicate-summary',
    'duplicate-receipt',
    'duplicate-report',
    'foreign-result',
    'summary-package',
    'receipt-package',
    'unknown-kind',
    'mixed-sink',
    'control-collision',
    'reordered',
  ])('refuses %s even when the member projection is correctly rehashed', (attack) => {
    const unit = fixture();
    const evidence = unit.mutation_evidence;
    const members = evidence.members;
    const first = present(members[0]);
    if (attack.startsWith('missing-'))
      members.splice(
        ['missing-report', 'missing-result', 'missing-summary', 'missing-receipt'].indexOf(attack),
        1,
      );
    else if (attack.startsWith('duplicate-')) {
      const index = attack === 'duplicate-summary' ? 2 : attack === 'duplicate-receipt' ? 3 : 0;
      members.push({ ...present(members[index]), path: '05-duplicate' });
    } else if (attack === 'foreign-result') present(members[1]).package_name = '@fixture/foreign';
    else if (attack === 'summary-package') present(members[2]).package_name = '@fixture/a';
    else if (attack === 'receipt-package') present(members[3]).package_name = '@fixture/a';
    else if (attack === 'unknown-kind') first.document_kind = 'unknown';
    else if (attack === 'mixed-sink') first.evidence_sink_id = 'other-sink';
    else if (attack === 'control-collision') evidence.output_contract.path = first.path;
    else members.reverse();
    evidence.member_projection_digest_sha256 = canonicalSha256(members);
    refused([unit]);
  });

  it.each(['../escape', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a:b', 'a/'])(
    'rejects unsafe retained member path %s after rehashing',
    (path) => {
      const unit = fixture();
      present(unit.mutation_evidence.members[0]).path = path;
      unit.mutation_evidence.member_projection_digest_sha256 = canonicalSha256(
        unit.mutation_evidence.members,
      );
      refused([unit]);
    },
  );

  it('rejects a stale content handle even with a matching projection digest', () => {
    const unit = fixture();
    present(unit.mutation_evidence.members[0]).sha256 = sha('9');
    unit.mutation_evidence.member_projection_digest_sha256 = canonicalSha256(
      unit.mutation_evidence.members,
    );
    refused([unit]);
  });

  it('retains explicit absent evidence for later host policy evaluation', () => {
    const units = [{ release_unit: 'core', mutation_evidence: null }];
    expect(capture(units)).toEqual(units);
    refused([]);
    refused([{ release_unit: 'other', mutation_evidence: null }]);
  });
});
