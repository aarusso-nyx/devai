import { describe, expect, it } from 'vitest';
import {
  CONSENT,
  actionDocument,
  actionDocumentWithId,
  createIssuer,
  declarationDependencies,
  expectFailure,
  expectSuccess,
  runtimeApi,
  sessionDocument,
} from './authority-runtime-testkit.js';

// Declaration resolution contracts written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's.

type AnyRecord = Record<string, unknown>;
const SESSION_ID = 'AUTH-SESSION-abcdefghijklmnop';
const MACHINE_SUBJECT = {
  kind: 'derived-machine',
  actor: 'binding',
  transition: 'bind',
  initiator: { allowed_roles: ['engineer'] },
};

async function harness(document: unknown = actionDocument(), session?: unknown) {
  const api = await runtimeApi();
  const issuer = createIssuer(api);
  const deps = declarationDependencies(issuer, document, session);
  const input = (overrides: AnyRecord = {}) => ({
    action_id: 'test mutate',
    invocation_id: 'invocation-1',
    dry_run: false,
    declaration: { as_role: 'engineer' },
    consent: CONSENT,
    ...overrides,
  });
  return {
    api,
    issuer,
    deps,
    input,
    declare: (overrides: AnyRecord = {}, depOverrides: AnyRecord = {}) =>
      api.resolveAuthorityDeclaration(input(overrides), { ...deps, ...depOverrides }),
  };
}

