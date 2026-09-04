import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import { createLifecyclePolicyFixture } from '../helpers/release-policy-resolution-fixture.js';
import {
  ReleaseLifecycleFileStore,
  executeReleaseLifecycleAction,
  resumeReleaseLifecycleExecution,
  type ReleaseLifecycleRequest,
} from '../../src/services/release-lifecycle-execution.js';

const POLICY_FIXTURE = createLifecyclePolicyFixture();
const REPOSITORY = POLICY_FIXTURE.candidate.repository;
const CANDIDATE = {
  release_unit: '@aarusso-nyx/devai',
  version: '1.5.0',
  commit: REPOSITORY.commit,
  tree: REPOSITORY.tree,
} as const;

function readSchema(path: string): Readonly<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(process.cwd(), path), 'utf8')) as Readonly<
    Record<string, unknown>
  >;
}

function example(path: string): Readonly<Record<string, unknown>> {
  const schema = readSchema(path) as {
    readonly examples?: readonly Readonly<Record<string, unknown>>[];
  };
  const value = schema.examples?.[0];
  if (value === undefined) throw new Error(`missing example: ${path}`);
  return value;
}

function rehashReceipt(
  receipt: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { receipt_id: _id, receipt_digest_sha256: _digest, ...projection } = receipt;
  const digest = canonicalSha256(projection);
  return { ...projection, receipt_id: `RPL-${digest.slice(0, 16)}`, receipt_digest_sha256: digest };
}

/** Uses the unchanged v1 schema example; only fixture identities and canonical receipt identity vary. */
function historicalReceipt(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const original = example('law/schemas/release-plan-receipt.schema.json');
  return rehashReceipt({
    ...original,
    repository: REPOSITORY,
    candidate: CANDIDATE,
    ...overrides,
  });
}

function resume(input: Readonly<Record<string, unknown>> = {}) {
  return resumeReleaseLifecycleExecution({
    states: [],
    repository: REPOSITORY,
    candidate: CANDIDATE,
    ...input,
  });
}

function rehashObservation(
  observation: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const {
    observation_id: _id,
    observation_digest_sha256: _digest,
    ...projection
  } = {
    ...observation,
    ...overrides,
  };
  const digest = canonicalSha256(projection);
  return {
    ...projection,
    observation_id: `RLO-${digest.slice(0, 16)}`,
    observation_digest_sha256: digest,
  };
}

