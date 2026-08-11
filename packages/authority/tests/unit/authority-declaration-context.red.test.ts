import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSENT,
  NOW,
  actionDocument,
  createIssuer,
  declarationDependencies,
  expectFailure,
  expectSuccess,
  runtimeApi,
  sessionDocument,
} from './authority-runtime-testkit.js';

// Invariants: INV-AUTH-001, INV-AUTH-004

const SESSION_ID = 'AUTH-SESSION-abcdefghijklmnop';

afterEach(() => {
  delete process.env.DEVAI_ROLE;
  delete process.env.DEVAI_SESSION;
});

describe('R19 authority declaration resolution', () => {
  it('lets an explicit read action proceed without a declaration', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-read' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test read',
        invocation_id: 'invocation-read',
        dry_run: false,
        declaration: {},
        consent: { write: false, allow_publish: false, experimental: false },
      },
      declarationDependencies(issuer, actionDocument('read')),
    );
    const value = expectSuccess<{ principal: unknown; declaration_receipt: unknown }>(result);
    expect(value.principal).toBeNull();
    expect(value.declaration_receipt).toBeNull();
  });

  it.each([{ as_role: 'engineer' }, { authority_session: SESSION_ID }])(
    'refuses a %s declaration for a read action',
    async (declaration) => {
      const api = await runtimeApi();
      const issuer = createIssuer(api, { invocation_id: 'invocation-read' });
      const result = api.resolveAuthorityDeclaration(
        {
          action_id: 'test read',
          invocation_id: 'invocation-read',
          dry_run: false,
          declaration,
          consent: { write: false, allow_publish: false, experimental: false },
        },
        declarationDependencies(issuer, actionDocument('read'), sessionDocument()),
      );
      expectFailure(result, 'usage-error', 'AUTHORITY_DECLARATION_NOT_APPLICABLE');
    },
  );

  it.each([
    [{}, false],
    [{}, true],
  ])('requires a declaration for mutation even when dry_run=%s', async (declaration, dryRun) => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-mutate',
        dry_run: dryRun,
        declaration,
        consent: CONSENT,
        action_effect: 'read',
      },
      declarationDependencies(issuer),
    );
    expectFailure(result, 'usage-error', 'AUTHORITY_DECLARATION_MISSING');
  });

  it('refuses conflicting role and session sources', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-mutate',
        dry_run: false,
        declaration: { as_role: 'engineer', authority_session: SESSION_ID },
        consent: CONSENT,
      },
      declarationDependencies(issuer, actionDocument(), sessionDocument()),
    );
    expectFailure(result, 'usage-error', 'AUTHORITY_DECLARATION_CONFLICT');
  });

  it('refuses a malformed authority-session identifier as usage', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-session' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-session',
        dry_run: false,
        declaration: { authority_session: '../not-a-session' },
        consent: CONSENT,
      },
      declarationDependencies(issuer),
    );
    expectFailure(result, 'usage-error', 'AUTHORITY_SESSION_ID_INVALID');
  });

  it('fails closed when the action contract is absent or invalid', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
    const input = {
      action_id: 'test mutate',
      invocation_id: 'invocation-mutate',
      dry_run: false,
      declaration: { as_role: 'engineer' },
      consent: CONSENT,
    };
    const absent = api.resolveAuthorityDeclaration(
      input,
      declarationDependencies(issuer, actionDocument('read')),
    );
    expectFailure(absent, 'refused', 'AUTHORITY_ACTION_CONTRACT_NOT_FOUND');
    const invalid = api.resolveAuthorityDeclaration(input, {
      ...declarationDependencies(issuer),
      actionContracts: { get: () => ({ raw: {}, canonical_bytes: new Uint8Array(), view: {} }) },
    });
    expectFailure(invalid, 'refused', 'AUTHORITY_ACTION_CONTRACT_INVALID');
  });

  it('takes consent from the validated action contract rather than caller effect metadata', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-mutate',
        dry_run: false,
        declaration: { as_role: 'engineer' },
        consent: { write: false, allow_publish: false, experimental: false },
        effect: 'read',
        subject: { kind: 'none' },
      },
      declarationDependencies(issuer),
    );
    expectFailure(result, 'refused', 'AUTHORITY_ACTION_CONSENT_MISMATCH');
  });

  it('accepts explicit invocation consent above the contract minimum without permitting consent loss', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
    const input = {
      action_id: 'test mutate',
      invocation_id: 'invocation-mutate',
      dry_run: false,
      declaration: { as_role: 'engineer' },
    };
    expectSuccess(
      api.resolveAuthorityDeclaration(
        {
          ...input,
          consent: { write: true, allow_publish: true, experimental: true },
        },
        declarationDependencies(issuer),
      ),
    );
    expectFailure(
      api.resolveAuthorityDeclaration(
        {
          ...input,
          consent: { write: false, allow_publish: true, experimental: true },
        },
        declarationDependencies(issuer),
      ),
      'refused',
      'AUTHORITY_ACTION_CONSENT_MISMATCH',
    );
  });

  it('uses a dedicated denial for a valid human role outside action allowed_roles', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-mutate',
        dry_run: false,
        declaration: { as_role: 'architect' },
        consent: CONSENT,
      },
      declarationDependencies(issuer),
    );
    expectFailure(result, 'refused', 'AUTHORITY_HUMAN_ROLE_DENIED');
  });

  it.each(['actor', 'machine_actor', 'transition', 'machine_transition', 'principal'])(
    'refuses caller-selected machine field %s before derivation',
    async (field) => {
      const api = await runtimeApi();
      const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
      const result = api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-mutate',
          dry_run: false,
          declaration: { as_role: 'engineer', [field]: 'binding' },
          consent: CONSENT,
        },
        declarationDependencies(issuer),
      );
      expectFailure(result, 'usage-error', 'AUTHORITY_MACHINE_DECLARATION_FORBIDDEN');
    },
  );

  it('refuses any other unknown declaration field rather than scrubbing it', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-mutate',
        dry_run: false,
        declaration: { as_role: 'engineer', inferred_role: 'engineer' },
        consent: CONSENT,
      },
      declarationDependencies(issuer),
    );
    expectFailure(result, 'usage-error', 'AUTHORITY_DECLARATION_FIELD_INVALID');
  });

  it.each(['harness', 'bootstrap', 'binding', 'release'])(
    'refuses caller-selected machine actor %s as a human role',
    async (actor) => {
      const api = await runtimeApi();
      const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
      const result = api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-mutate',
          dry_run: false,
          declaration: { as_role: actor },
          consent: CONSENT,
        },
        declarationDependencies(issuer),
      );
      expectFailure(result, 'usage-error', 'AUTHORITY_ROLE_INVALID');
    },
  );

  it('ignores environment-only role and session claims', async () => {
    process.env.DEVAI_ROLE = 'engineer';
    process.env.DEVAI_SESSION = SESSION_ID;
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-mutate' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-mutate',
        dry_run: false,
        declaration: {},
        consent: CONSENT,
      },
      declarationDependencies(issuer, actionDocument(), sessionDocument()),
    );
    expectFailure(result, 'usage-error', 'AUTHORITY_DECLARATION_MISSING');
  });

  it('retains direct CLI provenance without a session ID', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-direct' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-direct',
        dry_run: false,
        declaration: { as_role: 'engineer' },
        consent: CONSENT,
      },
      declarationDependencies(issuer),
    );
    const value = expectSuccess<{ principal: { declaration: Record<string, unknown> } }>(result);
    expect(value.principal.declaration).toMatchObject({ source: 'cli-flag' });
    expect(value.principal.declaration).not.toHaveProperty('session_id');
  });

  it('retains persisted-session provenance and the real session ID', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-session' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-session',
        dry_run: false,
        declaration: { authority_session: SESSION_ID },
        consent: CONSENT,
      },
      declarationDependencies(issuer, actionDocument(), sessionDocument()),
    );
    const value = expectSuccess<{ principal: { declaration: Record<string, unknown> } }>(result);
    expect(value.principal.declaration).toMatchObject({
      source: 'session-state',
      session_id: SESSION_ID,
    });
  });

  it.each([
    ['AUTHORITY_SESSION_NOT_FOUND', undefined],
    ['AUTHORITY_SESSION_EXPIRED', sessionDocument({ status: 'expired' })],
    ['AUTHORITY_SESSION_EXPIRED', sessionDocument({ expires_at: NOW })],
    [
      'AUTHORITY_SESSION_REVOKED',
      sessionDocument({
        status: 'revoked',
        revocation: {
          revoked_at: NOW,
          revoked_by_invocation_id: 'invocation-revoke',
          reason: 'owner revoked',
        },
      }),
    ],
    [
      'AUTHORITY_SESSION_STALE',
      sessionDocument({ status: 'stale', stale_reason: 'policy-changed' }),
    ],
    ['AUTHORITY_SESSION_REPOSITORY_MISMATCH', sessionDocument({ repository_id: 'other-repo' })],
    [
      'AUTHORITY_SESSION_POLICY_MISMATCH',
      sessionDocument({
        policy_binding: {
          policy_id: 'devai-authority',
          policy_version: '1.0.0',
          resolved_digest_sha256: 'f'.repeat(64),
        },
      }),
    ],
    [
      'AUTHORITY_SESSION_CONSTITUTION_MISMATCH',
      sessionDocument({
        constitution_binding: { version: '0.5.0', digest_sha256: 'f'.repeat(64) },
      }),
    ],
    [
      'AUTHORITY_SESSION_PACKAGE_MISMATCH',
      sessionDocument({ package_binding: { name: '@aarusso-nyx/devai', version: '0.5.0' } }),
    ],
  ])('returns refused/%s for an invalid persisted session', async (code, session) => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-session' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-session',
        dry_run: false,
        declaration: { authority_session: SESSION_ID },
        consent: CONSENT,
      },
      declarationDependencies(issuer, actionDocument(), session),
    );
    expectFailure(result, 'refused', code);
  });

  it('returns schema failure and validator outage as distinct tagged data', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-session' });
    const base = declarationDependencies(issuer, actionDocument(), sessionDocument());
    const input = {
      action_id: 'test mutate',
      invocation_id: 'invocation-session',
      dry_run: false,
      declaration: { authority_session: SESSION_ID },
      consent: CONSENT,
    };
    const invalid = api.resolveAuthorityDeclaration(input, {
      ...base,
      validateSessionSchema: () => ({
        ok: false,
        category: 'refused',
        code: 'AUTHORITY_SESSION_SCHEMA_INVALID',
        reasons: ['fixture invalid'],
      }),
    });
    expectFailure(invalid, 'refused', 'AUTHORITY_SESSION_SCHEMA_INVALID');
    const unavailable = api.resolveAuthorityDeclaration(input, {
      ...base,
      validateSessionSchema: () => ({
        ok: false,
        category: 'dependency-error',
        code: 'AUTHORITY_SESSION_VALIDATOR_UNAVAILABLE',
        reasons: ['fixture unavailable'],
      }),
    });
    expectFailure(unavailable, 'dependency-error', 'AUTHORITY_SESSION_VALIDATOR_UNAVAILABLE');
  });

  it('recomputes the session digest before status and binding checks', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-session' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-session',
        dry_run: false,
        declaration: { authority_session: SESSION_ID },
        consent: CONSENT,
      },
      declarationDependencies(
        issuer,
        actionDocument(),
        sessionDocument({ status: 'expired', session_digest_sha256: 'f'.repeat(64) }),
      ),
    );
    expectFailure(result, 'refused', 'AUTHORITY_SESSION_DIGEST_MISMATCH');
  });

  it('returns a session-store outage as dependency data rather than authority denial', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-session' });
    const result = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-session',
        dry_run: false,
        declaration: { authority_session: SESSION_ID },
        consent: CONSENT,
      },
      {
        ...declarationDependencies(issuer),
        readSession: () => ({
          ok: false,
          category: 'dependency-error',
          code: 'AUTHORITY_SESSION_STORE_UNAVAILABLE',
          reasons: ['fixture unavailable'],
        }),
      },
    );
    expectFailure(result, 'dependency-error', 'AUTHORITY_SESSION_STORE_UNAVAILABLE');
  });
});

