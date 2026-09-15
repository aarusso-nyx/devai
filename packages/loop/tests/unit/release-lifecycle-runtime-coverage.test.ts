// Exercise the retained v1 lifecycle API independently of the installed v2/v3 host.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsers } from '@devai-nyx/schemas';
import {
  computeReleaseStateRecordDigest,
  executeReleaseTransition,
  finalizeReleaseLifecycleState,
  reduceReleaseLifecycle,
  resumeReleaseLifecycle,
  type ReleaseLifecycleStateRecord,
} from '../../src/release-lifecycle/index.js';

const root = resolve(import.meta.dirname, '../../../..');
const example = JSON.parse(
  readFileSync(resolve(root, 'law/schemas/release-lifecycle-state.schema.json'), 'utf8'),
).examples[0];
type Draft = Omit<ReleaseLifecycleStateRecord, 'record_digest_sha256'>;
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing lifecycle fixture value');
  return value;
}

function draft(): Draft {
  const value = structuredClone(example);
  value.schemaVersion = '1.0.0';
  delete value.canonicalization;
  delete value.release_units;
  delete value.storage;
  delete value.record_digest_sha256;
  return value as Draft;
}
function first(): ReleaseLifecycleStateRecord {
  return finalizeReleaseLifecycleState(draft());
}
function next(prior: ReleaseLifecycleStateRecord): Draft {
  return {
    ...draft(),
    state_id: 'RLS-1234567890abcdef',
    state: 'certified',
    action_id: 'release certify',
    prior_state: {
      state: prior.state,
      state_id: prior.state_id,
      record_digest_sha256: prior.record_digest_sha256,
    },
    bound_receipts: [],
  };
}
function reseal(record: ReleaseLifecycleStateRecord): ReleaseLifecycleStateRecord {
  return { ...record, record_digest_sha256: computeReleaseStateRecordDigest(record) };
}

