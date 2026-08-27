// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-020
// Inspector acceptance for authority-decision recording.
//
// This predicate runs on the hot path for every command, so its boundaries are
// pinned deliberately: reads and dry runs decide nothing, a round is never
// inferred, only decisions that reach outward are worth recording, and the
// tracking actions record their own authorization with more fidelity.
import { describe, expect, it } from 'vitest';
import { authorityDecisionRecordable } from '../../src/authority/index.js';
import { canonicalRegistry } from '../../src/define-command.js';
import type { RegistryEntry } from '../../src/define-command.js';

const ROUND = 'R-0042';

function entry(actionId: string): RegistryEntry {
  const found = canonicalRegistry().find((candidate) => candidate.name === actionId);
  if (found === undefined) throw new Error(`unknown action: ${actionId}`);
  return found;
}

function recordable(
  actionId: string,
  overrides: Partial<{
    dryRun: boolean;
    round: string | undefined;
    role: 'owner' | 'engineer';
  }> = {},
): boolean {
  return authorityDecisionRecordable(entry(actionId), {
    dryRun: false,
    round: ROUND,
    role: 'owner',
    ...overrides,
  });
}

describe('what counts as a recordable authority decision', () => {
  it('records a remote-write decision that names a round', () => {
    expect(recordable('sense run')).toBe(true);
  });

  it('never records a read, because the layer decides nothing to record', () => {
    for (const action of ['round status', 'audit scorecard', 'doctor', 'release status']) {
      expect(recordable(action), action).toBe(false);
    }
  });

  it('never records a dry run, which decided nothing that took effect', () => {
    expect(recordable('sense run', { dryRun: true })).toBe(false);
  });

  it('never infers a round, and never attributes without a resolved role', () => {
    expect(recordable('sense run', { round: undefined })).toBe(false);
    expect(recordable('sense run', { role: undefined as never })).toBe(false);
  });

  it('leaves the tracking actions to record their own authorization', () => {
    for (const action of [
      'round tracking enable',
      'round tracking sync',
      'round tracking disable',
    ]) {
      expect(recordable(action), action).toBe(false);
    }
  });

  it('does not record local harness writes, which their own event pair already brackets', () => {
    for (const action of ['round close', 'round run', 'round gap create', 'triage classify']) {
      expect(recordable(action), action).toBe(false);
    }
  });
});

describe('the capability backstop', () => {
  it('holds for every action the gate currently admits', () => {
    // The gate is the coverage boundary; the capability check behind it is a
    // fail-closed backstop that must never be the thing doing the excluding.
    const admitted = canonicalRegistry().filter((candidate) =>
      authorityDecisionRecordable(candidate, { dryRun: false, round: ROUND, role: 'owner' }),
    );
    expect(admitted.length).toBeGreaterThan(0);
    for (const candidate of admitted) {
      expect(
        candidate.authority_contract.capabilities.includes('fs:f5-state'),
        candidate.name,
      ).toBe(true);
    }
  });

  it('admits only actions that reach outward or carry publication consent', () => {
    for (const candidate of canonicalRegistry()) {
      if (!authorityDecisionRecordable(candidate, { dryRun: false, round: ROUND, role: 'owner' })) {
        continue;
      }
      expect(
        candidate.effects === 'remote-write' ||
          candidate.authority_contract.consent.allow_publish === true,
        candidate.name,
      ).toBe(true);
    }
  });
});
