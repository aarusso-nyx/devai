import { describe, expect, it } from 'vitest';
import { authorizedBoundaryFixture, ruleForTarget } from './authority-boundary-testkit.js';
import {
  CONSENT,
  NOW,
  actionDocument,
  canonicalSha256,
  createIssuer,
  declarationDependencies,
  exactSubject,
  expectFailure,
  expectSuccess,
  fsTarget,
  makePolicyPlant,
  policyBindingFromPlant,
  runtimeApi,
  secondFsTarget,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

// Decision issuer contract cases written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9), for runtime/decision-issuer.ts. The
// existing tests hit each refusal code once through the boundary fixtures; the cases here
// pin the individual subject-exactness rules, the per-field query binding, denial issuance,
// the receipt expiry boundary and the emitted decision fields.

type Target = Record<string, unknown> & { id: string; operation: string };
type Subject = { plan: Record<string, unknown> & { envelope: Record<string, unknown> } };
type Resolution = Record<string, unknown>;

interface Session {
  readonly api: Awaited<ReturnType<typeof runtimeApi>>;
  readonly issuer: AuthorityDecisionIssuer;
  readonly plant: ReturnType<typeof makePolicyPlant>;
  readonly context_receipt: unknown;
  readonly policy: unknown;
  declare(): unknown;
  resolve(target: Target, overrides?: Record<string, unknown>): Resolution;
}

/** One issuer, one declared engineer context, and a plant whose rules are supplied. */
async function session(
  rules: readonly Record<string, unknown>[] = [ruleForTarget(fsTarget)],
  issuerOverrides: Record<string, unknown> = {},
): Promise<Session> {
  const api = await runtimeApi();
  const issuer = createIssuer(api, issuerOverrides);
  const plant = makePolicyPlant({ additiveRules: rules });
  const declare = () =>
    expectSuccess<{ context_receipt: unknown }>(
      api.resolveAuthorityDeclaration(
        {
          action_id: 'test mutate',
          invocation_id: 'invocation-1',
          dry_run: false,
          declaration: { as_role: 'engineer' },
          consent: CONSENT,
        },
        declarationDependencies(
          issuer,
          actionDocument('local-write', { kind: 'human', allowed_roles: ['engineer'] }),
          undefined,
          policyBindingFromPlant(plant),
        ),
      ),
    ).context_receipt;
  const context_receipt = declare();
  const policy = expectSuccess(api.loadAuthorityPolicy({ document: plant.document }, plant.deps));
  return {
    api,
    issuer,
    plant,
    context_receipt,
    policy,
    declare,
    resolve: (target, overrides = {}) =>
      api.resolveAuthorityPolicy(
        policy,
        {
          action_id: 'test mutate',
          context_receipt,
          consent: CONSENT,
          resource: target,
          operation: target.operation,
          ...overrides,
        },
        { receiptStore: issuer, canonicalSha256 },
      ) as Resolution,
  };
}

function allowInput(s: Session, subject: unknown, resolutions: readonly unknown[]) {
  return {
    resolutions,
    subject,
    context_receipt: s.context_receipt,
    invocation_id: 'invocation-1',
    boundary_adapter_id: 'fs-authority-boundary',
  };
}

function issued(result: unknown) {
  const value = result as {
    issued?: boolean;
    receipt?: unknown;
    decision: Record<string, unknown>;
  };
  if (value.issued !== true)
    throw new Error(`expected an issued decision, received ${JSON.stringify(result)}`);
  return value;
}

describe('subject exactness contracts', () => {
  // Mutants 5678, 5679, 5717, 5756, 5757 and the remaining exactTargets guards: each shape
  // that is not one exact plan or one exact batch is refused before any resolution is read.
  it.each<[string, (subject: Subject) => unknown]>([
    [
      'a plan without an envelope',
      (subject) => ({ plan: { ...subject.plan, envelope: undefined } }),
    ],
    [
      'a plan whose envelope has no request',
      (subject) => ({
        plan: { ...subject.plan, envelope: { ...subject.plan.envelope, request: undefined } },
      }),
    ],
    ['an exact plan carrying a batch key', (subject) => ({ ...subject, batch: undefined })],
    ['an exact plan without targets', (subject) => ({ plan: { ...subject.plan, targets: [] } })],
    [
      'an exact plan with batch atomicity',
      (subject) => ({ plan: { ...subject.plan, atomicity: 'whole-batch' } }),
    ],
    [
      'an exact plan with a duplicated target id',
      (subject) => ({
        plan: { ...subject.plan, targets: [fsTarget, { ...secondFsTarget, id: fsTarget.id }] },
      }),
    ],
    [
      'an exact plan with an invalid target',
      (subject) => ({
        plan: { ...subject.plan, targets: [{ ...fsTarget, canonical_relative_path: '/etc' }] },
      }),
    ],
    ['an unknown strategy', (subject) => ({ plan: { ...subject.plan, strategy: 'bulk' } })],
  ])('refuses %s as not exact', async (_name, rewrite) => {
    const s = await session();
    const subject = exactSubject([fsTarget], s.plant) as Subject;
    expectFailure(
      s.issuer.issueAllow(allowInput(s, rewrite(subject), [s.resolve(fsTarget)])),
      'refused',
      'AUTHORITY_DECISION_SUBJECT_NOT_EXACT',
    );
  });

  it.each<[string, (batch: Record<string, unknown>) => Record<string, unknown>]>([
    ['bound to another plan id', (batch) => ({ ...batch, plan_id: 'plan-other' })],
    ['with an empty batch id', (batch) => ({ ...batch, batch_id: ' ' })],
    ['with a fractional ordinal', (batch) => ({ ...batch, ordinal: 1.5 })],
    ['with a negative ordinal', (batch) => ({ ...batch, ordinal: -1 })],
    ['with plan atomicity', (batch) => ({ ...batch, atomicity: 'whole-plan' })],
    ['without targets', (batch) => ({ ...batch, targets: [] })],
    [
      'with more targets than the per-batch bound',
      (batch) => ({
        ...batch,
        targets: [
          fsTarget,
          secondFsTarget,
          { ...fsTarget, id: 'fs:third', canonical_relative_path: 'packages/core/src/third.ts' },
        ],
      }),
    ],
    [
      'with an invalid target',
      (batch) => ({ ...batch, targets: [{ ...fsTarget, canonical_relative_path: 'a\\b' }] }),
    ],
    [
      'with a duplicated target id',
      (batch) => ({ ...batch, targets: [fsTarget, { ...secondFsTarget, id: fsTarget.id }] }),
    ],
    [
      'with one target outside the selectors',
      (batch) => ({
        ...batch,
        targets: [
          fsTarget,
          { ...fsTarget, id: 'fs:docs', canonical_relative_path: 'docs/README.md' },
        ],
      }),
    ],
  ])('refuses a bounded batch %s as not exact', async (_name, rewrite) => {
    const { boundedSubject } = await import('./authority-runtime-testkit.js');
    const s = await session();
    const bounded = boundedSubject([fsTarget], s.plant) as Subject & {
      batch: Record<string, unknown>;
    };
    expectFailure(
      s.issuer.issueAllow(
        allowInput(s, { ...bounded, batch: rewrite(bounded.batch) }, [s.resolve(fsTarget)]),
      ),
      'refused',
      'AUTHORITY_DECISION_SUBJECT_NOT_EXACT',
    );
  });
});

describe('resolution binding contracts', () => {
  // Mutant 5888: a denial among the resolutions is invalid input for an allow.
  it('refuses to issue an allow over a denial resolution', async () => {
    const s = await session();
    const denial = s.resolve(secondFsTarget);
    expect(denial).toMatchObject({ outcome: 'deny' });
    expectFailure(
      s.issuer.issueAllow(allowInput(s, exactSubject([secondFsTarget], s.plant), [denial])),
      'refused',
      'AUTHORITY_DECISION_INPUT_INVALID',
    );
  });

  // Mutants 5895, 5896: two distinct resolutions of the same query are still a duplicate.
  it('refuses two distinct resolutions of the same query as duplicates', async () => {
    const s = await session();
    expectFailure(
      s.issuer.issueAllow(
        allowInput(s, exactSubject([fsTarget], s.plant), [
          s.resolve(fsTarget),
          s.resolve(fsTarget),
        ]),
      ),
      'refused',
      'AUTHORITY_DECISION_RESOLUTION_DUPLICATE',
    );
  });

  // Mutants 5935-5948: each query field is bound on its own — the context it was resolved
  // under, the request action, the resource content, and the consent.
  it('refuses a resolution resolved under another context of the same issuer', async () => {
    const s = await session();
    const resolution = s.resolve(fsTarget);
    const laterContext = s.declare();
    expectFailure(
      s.issuer.issueAllow({
        ...allowInput(s, exactSubject([fsTarget], s.plant), [resolution]),
        context_receipt: laterContext,
      }),
      'refused',
      'AUTHORITY_DECISION_RESOLUTION_QUERY_MISMATCH',
    );
  });

  it.each<[string, (subject: Subject) => unknown]>([
    [
      'request action',
      (subject) => ({
        plan: {
          ...subject.plan,
          envelope: {
            ...subject.plan.envelope,
            request: { ...(subject.plan.envelope.request as object), action_id: 'other action' },
          },
        },
      }),
    ],
    [
      'consent',
      (subject) => ({
        plan: {
          ...subject.plan,
          envelope: {
            ...subject.plan.envelope,
            request: {
              ...(subject.plan.envelope.request as object),
              consent: { ...CONSENT, experimental: true },
            },
          },
        },
      }),
    ],
    [
      'resource content under the same id',
      (subject) => ({
        plan: {
          ...subject.plan,
          targets: [{ ...fsTarget, canonical_relative_path: 'packages/core/src/other.ts' }],
        },
      }),
    ],
  ])('refuses a subject whose %s differs from the resolved query', async (_name, rewrite) => {
    const s = await session();
    const subject = exactSubject([fsTarget], s.plant) as Subject;
    expectFailure(
      s.issuer.issueAllow(allowInput(s, rewrite(subject), [s.resolve(fsTarget)])),
      'refused',
      'AUTHORITY_DECISION_RESOLUTION_QUERY_MISMATCH',
    );
  });

  // Mutants 5866-5870: the allow binds the issuer invocation, not the caller's claim.
  it('refuses an allow claimed under another invocation', async () => {
    const s = await session();
    expectFailure(
      s.issuer.issueAllow({
        ...allowInput(s, exactSubject([fsTarget], s.plant), [s.resolve(fsTarget)]),
        invocation_id: 'invocation-2',
      }),
      'refused',
      'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH',
    );
  });

  it('refuses a context receipt of another issuer', async () => {
    const s = await session();
    const other = await session();
    expectFailure(
      s.issuer.issueAllow({
        ...allowInput(s, exactSubject([fsTarget], s.plant), [s.resolve(fsTarget)]),
        context_receipt: other.context_receipt,
      }),
      'refused',
      'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN',
    );
  });
});

describe('issued decision contracts', () => {
  // Mutants 5779, 5781, 5785, 5796, 5799: an allow names its matched rules, and readiness
  // needs binding enforcement and a live run.
  it('names the matched rules and marks a binding live allow eligible', async () => {
    const s = await session();
    const subject = exactSubject([fsTarget], s.plant);
    const { decision, receipt } = issued(
      s.issuer.issueAllow(allowInput(s, subject, [s.resolve(fsTarget)])),
    );
    expect(decision).toMatchObject({
      evaluation: 'allow',
      disposition: 'proceed',
      reason_code: 'POLICY_ALLOW',
      reasons: ['matched test-fs-allow'],
      plan_id: 'plan-exact',
      enforcement_mode: 'binding',
      obligations: [],
      readiness: { eligible: true, reason: 'Independent acceptance remains required.' },
      subject_digest_sha256: canonicalSha256(subject),
      policy_binding_digest_sha256: canonicalSha256((subject as Subject).plan.envelope.policy),
    });
    expect(decision).not.toHaveProperty('batch_id');
    expect(receipt).toBeDefined();
  });

  it.each<[string, (subject: Subject) => unknown]>([
    [
      'shadow enforcement',
      (subject) => ({
        plan: {
          ...subject.plan,
          envelope: { ...subject.plan.envelope, enforcement_mode: 'shadow' },
        },
      }),
    ],
    [
      'a dry run',
      (subject) => ({
        plan: {
          ...subject.plan,
          envelope: {
            ...subject.plan.envelope,
            request: { ...(subject.plan.envelope.request as object), dry_run: true },
          },
        },
      }),
    ],
  ])('issues an allow under %s that is not readiness eligible', async (_name, rewrite) => {
    const s = await session();
    const subject = rewrite(exactSubject([fsTarget], s.plant) as Subject);
    const { decision } = issued(s.issuer.issueAllow(allowInput(s, subject, [s.resolve(fsTarget)])));
    expect(decision).toMatchObject({ evaluation: 'allow', readiness: { eligible: false } });
  });

  // Mutants 5980-6010, 6016: a denial binds the same way and names its matched deny rule
  // or, without one, its code.
  it('issues a denial naming the matched deny rule', async () => {
    const s = await session([
      { ...ruleForTarget(fsTarget), rule_id: 'test-fs-deny', effect: 'deny' },
    ]);
    const denial = s.resolve(fsTarget);
    expect(denial).toMatchObject({ outcome: 'deny', matched_rule_ids: ['test-fs-deny'] });
    const result = s.issuer.issueDenial({
      invocation_id: 'invocation-1',
      context_receipt: s.context_receipt,
      resolution: denial,
      subject: exactSubject([fsTarget], s.plant),
    });
    expect(result).toMatchObject({ issued: true, outcome: 'deny' });
    expect((result as { decision: Record<string, unknown> }).decision).toMatchObject({
      evaluation: 'deny',
      disposition: 'refuse',
      reason_code: denial.code,
      reasons: ['matched test-fs-deny'],
      readiness: { eligible: false },
    });
  });

  it('issues a denial without a matched rule using its code as the reason', async () => {
    const s = await session();
    const denial = s.resolve(secondFsTarget);
    const result = s.issuer.issueDenial({
      invocation_id: 'invocation-1',
      context_receipt: s.context_receipt,
      resolution: denial,
      subject: exactSubject([secondFsTarget], s.plant),
    });
    expect((result as { decision: Record<string, unknown> }).decision).toMatchObject({
      reason_code: denial.code,
      reasons: [denial.code],
    });
  });

  it.each<[string, (s: Session, denial: Resolution) => Record<string, unknown>, string]>([
    [
      'a non-record context receipt',
      (_s, denial) => ({ context_receipt: 'receipt', resolution: denial }),
      'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN',
    ],
    [
      'an allow resolution',
      (s) => ({ resolution: s.resolve(fsTarget) }),
      'AUTHORITY_DECISION_DENIAL_UNKNOWN',
    ],
    [
      'another invocation',
      (_s, denial) => ({ resolution: denial, invocation_id: 'invocation-2' }),
      'AUTHORITY_DECISION_DENIAL_BINDING_MISMATCH',
    ],
    [
      'a resolution from another context',
      (s, denial) => ({ resolution: denial, context_receipt: s.declare() }),
      'AUTHORITY_DECISION_DENIAL_BINDING_MISMATCH',
    ],
  ])('refuses a denial with %s', async (_name, rewrite, code) => {
    const s = await session();
    const denial = s.resolve(secondFsTarget);
    expectFailure(
      s.issuer.issueDenial({
        invocation_id: 'invocation-1',
        context_receipt: s.context_receipt,
        subject: exactSubject([secondFsTarget], s.plant),
        ...rewrite(s, denial),
      }),
      'refused',
      code,
    );
  });
});

describe('receipt lifecycle contracts', () => {
  // Mutant 6056: a receipt is valid up to and including its expiry instant.
  it.each([
    [0, 'consumes'],
    [1000, 'consumes'],
    [1001, 'refuses'],
  ])('at +%i ms %s the receipt', async (offset, outcome) => {
    let clock = NOW;
    const s = await session([ruleForTarget(fsTarget)], { now: () => clock });
    const subject = exactSubject([fsTarget], s.plant);
    const { receipt } = issued(s.issuer.issueAllow(allowInput(s, subject, [s.resolve(fsTarget)])));
    clock = new Date(Date.parse(NOW) + offset).toISOString();
    const result = s.issuer.consume({
      receipt,
      subject,
      invocation_id: 'invocation-1',
      adapter_id: 'fs-authority-boundary',
    });
    if (outcome === 'consumes') expectSuccess(result);
    else expectFailure(result, 'refused', 'AUTHORITY_DECISION_RECEIPT_EXPIRED');
  });

  // Mutant 6083: disposal reports its effect.
  it('reports disposal exactly once', async () => {
    const api = await runtimeApi();
    const issuer = createIssuer(api);
    expect(issuer.dispose()).toEqual({ ok: true, value: { disposed: true } });
    expectFailure(issuer.dispose(), 'refused', 'AUTHORITY_DECISION_ISSUER_CLOSED');
  });

  it('binds a consumed receipt to its subject, invocation and adapter', async () => {
    const fixture = await authorizedBoundaryFixture(fsTarget);
    const consume = (extra: Record<string, unknown>) =>
      fixture.issuer.consume({
        receipt: fixture.decision_receipt,
        subject: fixture.subject,
        invocation_id: 'invocation-1',
        adapter_id: 'fs-authority-boundary',
        ...extra,
      });
    for (const extra of [
      { adapter_id: 'git-ref-authority-boundary' },
      { invocation_id: 'invocation-2' },
      { subject: {} },
    ]) {
      expectFailure(consume(extra), 'refused', 'AUTHORITY_DECISION_RECEIPT_BINDING_MISMATCH');
    }
    expect(expectSuccess(consume({}))).toMatchObject({
      subject_digest_sha256: canonicalSha256(fixture.subject),
      decision_id: expect.any(String),
      decision_digest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });
});