describe('R19 trusted machine-context derivation', () => {
  function machineAction(): unknown {
    return actionDocument('local-write', {
      kind: 'derived-machine',
      actor: 'binding',
      transition: 'bind',
      initiator: { allowed_roles: ['architect'], preserve_in_context: true },
    });
  }

  async function directDeclaration() {
    const api = await runtimeApi();
    const issuer = createIssuer(api, { invocation_id: 'invocation-binding' });
    const deps = declarationDependencies(issuer, machineAction());
    const declaration = api.resolveAuthorityDeclaration(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-binding',
        dry_run: false,
        declaration: { as_role: 'architect' },
        consent: CONSENT,
      },
      deps,
    );
    return {
      api,
      issuer,
      actionContracts: deps.actionContracts,
      declaration: expectSuccess<{ declaration_receipt: unknown }>(declaration),
    };
  }

  it('derives direct-CLI machine context and preserves its initiating Architect and consent', async () => {
    const { api, issuer, actionContracts, declaration } = await directDeclaration();
    const result = api.deriveMachineAuthorityContext(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-binding',
        declaration_receipt: declaration.declaration_receipt,
        consent: CONSENT,
      },
      {
        actionContracts,
        verifiedOrigin: { kind: 'direct-cli', invocation_id: 'invocation-binding' },
        trusted_adapter_id: 'binding-authority',
        receiptStore: issuer,
        canonicalSha256: (await import('./authority-runtime-testkit.js')).canonicalSha256,
      },
    );
    const value = expectSuccess<{
      context: { initiated_by: { role: string }; consent: typeof CONSENT };
    }>(result);
    expect(value.context.initiated_by.role).toBe('architect');
    expect(value.context.consent).toEqual(CONSENT);
  });

  it('refuses a direct flag with a non-direct invocation origin', async () => {
    const { api, issuer, actionContracts, declaration } = await directDeclaration();
    const result = api.deriveMachineAuthorityContext(
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-binding',
        declaration_receipt: declaration.declaration_receipt,
        consent: CONSENT,
      },
      {
        actionContracts,
        verifiedOrigin: { kind: 'interactive-session', session_id: SESSION_ID },
        trusted_adapter_id: 'binding-authority',
        receiptStore: issuer,
        canonicalSha256: (await import('./authority-runtime-testkit.js')).canonicalSha256,
      },
    );
    expectFailure(result, 'refused', 'AUTHORITY_MACHINE_ORIGIN_MISMATCH');
  });

  it('refuses structural-cloned and replayed declaration receipts', async () => {
    const first = await directDeclaration();
    const deps = {
      actionContracts: first.actionContracts,
      verifiedOrigin: { kind: 'direct-cli', invocation_id: 'invocation-binding' },
      trusted_adapter_id: 'binding-authority',
      receiptStore: first.issuer,
      canonicalSha256: (await import('./authority-runtime-testkit.js')).canonicalSha256,
    };
    const input = {
      action_id: 'test mutate',
      invocation_id: 'invocation-binding',
      declaration_receipt: first.declaration.declaration_receipt,
      consent: CONSENT,
    };
    const cloned = first.api.deriveMachineAuthorityContext(
      { ...input, declaration_receipt: { ...(first.declaration.declaration_receipt as object) } },
      deps,
    );
    expectFailure(cloned, 'refused', 'AUTHORITY_DECLARATION_RECEIPT_UNKNOWN');
    expectSuccess(first.api.deriveMachineAuthorityContext(input, deps));
    expectFailure(
      first.api.deriveMachineAuthorityContext(input, deps),
      'refused',
      'AUTHORITY_DECLARATION_RECEIPT_REPLAYED',
    );
  });

  it.each([
    [
      'action',
      { action_id: 'different action', invocation_id: 'invocation-binding', consent: CONSENT },
    ],
    [
      'invocation',
      { action_id: 'test mutate', invocation_id: 'different-invocation', consent: CONSENT },
    ],
    [
      'consent',
      {
        action_id: 'test mutate',
        invocation_id: 'invocation-binding',
        consent: { ...CONSENT, experimental: true },
      },
    ],
  ])('refuses %s substitution across the declaration receipt binding', async (_name, changes) => {
    const first = await directDeclaration();
    const result = first.api.deriveMachineAuthorityContext(
      {
        ...changes,
        declaration_receipt: first.declaration.declaration_receipt,
      },
      {
        actionContracts: first.actionContracts,
        verifiedOrigin: { kind: 'direct-cli', invocation_id: 'invocation-binding' },
        trusted_adapter_id: 'binding-authority',
        receiptStore: first.issuer,
        canonicalSha256: (await import('./authority-runtime-testkit.js')).canonicalSha256,
      },
    );
    expectFailure(result, 'refused', 'AUTHORITY_DECLARATION_RECEIPT_BINDING_MISMATCH');
  });
});
