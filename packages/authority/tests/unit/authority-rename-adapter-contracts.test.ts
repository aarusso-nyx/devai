import { describe, expect, it } from 'vitest';
import {
  boundaryApi,
  boundaryDependencies,
  expectBoundaryFailure,
} from './authority-boundary-testkit.js';
import {
  REPOSITORY_ID,
  exactSubject,
  expectSuccess,
  type AuthorityDecisionIssuer,
} from './authority-runtime-testkit.js';

// Rename adapter routing contracts written against the retained authority mutation
// diagnostic (candidate 3dfdc316, report 414957d9); mutant ids are the report's. The
// registry-only runtime refuses at receipt consumption, so the adapter check is observed by
// which refusal is returned.

const RECEIPT_STUB_CODE = 'FIXTURE_RECEIPT_REFUSED';
const receiptStub = {
  consume: () => ({ ok: false, category: 'refused', code: RECEIPT_STUB_CODE, reasons: [] }),
  dispose: () => ({ ok: true, value: true }),
};

const renameTarget = {
  kind: 'fs-rename',
  id: 'fs-rename:packages/core/old.ts',
  repository_id: REPOSITORY_ID,
  operation: 'rename',
  source: { id: 'old', canonical_relative_path: 'packages/core/old.ts' },
  destination: { id: 'new', canonical_relative_path: 'packages/core/new.ts' },
};

async function registryRuntime() {
  const api = await boundaryApi();
  const events: string[] = [];
  const runtime = api.createAuthorityBoundaryRuntime(
    boundaryDependencies(receiptStub as unknown as AuthorityDecisionIssuer, events),
  );
  const subject = exactSubject([renameTarget]);
  const planHandle = expectSuccess<object>(
    runtime.plannerRegistry.registerPlan({ subject, invocation_id: 'invocation-1' }),
  );
  const prepare = (adapterId: string) =>
    runtime.prepare({
      plan_handle: planHandle,
      subject,
      target: renameTarget,
      adapter_id: adapterId,
    });
  return { events, prepare };
}

describe('two-endpoint rename adapter routing', () => {
  // Mutants 2051, 2053: a rename is served by the filesystem adapter, not by an adapter named
  // after its own target kind.
  it('routes a rename to the filesystem adapter', async () => {
    const { events, prepare } = await registryRuntime();
    expectBoundaryFailure(prepare('fs-authority-boundary'), 'refused', RECEIPT_STUB_CODE);
    expectBoundaryFailure(
      prepare('fs-rename-authority-boundary'),
      'refused',
      'AUTHORITY_DECISION_RECEIPT_BINDING_MISMATCH',
    );
    expect(events).toEqual([]);
  });
});
