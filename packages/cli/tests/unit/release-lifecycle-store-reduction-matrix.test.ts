import { describe, expect, it, vi } from 'vitest';
import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  finalizeStoreHead,
  finalizeStoreRecord,
  reduceStoreRecords,
  type StoreHead,
  type StoreRecord,
} from '../../src/services/release-lifecycle-execution.js';

type Action = StoreRecord['action_id'];
type State = NonNullable<StoreRecord['completion']>['state'];
type TerminalKind = Exclude<StoreRecord['record_kind'], 'attempt'>;

const REPOSITORY = {
  id: 'aarusso-nyx/devai',
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
} as const;
const CANDIDATE = {
  commit: REPOSITORY.commit,
  tree: REPOSITORY.tree,
  release_units: [
    {
      release_unit: '@aarusso-nyx/devai',
      version: '1.5.0',
      packages: [{ package_id: '@aarusso-nyx/devai' }],
    },
  ],
} as const;
const RECORD_CANONICALIZATION = {
  json_form: 'rfc8785-jcs',
  encoding: 'utf-8',
  digest_algorithm: 'sha256',
  projection_excludes: ['record_id', 'record_digest_sha256'],
  id_derivation: 'RLE-hyphen-plus-first-16-lowercase-hex-of-record_digest_sha256',
} as const;
const HEAD_CANONICALIZATION = {
  kernel_id: 'devai.kernel.release-lifecycle-store-head.v2',
  encoding: 'utf-8',
  json_form: 'rfc8785-jcs',
  digest_algorithm: 'sha256',
  projection_excludes: ['head_digest_sha256'],
} as const;

const ACTIONS: readonly { action: Action; state: State }[] = [
  { action: 'release preflight', state: 'preflight_passed' },
  { action: 'release certify', state: 'certified' },
  { action: 'release prepare', state: 'prepared' },
  { action: 'release export', state: 'exported' },
  { action: 'release evidence-publish', state: 'evidence_published' },
  { action: 'release publish', state: 'publication_dispatched' },
];

// Exact unclaimed Survived/NoCoverage population from the frozen shard-02
// diagnostic at release-lifecycle-execution.ts:1059-1209. This is inventory,
// not mutation credit; current-plan structural mapping remains a later gate.
const STALE_DIAGNOSTIC_IDS = [
  '938',
  '940',
  '943',
  '948',
  '950',
  '951',
  '954',
  '955',
  '956',
  '959',
  '965',
  '968',
  '970',
  '973',
  '981',
  '983',
  '984',
  '993',
  '997',
  '999',
  '1001',
  '1011',
  '1012',
  '1022',
  '1023',
  '1024',
  '1025',
  '1028',
  '1030',
  '1032',
  '1033',
  '1034',
  '1035',
  '1036',
  '1038',
  '1041',
  '1042',
  '1046',
  '1047',
  '1049',
  '1054',
  '1055',
  '1078',
  '1081',
  '1086',
  '1090',
  '1098',
  '1101',
  '1102',
  '1104',
  '1110',
  '1111',
  '1114',
  '1117',
  '1118',
  '1119',
  '1120',
  '1124',
  '1126',
  '1127',
  '1129',
  '1139',
  '1140',
  '1142',
  '1151',
  '1152',
  '1156',
  '1175',
  '1178',
] as const;

// These two mutations remove a terminal observation check that is redundant in
// the reducer's public result. The opening attempt has already compared the
// same observation with completedHead. If that comparison passed, the terminal
// comparison is identical; if it failed, the Set already contains the same
// error. Keep the tuples visible without claiming an observable result.
const PUBLICLY_EQUIVALENT_IDS = ['1098', '1101'] as const;

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(label);
  return value;
}

function reference(record: StoreRecord) {
  return {
    sequence: record.sequence,
    record_id: record.record_id,
    record_digest_sha256: record.record_digest_sha256,
  };
}

