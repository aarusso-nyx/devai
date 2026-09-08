// Exercise the legacy transition API with the real authorization ledger kernel.
// Adapters and persistence callbacks are in-memory fixtures, never external effects.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type EffectAuthorizationEvent,
  type EffectAuthorizationLedger,
  type EffectAuthorizationGrantRequest,
  resolveEffectAuthorization,
} from '@devai-nyx/authority';
import {
  executeReleaseTransition,
  executeAuthorizedReleaseTransition,
  finalizeReleaseLifecycleState,
  type ReleaseLifecycleStateRecord,
  type ReleasePublicationReceipt,
} from '../../src/release-lifecycle/index.js';
const root = resolve(import.meta.dirname, '../../../..');
const examples = (name: string): Record<string, unknown>[] =>
  JSON.parse(readFileSync(resolve(root, `law/schemas/${name}.schema.json`), 'utf8')).examples;
const stateExamples = examples('release-lifecycle-state');
const receiptExample = examples(
  'release-publication-receipt',
)[0] as unknown as ReleasePublicationReceipt;
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing publication fixture');
  return value;
}
function base() {
  const value = structuredClone(present(stateExamples[0]));
  value.schemaVersion = '1.0.0';
  delete value.canonicalization;
  delete value.release_units;
  delete value.storage;
  delete value.record_digest_sha256;
  return value;
}
function reference(state: ReleaseLifecycleStateRecord) {
  return {
    state: state.state,
    state_id: state.state_id,
    record_digest_sha256: state.record_digest_sha256,
  };
}
function chain(): ReleaseLifecycleStateRecord[] {
  const records = [finalizeReleaseLifecycleState(base())];
  const remote = present(stateExamples[1]);
  const transitions = [
    ['certified', 'release certify', 'harness-write', 'inspector'],
    ['prepared', 'release prepare', 'local-write', 'architect'],
    ['exported', 'release export', 'local-write', 'architect'],
    ['evidence_published', 'release evidence-publish', 'remote-write', 'owner'],
    ['publication_dispatched', 'release publish', 'remote-write', 'owner'],
  ] as const;
  for (const [index, [state, action, effect, role]] of transitions.entries()) {
    const prior = present(records.at(-1));
    const remoteWrite = effect === 'remote-write';
    records.push(
      finalizeReleaseLifecycleState({
        ...base(),
        state_id: `RLS-${String(index + 1).repeat(16)}`,
        state,
        action_id: action,
        effect,
        actor: { kind: 'human', role, declaration_source: 'cli-flag' },
        consent: { write: true, allow_publish: remoteWrite, experimental: false },
        prior_state: reference(prior),
        authorization_event_id: remoteWrite ? remote.authorization_event_id : null,
        publication_expectation:
          state === 'publication_dispatched' ? remote.publication_expectation : null,
        bound_receipts:
          state === 'evidence_published'
            ? [
                {
                  kind: 'release-offline-verification-receipt',
                  receipt_id: 'ROV-0123456789abcdef',
                  receipt_digest_sha256: 'a'.repeat(64),
                  verdict: 'pass',
                },
              ]
            : [],
        artifacts: remoteWrite
          ? receiptExample.artifacts
          : ['package-tarball', 'manifest', 'sbom', 'evidence-bundle', 'provider-result'].map(
              (kind) => ({ kind, path: `dist/${kind}.bin`, sha256: 'a'.repeat(64), size_bytes: 1 }),
            ),
      }),
    );
  }
  return records;
}