describe('release historical resume observation', () => {
  it('keeps the original 1.0.0 observation shape readable without changing its bytes', () => {
    const historical = example('law/schemas/release-lifecycle-observation.schema.json');
    expect(JSON.stringify(parsers.releaseLifecycleObservation.parse(historical))).toBe(
      JSON.stringify(historical),
    );
  });

  it('observes an intact v1 plan as non-authoritative without replaying legacy inputs or providers', async () => {
    const resolvePlanInput = vi.fn();
    const observation = await resume({
      receipt_documents: [historicalReceipt()],
      resolve_plan_input: resolvePlanInput,
      publication_receipt: { forged: true },
      verify_signature: vi.fn(),
    });

    expect(observation).toMatchObject({
      schemaVersion: '1.1.0',
      next_outcome: 'blocked',
      next_action: null,
      blocked_reason: 'legacy-plan-non-authoritative',
      blocked_requirements: [],
      derived_states: [],
      published: { observed: false, receipt: null, verified_against: null },
      emitted_by: {
        action_id: 'release resume',
        effect: 'read',
        persists_repository_state: false,
        appends_state_record: false,
        writes_receipt_file: false,
      },
      grants: {
        authority: false,
        publication_authority: false,
        lifecycle_transition: false,
        appends_published_state: false,
      },
    });
    expect(observation).not.toHaveProperty('reconciliation_requirements');
    expect(resolvePlanInput).not.toHaveBeenCalled();
  });

  it('keeps a valid mixed v1/v2 candidate set historical', async () => {
    const observation = await resume({
      candidate_locator: {
        commit: REPOSITORY.commit,
        tree: REPOSITORY.tree,
        release_units: [
          {
            release_unit: CANDIDATE.release_unit,
            version: CANDIDATE.version,
            package_roster: [
              {
                package_id: CANDIDATE.release_unit,
                manifest_path: 'package.json',
                manifest_digest_sha256: canonicalSha256(POLICY_FIXTURE.package_json),
              },
            ],
          },
        ],
      },
      receipt_documents: [historicalReceipt(), POLICY_FIXTURE.receipt],
      resolve_plan_input: POLICY_FIXTURE.resolve_plan_input,
    });

    expect(observation).toMatchObject({
      schemaVersion: '1.1.0',
      next_outcome: 'blocked',
      next_action: null,
      blocked_reason: 'legacy-plan-non-authoritative',
      derived_states: [],
      published: { observed: false, receipt: null, verified_against: null },
    });
  });

  it.each([
    ['malformed v1 schema', { unexpected: true }],
    ['bad v1 digest', { receipt_digest_sha256: '0'.repeat(64) }],
    ['foreign candidate', { candidate: { ...CANDIDATE, tree: 'f'.repeat(40) } }],
    ['unknown plan version', { schemaVersion: '9.9.9' }],
  ])('preserves generic refusal for %s', async (_name, overrides) => {
    const receipt = historicalReceipt(overrides);
    const refused = await resume({
      receipt_documents: [
        _name === 'bad v1 digest' ? { ...receipt, receipt_digest_sha256: '0'.repeat(64) } : receipt,
      ],
    });
    expect(refused).toMatchObject({
      next_outcome: 'blocked',
      next_action: null,
      blocked_reason: 'receipt-identity-mismatch',
      derived_states: [],
      published: { observed: false, receipt: null, verified_against: null },
    });
  });

  it('keeps a broken state chain ahead of historical classification', async () => {
    const refused = await resume({
      states: [{ schemaVersion: 'malformed' }],
      receipt_documents: [historicalReceipt()],
    });
    expect(refused).toMatchObject({
      next_outcome: 'blocked',
      next_action: null,
      blocked_reason: 'broken-chain',
      derived_states: [],
    });
  });

  it('never admits a v1 receipt to a current lifecycle action', async () => {
    const receipt = historicalReceipt();
    const request: ReleaseLifecycleRequest = {
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: 'release preflight',
      repository_locator: REPOSITORY,
      candidate_locator: {
        commit: REPOSITORY.commit,
        tree: REPOSITORY.tree,
        release_units: [
          {
            release_unit: CANDIDATE.release_unit,
            version: CANDIDATE.version,
            package_roster: [
              {
                package_id: CANDIDATE.release_unit,
                manifest_path: 'package.json',
                manifest_digest_sha256: canonicalSha256(POLICY_FIXTURE.package_json),
              },
            ],
          },
        ],
      },
      receipt_locators: [
        {
          kind: 'release-plan-receipt',
          receipt_id: String(receipt['receipt_id']),
          receipt_digest_sha256: String(receipt['receipt_digest_sha256']),
          path: 'receipts/historical-plan.json',
        },
      ],
    };
    const provider = vi.fn();
    const result = await executeReleaseLifecycleAction({
      request,
      action: 'release preflight',
      authority: {
        actor: { kind: 'human', role: 'inspector', declaration_source: 'cli-flag' },
        consent: { write: true, allow_publish: false, experimental: false },
      },
      store: new ReleaseLifecycleFileStore('/tmp/devai-historical-resume-action', request),
      resolveReceipt: () => receipt,
      provider,
      recorded_at: '2026-09-03T00:00:00.000Z',
    });
    expect(result).toMatchObject({ ok: false, code: 'rpl-legacy-plan-non-authoritative' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects every closed-shape escalation of a historical observation', async () => {
    const historical = await resume({ receipt_documents: [historicalReceipt()] });
    const publication = {
      kind: 'release-publication-receipt',
      receipt_id: `RPU-${'a'.repeat(16)}`,
      receipt_digest_sha256: 'a'.repeat(64),
      trust_root_id: 'root',
      trust_store_digest_sha256: 'b'.repeat(64),
      key_id: 'key',
      signature_algorithm: 'ed25519',
      signature_verified: true,
    };
    const verifiedAgainst = {
      state: 'publication_dispatched',
      state_id: `RLS-${'a'.repeat(16)}`,
      record_digest_sha256: 'a'.repeat(64),
      candidate_identity_verified: true,
      artifact_identity_verified: true,
      destination_identity_verified: true,
      workflow_identity_verified: true,
      trust_identity_verified: true,
    };
    const derived = {
      state: 'planned',
      receipt_kind: 'release-plan-receipt',
      receipt_id: `RPL-${'a'.repeat(16)}`,
      receipt_digest_sha256: 'a'.repeat(64),
      verified: true,
    };
    const variants: readonly Readonly<Record<string, unknown>>[] = [
      { next_action: 'release plan' },
      { next_outcome: 'ready' },
      { blocked_reason: null },
      { blocked_requirements: ['fresh_exact_owner_authorization_required'] },
      { derived_states: [derived] },
      { published: { observed: true, receipt: publication, verified_against: verifiedAgainst } },
      { published: { observed: false, receipt: publication, verified_against: null } },
      { published: { observed: false, receipt: null, verified_against: verifiedAgainst } },
      { reconciliation_requirements: [] },
      {
        grants: {
          authority: true,
          publication_authority: false,
          lifecycle_transition: false,
          appends_published_state: false,
        },
      },
      { schemaVersion: '1.0.0' },
    ];
    for (const variant of variants) {
      expect(
        parsers.releaseLifecycleObservation.safeParse(rehashObservation(historical, variant)).ok,
        JSON.stringify(variant),
      ).toBe(false);
    }
  });
});