function authorizationFor(action: Action, sequence: number): string | null {
  return action === 'release evidence-publish' || action === 'release publish'
    ? `EA-${canonicalSha256({ action, sequence }).slice(0, 16)}`
    : null;
}

function attempt(
  records: readonly StoreRecord[],
  action: Action,
  observedHead: StoreHead | null,
  authorization = authorizationFor(action, records.length),
): StoreRecord {
  const sequence = records.length;
  const predecessor_record =
    records.length === 0 ? null : reference(required(records.at(-1), 'missing predecessor'));
  const request_digest_sha256 = canonicalSha256({ action, sequence, purpose: 'store-matrix' });
  const attempt_id = `RLA-${canonicalSha256({
    request_digest_sha256,
    action_id: action,
    sequence,
    predecessor_record,
  }).slice(0, 16)}`;
  return finalizeStoreRecord({
    schemaVersion: '1.0.0',
    record_kind: 'attempt',
    canonicalization: RECORD_CANONICALIZATION,
    sequence,
    repository: REPOSITORY,
    candidate: CANDIDATE,
    predecessor_record,
    observed_head_before: observedHead,
    attempt_id,
    action_id: action,
    request_digest_sha256,
    authorization_event_id: authorization,
    provider_handle: null,
    provider_dispatch: { status: 'not-dispatched', handle_observed: false },
    completion: null,
    failure: null,
    unknown: null,
  });
}

function terminal(opening: StoreRecord, kind: TerminalKind, state: State): StoreRecord {
  const observed =
    opening.action_id === 'release export' ||
    opening.action_id === 'release evidence-publish' ||
    opening.action_id === 'release publish';
  const provider_handle =
    observed && kind !== 'failure' ? `provider-${opening.sequence.toString()}` : null;
  const provider_dispatch =
    kind === 'completion'
      ? observed
        ? ({ status: 'dispatched', handle_observed: true } as const)
        : ({ status: 'not-dispatched', handle_observed: false } as const)
      : kind === 'failure'
        ? observed
          ? ({ status: 'failed-before-dispatch', handle_observed: false } as const)
          : ({ status: 'not-dispatched', handle_observed: false } as const)
        : observed
          ? ({ status: 'unknown', handle_observed: true } as const)
          : ({ status: 'not-dispatched', handle_observed: false } as const);
  const state_digest_sha256 = canonicalSha256({ state, sequence: opening.sequence + 1 });
  return finalizeStoreRecord({
    schemaVersion: '1.0.0',
    record_kind: kind,
    canonicalization: RECORD_CANONICALIZATION,
    sequence: opening.sequence + 1,
    repository: opening.repository,
    candidate: opening.candidate,
    predecessor_record: reference(opening),
    observed_head_before: opening.observed_head_before,
    attempt_id: opening.attempt_id,
    action_id: opening.action_id,
    request_digest_sha256: opening.request_digest_sha256,
    authorization_event_id: opening.authorization_event_id,
    provider_handle,
    provider_dispatch,
    completion:
      kind === 'completion'
        ? {
            state_id: `RLS-${state_digest_sha256.slice(0, 16)}`,
            state_digest_sha256,
            state,
          }
        : null,
    failure: kind === 'failure' ? { code: 'release-provider-failure', retryable: false } : null,
    unknown:
      kind === 'unknown-provider-result'
        ? { code: 'release-provider-result-unknown', redispatch_permitted: false }
        : null,
  });
}

function refinalize(
  record: StoreRecord,
  patch: Partial<Omit<StoreRecord, 'record_id' | 'record_digest_sha256'>>,
): StoreRecord {
  const { record_id: _recordId, record_digest_sha256: _digest, ...draft } = record;
  return finalizeStoreRecord({ ...draft, ...patch });
}