describe('legacy release state reduction', () => {
  it('preserves empty and ordered valid chains without modifying input', () => {
    expect(reduceReleaseLifecycle([])).toEqual({ ok: true, records: [], head: null });
    const a = first();
    const b = finalizeReleaseLifecycleState(next(a));
    expect(parsers.releaseLifecycleState.safeParse(a).ok).toBe(true);
    const input = [a, b];
    const before = JSON.stringify(input);
    expect(reduceReleaseLifecycle(input)).toEqual({ ok: true, records: input, head: b });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('rejects schema-invalid records while collecting independently invalid later entries', () => {
    const a = first();
    const tampered = { ...a, recorded_at: '2026-09-04T00:00:00.000Z' };
    const result = reduceReleaseLifecycle([null, tampered]);
    expect(result).toEqual({
      ok: false,
      errors: ['release-state-schema-invalid', 'release-state-record-digest-mismatch'],
    });
  });

  it('rejects duplicate state identities even when each record has a valid digest', () => {
    const a = first();
    const b = finalizeReleaseLifecycleState({ ...next(a), state_id: a.state_id });
    expect(reduceReleaseLifecycle([a, b])).toEqual({
      ok: false,
      errors: ['release-state-id-duplicate'],
    });
  });

  it('rejects a skipped preflight and wrong predecessor identity', () => {
    const a = first();
    const b = finalizeReleaseLifecycleState(next(a));
    expect(reduceReleaseLifecycle([b])).toEqual({
      ok: false,
      errors: ['release-state-transition-invalid', 'release-state-prior-mismatch'],
    });
  });

  it.each(['state_id', 'record_digest_sha256'] as const)(
    'requires the predecessor %s to match',
    (field) => {
      const a = first();
      const b = finalizeReleaseLifecycleState(next(a));
      const prior = {
        ...present(b.prior_state),
        [field]: field === 'state_id' ? 'RLS-abcdef1234567890' : 'f'.repeat(64),
      };
      const changed = reseal({ ...b, prior_state: prior });
      expect(parsers.releaseLifecycleState.safeParse(changed).ok).toBe(true);
      expect(reduceReleaseLifecycle([a, changed])).toEqual({
        ok: false,
        errors: ['release-state-prior-mismatch'],
      });
    },
  );

  it.each(['repository', 'candidate'] as const)(
    'refuses a differently bound %s despite a valid digest',
    (field) => {
      const a = first();
      const b = finalizeReleaseLifecycleState(next(a));
      const changed = reseal({ ...b, [field]: { ...b[field], tree: 'f'.repeat(40) } });
      expect(parsers.releaseLifecycleState.safeParse(changed).ok).toBe(true);
      expect(reduceReleaseLifecycle([a, changed])).toEqual({
        ok: false,
        errors: [`release-state-${field}-mismatch`],
      });
    },
  );

  it('ignores only its own digest field during digest calculation', () => {
    const a = first();
    expect(computeReleaseStateRecordDigest({ ...a, record_digest_sha256: '0'.repeat(64) })).toBe(
      a.record_digest_sha256,
    );
    expect(computeReleaseStateRecordDigest({ ...a, state_id: 'RLS-abcdef1234567890' })).not.toBe(
      a.record_digest_sha256,
    );
  });

  it.each([null, [], 'state', 7].map((value) => ({ value })))(
    'rejects a non-object digest input $value',
    ({ value }) => {
      expect(() => computeReleaseStateRecordDigest(value)).toThrow(
        'canonical release document must be an object',
      );
    },
  );
});

describe('legacy local transition effect ordering', () => {
  it('awaits a successful adapter before appending its exact validated state', async () => {
    const events: string[] = [];
    const writes: ReleaseLifecycleStateRecord[] = [];
    const result = await executeReleaseTransition({
      records: [],
      draft: draft(),
      adapter: async () => {
        events.push('adapter');
        return { output: 'verified' };
      },
      appendState: async (state) => {
        events.push('append');
        writes.push(state);
      },
    });
    expect(events).toEqual(['adapter', 'append']);
    expect(result).toEqual({ ok: true, state: first(), adapter_result: { output: 'verified' } });
    expect(writes).toEqual([first()]);
  });

  it('never enters either effect for an invalid chain', async () => {
    const effects: string[] = [];
    const result = await executeReleaseTransition({
      records: [null],
      draft: draft(),
      adapter: () => effects.push('adapter'),
      appendState: () => {
        effects.push('append');
      },
    });
    expect(result).toEqual({
      ok: false,
      phase: 'validation',
      code: 'release-state-schema-invalid',
    });
    expect(effects).toEqual([]);
  });

  it('reports draft schema failures before calling an adapter', async () => {
    const effects: string[] = [];
    const result = await executeReleaseTransition({
      records: [],
      draft: { ...draft(), state_id: 'invalid' },
      adapter: () => effects.push('adapter'),
      appendState: () => {
        effects.push('append');
      },
    });
    expect(result).toMatchObject({
      ok: false,
      phase: 'validation',
      code: 'release-state-schema-invalid',
    });
    expect(result).toHaveProperty('cause');
    expect(effects).toEqual([]);
  });

  it('refuses an unavailable adapter and never appends', async () => {
    let appended = false;
    const result = await executeReleaseTransition({
      records: [],
      draft: draft(),
      appendState: () => {
        appended = true;
      },
    });
    expect(result).toEqual({
      ok: false,
      phase: 'adapter',
      code: 'release-action-provider-unavailable',
    });
    expect(appended).toBe(false);
  });

  it('preserves an adapter failure and does not append', async () => {
    const failure = new Error('provider failed');
    let appended = false;
    const result = await executeReleaseTransition({
      records: [],
      draft: draft(),
      adapter: () => {
        throw failure;
      },
      appendState: () => {
        appended = true;
      },
    });
    expect(result).toEqual({
      ok: false,
      phase: 'adapter',
      code: 'release-action-provider-failed',
      cause: failure,
    });
    expect(appended).toBe(false);
  });

  it('distinguishes an append failure from completed provider work', async () => {
    const failure = new Error('storage unavailable');
    const calls: string[] = [];
    const result = await executeReleaseTransition({
      records: [],
      draft: draft(),
      adapter: () => {
        calls.push('adapter');
        return 42;
      },
      appendState: () => {
        calls.push('append');
        throw failure;
      },
    });
    expect(result).toEqual({
      ok: false,
      phase: 'append',
      code: 'release-state-append-failed',
      cause: failure,
    });
    expect(calls).toEqual(['adapter', 'append']);
  });
});

describe('legacy resume is an identity-bound observation', () => {
  it('reports the next local step for each valid persisted head', async () => {
    const records = [first()];
    records.push(finalizeReleaseLifecycleState(next(present(records[0]))));
    for (const [state, action, suffix] of [
      ['prepared', 'release prepare', '2'],
      ['exported', 'release export', '3'],
    ] as const) {
      const prior = present(records.at(-1));
      records.push(
        finalizeReleaseLifecycleState({
          ...draft(),
          state_id: `RLS-${suffix.repeat(16)}`,
          state,
          action_id: action,
          effect: 'local-write',
          artifacts: [
            'package-tarball',
            'manifest',
            'sbom',
            'evidence-bundle',
            'provider-result',
          ].map((kind) => ({
            kind,
            path: `dist/${kind}.bin`,
            sha256: 'a'.repeat(64),
            size_bytes: 1,
          })),
          actor: { kind: 'human', role: 'architect', declaration_source: 'cli-flag' },
          prior_state: {
            state: prior.state,
            state_id: prior.state_id,
            record_digest_sha256: prior.record_digest_sha256,
          },
          bound_receipts: [],
        }),
      );
    }
    const expected = [
      'release certify',
      'release prepare',
      'release export',
      'release offline-verify',
    ];
    for (let size = 1; size <= records.length; size++) {
      const head = present(records[size - 1]);
      const observation = await resumeReleaseLifecycle({
        records: records.slice(0, size),
        repository: head.repository,
        candidate: head.candidate,
        verifySignature: () => {
          throw new Error('no signature requested');
        },
      });
      expect(observation.next_action).toBe(expected[size - 1]);
      expect(observation.next_outcome).toBe('ready');
      expect(observation.grants).toEqual({
        authority: false,
        publication_authority: false,
        lifecycle_transition: false,
        appends_published_state: false,
      });
    }
  });

  it.each([false, true])(
    'does not verify or claim publication without a receipt (has head: %s)',
    async (hasHead) => {
      const state = first();
      let signatures = 0;
      const input = {
        records: hasHead ? [state] : [],
        repository: state.repository,
        candidate: state.candidate,
        verifySignature: () => {
          signatures++;
          return true;
        },
      };
      const before = JSON.stringify(input);
      const observation = await resumeReleaseLifecycle(input);
      expect(signatures).toBe(0);
      expect(observation.schemaVersion).toBe('1.1.0');
      expect(observation.next_action).toBe(hasHead ? 'release certify' : 'release plan');
      expect(observation.next_outcome).toBe('ready');
      expect(observation.published).toEqual({
        observed: false,
        receipt: null,
        verified_against: null,
      });
      expect(observation.derived_states).toEqual([]);
      expect(observation.repository).toEqual(state.repository);
      expect(observation.candidate).toEqual(state.candidate);
      expect(observation.head).toEqual(
        hasHead
          ? {
              state: state.state,
              state_id: state.state_id,
              record_digest_sha256: state.record_digest_sha256,
            }
          : null,
      );
      expect(JSON.stringify(input)).toBe(before);
      expect(await resumeReleaseLifecycle(input)).toEqual(observation);
    },
  );

  it.each(['repository', 'candidate'] as const)(
    'rejects an observation for another %s',
    async (field) => {
      const state = first();
      await expect(
        resumeReleaseLifecycle({
          records: [state],
          repository: state.repository,
          candidate: state.candidate,
          [field]: { ...state[field], commit: 'c'.repeat(40) },
          verifySignature: () => {
            throw new Error('must not run');
          },
        }),
      ).rejects.toThrow('RELEASE_LIFECYCLE_OBSERVATION_IDENTITY_MISMATCH');
    },
  );

  it('refuses an invalid chain before attempting publication verification', async () => {
    const state = first();
    await expect(
      resumeReleaseLifecycle({
        records: [null],
        repository: state.repository,
        candidate: state.candidate,
        verifySignature: () => {
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow('RELEASE_LIFECYCLE_CHAIN_INVALID:release-state-schema-invalid');
  });
});
