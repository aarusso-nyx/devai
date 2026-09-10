// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-016, INV-DEVAI-018
// Public-boundary acceptance: the host binding assertion fails closed for a
// missing runtime value before any package composition has been established.
import { describe, expect, it, vi } from 'vitest';
import type { ReleasePackageSnapshot } from '../../src/services/release-package-snapshot.js';

vi.mock('@devai-nyx/schemas', () => ({ bindSchemaPackageSnapshot: vi.fn() }));
vi.mock('@devai-nyx/sensors', () => ({ assertBundledSensorRegistry: vi.fn() }));
vi.mock('@devai-nyx/sensors/presets', () => ({ assertBundledSensePresets: vi.fn() }));
vi.mock('../../src/services/mutation-evidence-v21.js', () => ({
  bindMutationEvidenceV21PackageSnapshot: vi.fn(),
}));
vi.mock('../../src/services/release-package-snapshot.js', () => ({
  isVerifiedReleasePackageSnapshot: vi.fn(() => false),
}));

import { assertBoundReleaseHostPackageSnapshot } from '../../src/services/release-host-package-binding.js';

describe('release host package binding invalid input', () => {
  it('rejects an undefined runtime snapshot with the bounded identity', () => {
    expect(() =>
      assertBoundReleaseHostPackageSnapshot(undefined as unknown as ReleasePackageSnapshot),
    ).toThrow(/^rpl-package-identity-mismatch$/u);
  });
});