function unsafeRefinalize(
  record: StoreRecord,
  patch: Partial<Omit<StoreRecord, 'record_id' | 'record_digest_sha256'>>,
  rederiveAttemptId = false,
): StoreRecord {
  const { record_id: _recordId, record_digest_sha256: _digest, ...draft } = record;
  let changed = { ...draft, ...patch };
  if (rederiveAttemptId) {
    changed = {
      ...changed,
      attempt_id: `RLA-${canonicalSha256({
        request_digest_sha256: changed.request_digest_sha256,
        action_id: changed.action_id,
        sequence: changed.sequence,
        predecessor_record: changed.predecessor_record,
      }).slice(0, 16)}`,
    };
  }
  const record_digest_sha256 = canonicalSha256(changed);
  return {
    ...changed,
    record_id: `RLE-${record_digest_sha256.slice(0, 16)}`,
    record_digest_sha256,
  } as StoreRecord;
}

function withSchemaAccepted<T>(run: () => T): T {
  const parser = vi
    .spyOn(parsers.releaseLifecycleStoreRecord, 'safeParse')
    .mockImplementation((value) => ({ ok: true, value }) as never);
  try {
    return run();
  } finally {
    parser.mockRestore();
  }
}

function expectedHead(terminalRecord: StoreRecord, generation: number): StoreHead {
  const completion = required(terminalRecord.completion, 'missing completion');
  const repository = terminalRecord.repository as typeof REPOSITORY;
  const candidate = terminalRecord.candidate as typeof CANDIDATE;
  return finalizeStoreHead({
    schemaVersion: '2.0.0',
    canonicalization: HEAD_CANONICALIZATION,
    repository,
    candidate: { commit: candidate.commit, tree: candidate.tree },
    generation,
    state_id: completion.state_id,
    state_digest_sha256: completion.state_digest_sha256,
    completion_record: { ...reference(terminalRecord), attempt_id: terminalRecord.attempt_id },
  });
}

function expectExactReduction(
  records: readonly StoreRecord[],
  expected: {
    errors?: readonly string[];
    ambiguous: boolean;
    failed: boolean;
    completedHead: StoreHead | null;
  },
): void {
  expect(reduceStoreRecords(records)).toEqual({
    ok: (expected.errors?.length ?? 0) === 0,
    records,
    last: records.at(-1) ?? null,
    errors: expected.errors ?? [],
    ambiguous: expected.ambiguous,
    failed: expected.failed,
    completed_head: expected.completedHead,
  });
}

function completedPrefix(count: number): { records: StoreRecord[]; head: StoreHead | null } {
  const records: StoreRecord[] = [];
  let head: StoreHead | null = null;
  for (const [index, transition] of ACTIONS.slice(0, count).entries()) {
    const opening = attempt(records, transition.action, head);
    const completion = terminal(opening, 'completion', transition.state);
    records.push(opening, completion);
    head = expectedHead(completion, index);
  }
  return { records, head };
}