describe('declaration input shape', () => {
  // Mutants 6117, 6149: a non-record input, dependency set or declaration is a usage error.
  it('refuses non-record input, dependencies and declarations', async () => {
    const h = await harness();
    expectFailure(
      h.api.resolveAuthorityDeclaration(null, h.deps),
      'usage-error',
      'AUTHORITY_DECLARATION_FIELD_INVALID',
    );
    expectFailure(
      h.api.resolveAuthorityDeclaration(h.input(), 'deps'),
      'usage-error',
      'AUTHORITY_DECLARATION_FIELD_INVALID',
    );
    expectFailure(
      h.declare({ declaration: 'engineer' }),
      'usage-error',
      'AUTHORITY_DECLARATION_FIELD_INVALID',
    );
  });

  // Mutant 6175: a disposed issuer cannot record a declaration.
  it('refuses a declaration once the issuer is disposed', async () => {
    const h = await harness();
    h.issuer.dispose();
    expectFailure(h.declare(), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
  });

  // Mutants 6100-6105: the contract returned by the registry must carry the requested
  // action id and well-formed subject and consent records.
  it('refuses a contract registered under the requested id but describing another action', async () => {
    const other = actionDocumentWithId('other action', 'local-write', {
      kind: 'human',
      allowed_roles: ['engineer'],
    });
    const h = await harness();
    expectFailure(
      h.declare({}, { actionContracts: { get: () => other } }),
      'refused',
      'AUTHORITY_ACTION_CONTRACT_INVALID',
    );
  });

  it.each([
    ['subject', (view: AnyRecord) => (view.subject = 'human')],
    ['consent', (view: AnyRecord) => (view.consent = null)],
  ])('refuses a contract whose %s is not a record', async (_name, edit) => {
    const document = actionDocument() as { view: AnyRecord };
    edit(document.view);
    const h = await harness(document);
    expectFailure(h.declare(), 'refused', 'AUTHORITY_ACTION_CONTRACT_INVALID');
  });
});

describe('consent contract', () => {
  // Mutants 6216, 6225, 6226: every consent key is a boolean and no other key is present.
  it.each([
    ['a non-boolean optional key', { ...CONSENT, allow_publish: 'no' }],
    ['an unknown key beside valid ones', { ...CONSENT, extra: true }],
  ])('refuses consent with %s', async (_name, consent) => {
    const h = await harness();
    expectFailure(h.declare({ consent }), 'refused', 'AUTHORITY_ACTION_CONSENT_MISMATCH');
  });
});

describe('read declarations', () => {
  // Mutants 6191, 6192: a read declaration reports itself as a read.
  it('reports a read declaration as a read with no principal', async () => {
    const h = await harness(actionDocument('read'));
    const value = expectSuccess<AnyRecord>(
      h.declare({
        action_id: 'test read',
        declaration: {},
        consent: { write: false, allow_publish: false, experimental: false },
      }),
    );
    expect(value).toMatchObject({
      kind: 'read',
      action_id: 'test read',
      action_effect: 'read',
      principal: null,
      declaration_receipt: null,
    });
    expect(value.context_receipt).toEqual(expect.any(Object));
  });
});

describe('persisted session shapes', () => {
  const declareWithSession = async (validated: unknown, expected?: [string, string]) => {
    const h = await harness(actionDocument(), sessionDocument());
    const result = h.declare(
      { declaration: { authority_session: SESSION_ID } },
      { validateSessionSchema: () => ({ ok: true, value: validated }) },
    );
    if (expected) expectFailure(result, expected[0] as 'refused', expected[1]);
    else
      expect(
        expectSuccess<{ principal: { declaration: AnyRecord } }>(result).principal.declaration,
      ).toMatchObject({ source: 'session-state', session_id: SESSION_ID });
  };
  const view = () => (sessionDocument() as { view: AnyRecord }).view;

  // Mutants 6280, 6282, 6288, 6290: the validator may return the bare session view or a
  // wrapper without raw bytes; both resolve the session.
  it('accepts a bare session view and a wrapper without raw', async () => {
    await declareWithSession(view());
    await declareWithSession({ view: view() });
  });

  // Mutant 6285: a non-record session is a schema refusal.
  it('refuses a non-record session', async () => {
    await declareWithSession('session', ['refused', 'AUTHORITY_SESSION_SCHEMA_INVALID']);
  });

  // Mutant 6289: the digest is recomputed over the raw document when one is supplied.
  it('refuses a wrapper whose raw document differs from its view', async () => {
    await declareWithSession({ view: view(), raw: { ...view(), extra: true } }, [
      'refused',
      'AUTHORITY_SESSION_DIGEST_MISMATCH',
    ]);
  });

  // Mutants 6330-6337: each policy-binding field of the session is checked on its own.
  it.each([
    ['no binding', null],
    ['another policy id', { policy_id: 'other-policy', policy_version: '1.0.0' }],
    ['another policy version', { policy_id: 'devai-authority', policy_version: '2.0.0' }],
  ])('refuses a session with %s', async (_name, binding) => {
    const base = view();
    const policy_binding =
      binding === null ? null : { ...(base.policy_binding as AnyRecord), ...binding };
    const h = await harness(actionDocument(), sessionDocument({ policy_binding }));
    expectFailure(
      h.declare({ declaration: { authority_session: SESSION_ID } }),
      'refused',
      'AUTHORITY_SESSION_POLICY_MISMATCH',
    );
  });
});

describe('declaration outcomes by subject', () => {
  // Mutants 6378, 6389: the outcome kind names the subject route.
  it('returns a human outcome for a human subject', async () => {
    const h = await harness();
    const value = expectSuccess<AnyRecord>(h.declare());
    expect(value).toMatchObject({ kind: 'human', action_effect: 'local-write' });
    expect(value.principal).toMatchObject({ kind: 'human', role: 'engineer' });
    expect(value.context_receipt).toEqual(expect.any(Object));
  });

  it('returns a machine-initiation outcome for a derived-machine subject', async () => {
    const h = await harness(actionDocument('local-write', MACHINE_SUBJECT));
    const value = expectSuccess<AnyRecord>(h.declare());
    expect(value).toMatchObject({
      kind: 'machine-initiation',
      action_effect: 'local-write',
      context_receipt: null,
    });
    expect(value.initiated_by).toMatchObject({ kind: 'human', role: 'engineer' });
    expect(value.declaration_receipt).toEqual(expect.any(Object));
  });

  // Mutants 6362, 6363: a derived-machine subject without an initiator admits no role and
  // is refused rather than thrown.
  it('denies every role for a derived-machine subject without an initiator', async () => {
    const { initiator: _initiator, ...subject } = MACHINE_SUBJECT;
    const h = await harness(actionDocument('local-write', subject));
    expectFailure(h.declare(), 'refused', 'AUTHORITY_HUMAN_ROLE_DENIED');
  });
});
