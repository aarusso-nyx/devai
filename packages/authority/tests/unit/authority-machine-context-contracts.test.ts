import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSENT,
  actionDocument,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  expectFailure,
  expectSuccess,
  runtimeApi,
  sessionDocument,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

// Machine-context derivation contracts written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's.

type AnyRecord = Record<string, unknown>;
const SESSION_ID = 'AUTH-SESSION-abcdefghijklmnop';
const INVOCATION = 'invocation-binding';
const issuers: AuthorityDecisionIssuer[] = [];
afterEach(() => {
  for (const issuer of issuers.splice(0)) issuer.dispose();
});

function machineAction(subject: AnyRecord = {}) {
  return actionDocument('local-write', {
    kind: 'derived-machine',
    actor: 'binding',
    transition: 'bind',
    initiator: { allowed_roles: ['architect'], preserve_in_context: true },
    ...subject,
  });
}

async function declared(
  document: unknown = machineAction(),
  source: 'cli' | 'session' = 'cli',
  consent: AnyRecord = CONSENT,
) {
  const api = await runtimeApi();
  const issuer = createIssuer(api, { invocation_id: INVOCATION });
  issuers.push(issuer);
  const deps = declarationDependencies(issuer, document, sessionDocument({ role: 'architect' }));
  const declaration = expectSuccess<{ declaration_receipt: unknown }>(
    api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: INVOCATION,
        dry_run: false,
        declaration:
          source === 'cli' ? { as_role: 'architect' } : { authority_session: SESSION_ID },
        consent,
      },
      deps,
    ),
  );
  const origin =
    source === 'cli'
      ? { kind: 'direct-cli', invocation_id: INVOCATION }
      : { kind: 'interactive-session', session_id: SESSION_ID };
  const derive = (input: AnyRecord = {}, depOverrides: AnyRecord = {}) =>
    api.deriveMachineAuthorityContext(
      {
        action_id: 'test mutate',
        invocation_id: INVOCATION,
        declaration_receipt: declaration.declaration_receipt,
        consent,
        ...input,
      },
      {
        actionContracts: deps.actionContracts,
        verifiedOrigin: origin,
        trusted_adapter_id: 'binding-authority',
        receiptStore: issuer,
        canonicalSha256,
        ...depOverrides,
      },
    );
  return { api, issuer, deps, declaration, derive, origin };
}

describe('derivation inputs', () => {
  // Mutants 7140, 7146, 7165: a non-record input, a disposed issuer and a non-record
  // receipt are each refused with their own code.
  it('refuses non-record input and receipts and a disposed issuer', async () => {
    const h = await declared();
    expectFailure(
      h.api.deriveMachineAuthorityContext(null, { receiptStore: h.issuer }),
      'refused',
      'AUTHORITY_DECLARATION_RECEIPT_UNKNOWN',
    );
    expectFailure(
      h.derive({ declaration_receipt: 'receipt' }),
      'refused',
      'AUTHORITY_DECLARATION_RECEIPT_UNKNOWN',
    );
    h.issuer.dispose();
    expectFailure(h.derive(), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
  });

  // Mutant 7186: the contract must still be registered at derivation time.
  it('refuses derivation when the contract is no longer registered', async () => {
    const h = await declared();
    expectFailure(
      h.derive({}, { actionContracts: { get: () => undefined } }),
      'refused',
      'AUTHORITY_ACTION_CONTRACT_NOT_FOUND',
    );
  });
});

describe('subject routing', () => {
  // Mutants 7194, 7195, 7197, 7200-7202: a human-subject declaration never derives a
  // machine context.
  it('refuses derivation from a human-subject declaration', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: INVOCATION });
    issuers.push(issuer);
    const deps = declarationDependencies(issuer, actionDocument());
    const declaration = expectSuccess<{ declaration_receipt: unknown }>(
      api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: INVOCATION,
          dry_run: false,
          declaration: { as_role: 'engineer' },
          consent: CONSENT,
        },
        deps,
      ),
    );
    expectFailure(
      api.deriveMachineAuthorityContext(
        {
          action_id: 'test mutate',
          invocation_id: INVOCATION,
          declaration_receipt: declaration.declaration_receipt,
          consent: CONSENT,
        },
        {
          actionContracts: deps.actionContracts,
          verifiedOrigin: { kind: 'direct-cli', invocation_id: INVOCATION },
          trusted_adapter_id: 'binding-authority',
          receiptStore: issuer,
          canonicalSha256,
        },
      ),
      'refused',
      'AUTHORITY_ACTION_NOT_MACHINE_DERIVED',
    );
  });

  // Mutants 7205, 7209, 7210-7212: only the three authorizing transitions derive; each of
  // them does.
  it.each(['harness-write', 'bind', 'release'])('derives the %s transition', async (transition) => {
    const h = await declared(machineAction({ transition }));
    const value = expectSuccess<{ context: { principal: { derivation: AnyRecord } } }>(h.derive());
    expect(value.context.principal.derivation.transition).toBe(transition);
  });

  it('refuses a non-authorizing transition', async () => {
    const h = await declared(machineAction({ transition: 'deploy' }));
    expectFailure(h.derive(), 'refused', 'AUTHORITY_MACHINE_TRANSITION_NOT_AUTHORIZING');
  });
});

describe('origin and consent binding', () => {
  // Mutants 7239, 7249: the origin kind is checked, not only its identifying field.
  it('refuses a session-kind origin carrying the direct invocation id', async () => {
    const h = await declared();
    expectFailure(
      h.derive({}, { verifiedOrigin: { kind: 'interactive-session', invocation_id: INVOCATION } }),
      'refused',
      'AUTHORITY_MACHINE_ORIGIN_MISMATCH',
    );
  });

  it('refuses a direct-kind origin carrying the session id', async () => {
    const h = await declared(machineAction(), 'session');
    expectFailure(
      h.derive({}, { verifiedOrigin: { kind: 'direct-cli', session_id: SESSION_ID } }),
      'refused',
      'AUTHORITY_MACHINE_ORIGIN_MISMATCH',
    );
  });

  // Mutants 7261, 7263: the derived consent must be exactly the contract's consent, even
  // when the declaration itself carried a wider consent.
  it('refuses consent above the contract even when the declaration carried it', async () => {
    const wider = { ...CONSENT, allow_publish: true };
    const h = await declared(machineAction(), 'cli', wider);
    expectFailure(h.derive(), 'refused', 'AUTHORITY_MACHINE_CONSENT_MISSING');
  });
});
