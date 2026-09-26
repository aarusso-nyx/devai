// ADR-REL-0027, Inspector Adversarial Acceptance IA-003: the changeset-version
// check member no longer exists once changesets are retired, and requesting it
// by name must be an unknown-member error (the `default:` branch of the switch
// in packages/cli/src/commands/check/adapters.ts, which throws
// `CHECK_SERVICE_UNKNOWN:<id>`), never a pass or a skip.
//
// Red until the Engineer removes the `case 'changeset-version':` from that
// switch. Today the case still matches, so directService still attempts to
// spawn `node scripts/check-changesets.mjs`; the test authority scope refuses
// that process (it is not on its read-only allowlist) and the member reports
// `status: 'error'` with message `AUTHORITY_TEST_PROCESS_NOT_READ_ONLY` instead
// of `CHECK_SERVICE_UNKNOWN:changeset-version` — proof the member is still
// routed as known rather than falling through to the unknown-member branch.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import type { ResolvedCheckMember } from '../../src/commands/check/contracts.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

function member(serviceId: string): ResolvedCheckMember {
  return {
    id: serviceId,
    source: 'current-selector',
    service_id: serviceId,
    binding: { kind: 'runtime-gate', gate_id: `check-${serviceId}` },
    effect: 'read',
    cost: 'low',
    output: `action-envelope-plus-${serviceId}-report`,
  };
}

describe('changeset-version member removed (ADR-REL-0027)', () => {
  it('reports the removed changeset-version member as an unknown-member error, never pass or skip', async () => {
    const result = await withAuthorityHostTestScope(() =>
      executeCheckMember(member('changeset-version'), { repoRoot: ROOT }),
    );

    expect(result.status).not.toBe('pass');
    expect(result.status).not.toBe('na');
    expect(result).toMatchObject({ status: 'error', code: 'CHECK_SERVICE_ERROR' });
    expect(result.message).toContain('CHECK_SERVICE_UNKNOWN');
  });
});