describe('release lifecycle store reduction transition matrix', () => {
  it('binds the exact stale diagnostic inventory without claiming mutation credit', () => {
    expect(STALE_DIAGNOSTIC_IDS).toHaveLength(69);
    expect(new Set(STALE_DIAGNOSTIC_IDS).size).toBe(69);
    expect(PUBLICLY_EQUIVALENT_IDS).toEqual(['1098', '1101']);
    expect(PUBLICLY_EQUIVALENT_IDS.every((id) => STALE_DIAGNOSTIC_IDS.includes(id))).toBe(true);
  });

  it('uses the literal fallback for a non-Error record-identity refusal', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw Object.freeze({ kind: 'non-error-record-refusal' });
        },
      },
    );
    expect(reduceStoreRecords([hostile])).toEqual({
      ok: false,
      records: [],
      last: null,
      errors: ['release-state-store-record-invalid'],
      ambiguous: false,
      failed: false,
      completed_head: null,
    });
  });

  it('reduces every completed transition to the exact next head and terminal flags', () => {
    expectExactReduction([], {
      ambiguous: false,
      failed: false,
      completedHead: null,
    });

    for (let count = 1; count <= ACTIONS.length; count += 1) {
      const { records, head } = completedPrefix(count);
      expectExactReduction(records, {
        ambiguous: false,
        failed: false,
        completedHead: head,
      });
      expect(head).toMatchObject({
        generation: count - 1,
        state_id: records.at(-1)?.completion?.state_id,
        state_digest_sha256: records.at(-1)?.completion?.state_digest_sha256,
        completion_record: {
          ...reference(required(records.at(-1), 'missing terminal record')),
          attempt_id: records.at(-1)?.attempt_id,
        },
      });
    }
  });

  it('preserves pending, failed, retried, and unknown outcomes as distinct full reductions', () => {
    const preflight = completedPrefix(1);
    const pending = attempt(preflight.records, 'release certify', preflight.head);
    expectExactReduction([...preflight.records, pending], {
      ambiguous: true,
      failed: false,
      completedHead: preflight.head,
    });

    const failure = terminal(pending, 'failure', 'certified');
    const failedRecords = [...preflight.records, pending, failure];
    expectExactReduction(failedRecords, {
      ambiguous: false,
      failed: true,
      completedHead: preflight.head,
    });

    const retry = attempt(failedRecords, 'release certify', preflight.head);
    const retriedCompletion = terminal(retry, 'completion', 'certified');
    const retriedRecords = [...failedRecords, retry, retriedCompletion];
    expectExactReduction(retriedRecords, {
      ambiguous: false,
      failed: false,
      completedHead: expectedHead(retriedCompletion, 1),
    });

    const exported = completedPrefix(4);
    const publishAttempt = attempt(exported.records, 'release evidence-publish', exported.head);
    const unknown = terminal(publishAttempt, 'unknown-provider-result', 'evidence_published');
    expectExactReduction([...exported.records, publishAttempt, unknown], {
      ambiguous: true,
      failed: false,
      completedHead: exported.head,
    });
  });

  it('reports append-log, identity, repository, candidate, and observation drift independently', () => {
    const { records, head } = completedPrefix(1);
    const opening = required(records[0], 'missing opening attempt');
    const completion = required(records[1], 'missing completion');
    const cases: readonly {
      name: string;
      value: StoreRecord;
      errors: readonly string[];
    }[] = [
      {
        name: 'sequence',
        value: refinalize(completion, { sequence: 2 }),
        errors: ['release-state-store-sequence-invalid'],
      },
      {
        name: 'predecessor',
        value: refinalize(completion, {
          predecessor_record: { ...reference(opening), record_digest_sha256: '0'.repeat(64) },
        }),
        errors: ['release-state-store-broken-chain', 'release-store-terminal-attempt-link-invalid'],
      },
      {
        name: 'terminal observation',
        value: refinalize(completion, { observed_head_before: head }),
        errors: ['release-state-head-mismatch'],
      },
      {
        name: 'repository',
        value: refinalize(completion, {
          repository: { ...REPOSITORY, id: 'aarusso-nyx/other' },
        }),
        errors: [
          'release-state-store-repository-mismatch',
          'release-store-terminal-attempt-link-invalid',
        ],
      },
      {
        name: 'candidate',
        value: refinalize(completion, {
          candidate: { ...CANDIDATE, commit: 'c'.repeat(40) },
        }),
        errors: [
          'release-state-store-candidate-mismatch',
          'release-store-terminal-attempt-link-invalid',
        ],
      },
    ];
    for (const entry of cases) {
      const result = reduceStoreRecords([opening, entry.value]);
      expect(result, entry.name).toEqual({
        ok: false,
        records: [opening, entry.value],
        last: entry.value,
        errors: entry.errors,
        ambiguous: false,
        failed: false,
        completed_head:
          entry.value.completion === null
            ? null
            : expectedHead(entry.value, (entry.value.observed_head_before?.generation ?? -1) + 1),
      });
    }

    const malformed = { ...opening, record_id: 'RLE-0000000000000000' };
    expect(reduceStoreRecords([malformed])).toEqual({
      ok: false,
      records: [],
      last: null,
      errors: ['release-state-store-record-identity-invalid'],
      ambiguous: false,
      failed: false,
      completed_head: null,
    });
  });

  it('refuses invalid opening attempts with exact error identity and unchanged completed head', () => {
    const certified = completedPrefix(2);
    const valid = attempt(certified.records, 'release prepare', certified.head);
    const prior = required(certified.records.at(-1), 'missing prior completion');
    const wrongAttemptId = refinalize(valid, { attempt_id: 'RLA-0000000000000000' });
    const wrongTransition = attempt(certified.records, 'release publish', certified.head);
    const wrongObservedHead = refinalize(valid, { observed_head_before: null });
    const pendingCertified = certified.records.slice(0, -1);
    const consecutiveAttempt = attempt(
      pendingCertified,
      'release certify',
      completedPrefix(1).head,
    );

    for (const [name, records, errors] of [
      [
        'attempt id',
        [...certified.records, wrongAttemptId],
        ['release-store-opening-attempt-invalid'],
      ],
      [
        'state transition',
        [...certified.records, wrongTransition],
        ['release-state-transition-invalid'],
      ],
      [
        'head observation',
        [...certified.records, wrongObservedHead],
        ['release-state-head-mismatch'],
      ],
      [
        'attempt predecessor',
        [...pendingCertified, consecutiveAttempt],
        ['release-store-attempt-predecessor-invalid'],
      ],
    ] as const) {
      const result = reduceStoreRecords(records);
      expect(result.errors, name).toEqual(errors);
      expect(result.completed_head, name).toEqual(
        name === 'attempt predecessor' ? completedPrefix(1).head : certified.head,
      );
      expect(result.last, name).toEqual(records.at(-1));
    }
    expect(prior.record_kind).toBe('completion');
  });

  it('refuses a first opening attempt that falsely names a predecessor', () => {
    const valid = attempt([], 'release preflight', null);
    const unrelated = required(completedPrefix(1).records.at(-1), 'missing unrelated record');
    const changed = unsafeRefinalize(valid, { predecessor_record: reference(unrelated) }, true);
    withSchemaAccepted(() => {
      expect(reduceStoreRecords([changed])).toEqual({
        ok: false,
        records: [changed],
        last: changed,
        errors: ['release-state-store-broken-chain', 'release-store-opening-attempt-invalid'],
        ambiguous: true,
        failed: false,
        completed_head: null,
      });
    });
  });

  it('refuses every opening-attempt provider observation shape', () => {
    const valid = attempt([], 'release preflight', null);
    const cases = [
      unsafeRefinalize(valid, { provider_handle: 'provider-before-dispatch' }),
      unsafeRefinalize(valid, {
        provider_dispatch: { status: 'dispatched', handle_observed: false },
      }),
      unsafeRefinalize(valid, {
        provider_dispatch: { status: 'not-dispatched', handle_observed: true },
      }),
    ] as const;
    expect(cases).toHaveLength(3);
    withSchemaAccepted(() => {
      for (const changed of cases) {
        expect(reduceStoreRecords([changed])).toEqual({
          ok: false,
          records: [changed],
          last: changed,
          errors: ['release-provider-handle-observation-invalid'],
          ambiguous: true,
          failed: false,
          completed_head: null,
        });
      }
    });
  });

  it('binds authorization presence exactly to local and remote opening attempts', () => {
    const localWithAuthorization = unsafeRefinalize(attempt([], 'release preflight', null), {
      authorization_event_id: `EA-${'1'.repeat(16)}`,
    });
    const exported = completedPrefix(4);
    const remoteWithoutAuthorization = unsafeRefinalize(
      attempt(exported.records, 'release evidence-publish', exported.head),
      { authorization_event_id: null },
    );
    withSchemaAccepted(() => {
      for (const [records, changed, head] of [
        [[localWithAuthorization], localWithAuthorization, null],
        [
          [...exported.records, remoteWithoutAuthorization],
          remoteWithoutAuthorization,
          exported.head,
        ],
      ] as const) {
        expect(reduceStoreRecords(records)).toEqual({
          ok: false,
          records,
          last: changed,
          errors: ['release-authorization-attempt-binding-invalid'],
          ambiguous: true,
          failed: false,
          completed_head: head,
        });
      }
    });
  });

  it('documents terminal-head observation checks as publicly equivalent', () => {
    const prefix = completedPrefix(1);
    const opening = attempt(prefix.records, 'release certify', null);
    // The attempt adds the head mismatch. Give its completion the real head so
    // the outer terminal check passes while the terminal-to-attempt check fails
    // with the same Set member. Removing that inner check cannot change output.
    const completion = refinalize(terminal(opening, 'completion', 'certified'), {
      observed_head_before: prefix.head,
    });
    const result = reduceStoreRecords([...prefix.records, opening, completion]);
    expect(result.errors).toEqual(['release-state-head-mismatch']);
    expect(result.completed_head).toEqual(expectedHead(completion, 1));
    expect(result.last).toEqual(completion);
    expect(PUBLICLY_EQUIVALENT_IDS).toEqual(['1098', '1101']);
  });

  it('binds terminal records to their exact attempt, action, request, authority, and observation', () => {
    const prefix = completedPrefix(4);
    const opening = attempt(prefix.records, 'release evidence-publish', prefix.head);
    const completion = terminal(opening, 'completion', 'evidence_published');
    const differentHead = completedPrefix(3).head;
    const cases: readonly [string, StoreRecord, readonly string[]][] = [
      [
        'attempt',
        refinalize(completion, { attempt_id: 'RLA-0000000000000000' }),
        ['release-store-terminal-attempt-link-invalid'],
      ],
      [
        'action',
        refinalize(completion, { action_id: 'release publish' }),
        ['release-store-terminal-attempt-link-invalid'],
      ],
      [
        'request',
        refinalize(completion, { request_digest_sha256: '0'.repeat(64) }),
        ['release-store-terminal-attempt-link-invalid'],
      ],
      [
        'authority',
        refinalize(completion, { authorization_event_id: 'EA-0000000000000000' }),
        ['release-store-terminal-attempt-link-invalid'],
      ],
      [
        'repository',
        refinalize(completion, { repository: { ...REPOSITORY, id: 'other/repo' } }),
        ['release-state-store-repository-mismatch', 'release-store-terminal-attempt-link-invalid'],
      ],
      [
        'candidate',
        refinalize(completion, { candidate: { ...CANDIDATE, tree: 'c'.repeat(40) } }),
        ['release-state-store-candidate-mismatch', 'release-store-terminal-attempt-link-invalid'],
      ],
      [
        'observation',
        refinalize(completion, { observed_head_before: differentHead }),
        ['release-state-head-mismatch'],
      ],
    ];
    for (const [name, changed, errors] of cases) {
      const result = reduceStoreRecords([...prefix.records, opening, changed]);
      expect(result.errors, name).toEqual(errors);
      expect(result.last, name).toEqual(changed);
      expect(result.ambiguous, name).toBe(false);
      expect(result.failed, name).toBe(false);
    }
  });

  it('keeps completion, failure, and unknown provider outcomes mutually exclusive', () => {
    const exported = completedPrefix(4);
    const remote = attempt(exported.records, 'release evidence-publish', exported.head);
    const completion = terminal(remote, 'completion', 'evidence_published');
    const failure = terminal(remote, 'failure', 'evidence_published');
    const wrongState = refinalize(completion, {
      completion: {
        ...required(completion.completion, 'missing completion'),
        state: 'publication_dispatched',
      },
    });
    const prepared = completedPrefix(3);
    const exportAttempt = attempt(prepared.records, 'release export', prepared.head);
    const exportCompletion = terminal(exportAttempt, 'completion', 'exported');
    const completionWithoutHandle = refinalize(exportCompletion, {
      provider_dispatch: { status: 'failed-before-dispatch', handle_observed: false },
      provider_handle: null,
    });
    const failureWithUnknownDispatch = refinalize(failure, {
      provider_dispatch: { status: 'unknown', handle_observed: true },
      provider_handle: 'provider-failure',
    });

    for (const [name, prefix, opening, changed, expected] of [
      [
        'wrong completion state',
        exported.records,
        remote,
        wrongState,
        'release-store-terminal-attempt-link-invalid',
      ],
      [
        'completion handle',
        prepared.records,
        exportAttempt,
        completionWithoutHandle,
        'release-store-terminal-attempt-link-invalid',
      ],
      [
        'failure dispatch',
        exported.records,
        remote,
        failureWithUnknownDispatch,
        'release-store-terminal-attempt-link-invalid',
      ],
    ] as const) {
      const result = reduceStoreRecords([...prefix, opening, changed]);
      expect(result.errors, name).toEqual([expected]);
      expect(result.completed_head, name).toEqual(
        changed.record_kind === 'completion'
          ? expectedHead(changed, (changed.observed_head_before?.generation ?? -1) + 1)
          : exported.head,
      );
      expect(result.failed, name).toBe(changed.record_kind === 'failure');
      expect(result.ambiguous, name).toBe(false);
    }

    const postExportAttempt = attempt(prepared.records, 'release export', prepared.head);
    const exportUnknown = terminal(postExportAttempt, 'unknown-provider-result', 'exported');
    const wrongUnknownDispatch = refinalize(exportUnknown, {
      provider_dispatch: { status: 'dispatched', handle_observed: true },
    });
    const unknownResult = reduceStoreRecords([
      ...prepared.records,
      postExportAttempt,
      wrongUnknownDispatch,
    ]);
    expect(unknownResult.errors).toEqual(['release-store-completion-unknown-conflict']);
    expect(unknownResult.ambiguous).toBe(true);
    expect(unknownResult.failed).toBe(false);
    expect(unknownResult.completed_head).toEqual(prepared.head);
  });

  it('makes an unknown provider result terminal and requires fresh remote authorization after failure', () => {
    const exported = completedPrefix(4);
    const first = attempt(exported.records, 'release evidence-publish', exported.head);
    const unknown = terminal(first, 'unknown-provider-result', 'evidence_published');
    const afterUnknown = attempt(
      [...exported.records, first, unknown],
      'release evidence-publish',
      exported.head,
    );
    const blocked = reduceStoreRecords([...exported.records, first, unknown, afterUnknown]);
    expect(blocked.errors).toEqual([
      'release-provider-result-unknown',
      'release-store-attempt-predecessor-invalid',
    ]);
    expect(blocked.ambiguous).toBe(true);
    expect(blocked.failed).toBe(false);
    expect(blocked.completed_head).toEqual(exported.head);
    expect(blocked.last).toEqual(afterUnknown);

    const failedAttempt = attempt(exported.records, 'release evidence-publish', exported.head);
    const failure = terminal(failedAttempt, 'failure', 'evidence_published');
    const failedRecords = [...exported.records, failedAttempt, failure];
    const reusedGrant = attempt(
      failedRecords,
      'release evidence-publish',
      exported.head,
      failedAttempt.authorization_event_id,
    );
    const reused = reduceStoreRecords([...failedRecords, reusedGrant]);
    expect(reused.errors).toEqual(['fresh-exact-authorization-required']);
    expect(reused.ambiguous).toBe(true);
    expect(reused.failed).toBe(false);
    expect(reused.completed_head).toEqual(exported.head);

    const freshGrant = attempt(failedRecords, 'release evidence-publish', exported.head);
    expect(freshGrant.authorization_event_id).not.toBe(failedAttempt.authorization_event_id);
    expectExactReduction([...failedRecords, freshGrant], {
      ambiguous: true,
      failed: false,
      completedHead: exported.head,
    });
  });
});