function fixture() {
  const grant = examples('effect-authorization-event')[0] as unknown as EffectAuthorizationEvent;
  const ledger = examples('effect-authorization-ledger')[0] as unknown as EffectAuthorizationLedger;
  const request: EffectAuthorizationGrantRequest = {
    authorization_event_id: grant.event_id,
    ledger_id: grant.ledger_id,
    action_id: grant.action_id,
    effect: grant.effect,
    resource: grant.resource,
    repository: grant.repository,
    candidate: grant.candidate,
    subject_role: grant.subject_role,
    consent: grant.consent,
    observed_at: '2026-09-03T00:30:00.000Z',
  };
  const records = chain();
  const head = present(records.pop());
  const { record_digest_sha256: _digest, ...unsigned } = head;
  void _digest;
  const draft = {
    ...unsigned,
    authorization_event_id: grant.event_id,
    publication_expectation: {
      ...present(head.publication_expectation),
      authorization_event_id: grant.event_id,
    },
  };
  const events = new Map([[grant.event_id, grant]]);
  const resolveAuthorizationEvent = (entry: { event_id: string }) => events.get(entry.event_id);
  const appendAuthorizationConsumption = vi.fn(
    async (event: EffectAuthorizationEvent, _ledger: EffectAuthorizationLedger) => {
      events.set(event.event_id, event);
    },
  );
  return {
    records,
    draft,
    authorizationLedger: ledger,
    resolveAuthorizationEvent,
    authorizationRequest: request,
    appendAuthorizationConsumption,
    adapter: vi.fn(async () => ({ effectId: 'fixture-only' })),
    appendState: vi.fn(async (_state: ReleaseLifecycleStateRecord) => {}),
  };
}

describe('release transition authorization boundaries', () => {
  it('never runs a remote adapter through the local transition entry point', async () => {
    const f = fixture();
    expect(await executeReleaseTransition(f)).toMatchObject({
      ok: false,
      phase: 'validation',
      code: 'release-state-effect-mismatch',
    });
    expect(f.adapter).not.toHaveBeenCalled();
    expect(f.appendState).not.toHaveBeenCalled();
  });
  it('consumes the exact grant durably before the adapter, then appends the exact state', async () => {
    const f = fixture();
    const order: string[] = [];
    const append = f.appendAuthorizationConsumption;
    f.appendAuthorizationConsumption = vi.fn(async (event, ledger) => {
      order.push('consume');
      await append(event, ledger);
      expect(event.consumed_by_state_id).toBe(f.draft.state_id);
      expect(
        resolveEffectAuthorization(ledger, f.resolveAuthorizationEvent, f.authorizationRequest),
      ).toEqual({ ok: false, code: 'consumed-effect-authorization' });
      await Promise.resolve();
      order.push('durable');
    });
    f.adapter.mockImplementation(async () => {
      order.push('adapter');
      return { effectId: 'fixture-only' };
    });
    f.appendState.mockImplementation(async (state) => {
      order.push('append');
      expect(state).toEqual(finalizeReleaseLifecycleState(f.draft));
    });
    expect(await executeAuthorizedReleaseTransition(f)).toEqual({
      ok: true,
      state: finalizeReleaseLifecycleState(f.draft),
      adapter_result: { effectId: 'fixture-only' },
    });
    expect(order).toEqual(['consume', 'durable', 'adapter', 'append']);
  });
  it('rejects a valid grant attached to a different state authorization identity', async () => {
    const f = fixture();
    f.draft.authorization_event_id = 'EA-0000000000000000';
    f.draft.publication_expectation.authorization_event_id = f.draft.authorization_event_id;
    expect(await executeAuthorizedReleaseTransition(f)).toMatchObject({
      ok: false,
      phase: 'validation',
      code: 'release-state-authorization-mismatch',
    });
    expect(f.appendAuthorizationConsumption).not.toHaveBeenCalled();
    expect(f.adapter).not.toHaveBeenCalled();
    expect(f.appendState).not.toHaveBeenCalled();
  });
  it.each(['system_id', 'exact_identifier'] as const)(
    'rejects a different publication destination %s before consumption',
    async (key) => {
      const f = fixture();
      f.draft.publication_expectation = {
        ...f.draft.publication_expectation,
        destination: {
          ...f.draft.publication_expectation.destination,
          [key]: 'another-destination',
        },
      };
      expect(await executeAuthorizedReleaseTransition(f)).toMatchObject({
        ok: false,
        phase: 'validation',
        code: 'release-state-authorization-mismatch',
      });
      expect(f.appendAuthorizationConsumption).not.toHaveBeenCalled();
      expect(f.adapter).not.toHaveBeenCalled();
    },
  );
  it.each(['action', 'effect', 'candidate', 'repository', 'role', 'consent'] as const)(
    'rejects a request with a different %s before grant consumption',
    async (field) => {
      const f = fixture();
      const request = f.authorizationRequest;
      const changes: Record<typeof field, Partial<EffectAuthorizationGrantRequest>> = {
        action: { action_id: 'release evidence-publish' },
        effect: { effect: 'read' },
        candidate: { candidate: { ...request.candidate, version: '9.9.9' } },
        repository: { repository: { ...request.repository, id: 'another/repository' } },
        role: { subject_role: 'auditor' },
        consent: { consent: { ...request.consent, allow_publish: false } },
      };
      f.authorizationRequest = { ...request, ...changes[field] };
      expect(await executeAuthorizedReleaseTransition(f)).toMatchObject({
        ok: false,
        phase: 'validation',
        code: 'release-state-authorization-mismatch',
      });
      expect(f.appendAuthorizationConsumption).not.toHaveBeenCalled();
      expect(f.adapter).not.toHaveBeenCalled();
    },
  );
  it('refuses malformed and incomplete chains before authorization resolution', async () => {
    const f = fixture();
    const resolveAuthorizationEvent = vi.fn(f.resolveAuthorizationEvent);
    expect(
      await executeAuthorizedReleaseTransition({ ...f, records: [], resolveAuthorizationEvent }),
    ).toMatchObject({ ok: false, phase: 'validation' });
    expect(
      await executeAuthorizedReleaseTransition({
        ...f,
        draft: { ...f.draft, state_id: 'invalid' },
        resolveAuthorizationEvent,
      }),
    ).toMatchObject({ ok: false, phase: 'validation', code: 'release-state-schema-invalid' });
    expect(resolveAuthorizationEvent).not.toHaveBeenCalled();
    expect(f.adapter).not.toHaveBeenCalled();
  });
  it('reports missing adapters without consuming authorization', async () => {
    const f = fixture();
    expect(await executeAuthorizedReleaseTransition({ ...f, adapter: undefined })).toEqual({
      ok: false,
      phase: 'adapter',
      code: 'release-action-provider-unavailable',
    });
    expect(f.appendAuthorizationConsumption).not.toHaveBeenCalled();
  });
  it('does not enter the adapter when durable consumption fails', async () => {
    const f = fixture();
    const cause = new Error('fixture disk failure');
    f.appendAuthorizationConsumption.mockImplementation(() => {
      throw cause;
    });
    expect(await executeAuthorizedReleaseTransition(f)).toEqual({
      ok: false,
      phase: 'adapter',
      code: 'effect-authorization-consumption-failed',
      cause,
    });
    expect(f.adapter).not.toHaveBeenCalled();
    expect(f.appendState).not.toHaveBeenCalled();
  });
  it('does not append state after an unknown adapter outcome and preserves the consumed grant', async () => {
    const f = fixture();
    const cause = new Error('fixture effect outcome unknown');
    f.adapter.mockRejectedValue(cause);
    expect(await executeAuthorizedReleaseTransition(f)).toEqual({
      ok: false,
      phase: 'adapter',
      code: 'authorized-effect-adapter-failed',
      cause,
    });
    expect(f.appendAuthorizationConsumption).toHaveBeenCalledOnce();
    expect(f.appendState).not.toHaveBeenCalled();
  });
  it('reports append failure distinctly after the effect has returned', async () => {
    const f = fixture();
    const cause = new Error('fixture state disk failure');
    f.appendState.mockRejectedValue(cause);
    expect(await executeAuthorizedReleaseTransition(f)).toEqual({
      ok: false,
      phase: 'append',
      code: 'release-state-append-failed',
      cause,
    });
    expect(f.appendAuthorizationConsumption).toHaveBeenCalledOnce();
    expect(f.adapter).toHaveBeenCalledOnce();
    expect(f.appendState).toHaveBeenCalledOnce();
  });
  it('rejects expired authorization before both effect and state persistence', async () => {
    const f = fixture();
    f.authorizationRequest = { ...f.authorizationRequest, observed_at: '2026-09-03T02:00:00.000Z' };
    expect(await executeAuthorizedReleaseTransition(f)).toMatchObject({
      ok: false,
      phase: 'authorization',
    });
    expect(f.appendAuthorizationConsumption).not.toHaveBeenCalled();
    expect(f.adapter).not.toHaveBeenCalled();
    expect(f.appendState).not.toHaveBeenCalled();
  });
});
