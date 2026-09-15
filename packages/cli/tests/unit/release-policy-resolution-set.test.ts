import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { verifyResolvedReleasePlanReceipt } from '../../src/services/release-lifecycle.js';
import {
  executeReleaseLifecycleAction,
  ReleaseLifecycleFileStore,
} from '../../src/services/release-lifecycle-execution.js';
import {
  createResolvedReleasePlanInputResolver,
  resolutionForReleasePlanInputResolver,
} from '../../src/services/release-policy-resolution.js';
import { createLifecyclePolicyResolutionSetFixture } from '../helpers/release-policy-resolution-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function requestFor(
  fixture: ReturnType<typeof createLifecyclePolicyResolutionSetFixture>,
  receipts = fixture.receipts,
) {
  return {
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: 'release preflight',
    repository_locator: fixture.candidate.repository,
    candidate_locator: {
      commit: fixture.candidate.repository.commit,
      tree: fixture.candidate.repository.tree,
      release_units: fixture.intents.map((intent) => ({
        release_unit: String(intent.release_unit),
        version: String(intent.target_version),
        package_roster: [
          {
            package_id: '@aarusso-nyx/devai',
            manifest_path: 'package.json',
            manifest_digest_sha256: 'a'.repeat(64),
          },
        ],
      })),
    },
    receipt_locators: receipts
      .map((receipt) => ({
        kind: 'release-plan-receipt' as const,
        receipt_id: receipt.receipt_id,
        receipt_digest_sha256: receipt.receipt_digest_sha256,
        path: `receipts/${receipt.receipt_id}.json`,
      }))
      .sort((left, right) => left.receipt_id.localeCompare(right.receipt_id, 'en')),
  } as const;
}

function storeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai-release-resolution-set-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const authority = {
  actor: { kind: 'human' as const, role: 'inspector' as const, declaration_source: 'cli-flag' },
  consent: { write: true, allow_publish: false, experimental: false },
} as const;

describe('release policy resolution set', () => {
  it('selects and verifies each genuine unit from its own v2 receipt', () => {
    const fixture = createLifecyclePolicyResolutionSetFixture();
    const resolver = createResolvedReleasePlanInputResolver(fixture.resolutions);

    for (const [index, receipt] of fixture.receipts.entries()) {
      const resolution = fixture.resolutions[index];
      expect(resolution).toBeDefined();
      if (resolution === undefined) throw new Error('fixture resolution');
      expect(resolutionForReleasePlanInputResolver(resolver, receipt)).toBe(resolution);
      expect(verifyResolvedReleasePlanReceipt({ receipt, resolution })).toBe(true);
    }

    expect(() => resolver({ kind: 'release-lifecycle-policy' })).toThrow(
      new Error('rpl-input-unresolved'),
    );
  });

  it('refuses empty, duplicate, mixed-candidate, missing, and substituted unit selections', () => {
    const fixture = createLifecyclePolicyResolutionSetFixture();
    const [first, second] = fixture.resolutions;
    const [firstReceipt, secondReceipt] = fixture.receipts;
    if (
      first === undefined ||
      second === undefined ||
      firstReceipt === undefined ||
      secondReceipt === undefined
    )
      throw new Error('fixture resolutions');

    expect(() => createResolvedReleasePlanInputResolver([])).toThrow(
      new Error('rpl-policy-resolution-mismatch'),
    );
    expect(() => createResolvedReleasePlanInputResolver([first, first])).toThrow(
      new Error('rpl-policy-resolution-mismatch'),
    );
    expect(() =>
      createResolvedReleasePlanInputResolver([first, fixture.foreign_resolution]),
    ).toThrow(new Error('rpl-policy-resolution-mismatch'));

    const firstOnly = createResolvedReleasePlanInputResolver(first);
    expect(resolutionForReleasePlanInputResolver(firstOnly, secondReceipt)).toBeUndefined();
    expect(verifyResolvedReleasePlanReceipt({ receipt: secondReceipt, resolution: first })).toBe(
      false,
    );

    const both = createResolvedReleasePlanInputResolver([first, second]);
    const substituted = {
      ...firstReceipt,
      candidate: secondReceipt.candidate,
    };
    expect(resolutionForReleasePlanInputResolver(both, substituted)).toBe(second);
    expect(verifyResolvedReleasePlanReceipt({ receipt: substituted, resolution: second })).toBe(
      false,
    );
  });

  it('rejects missing or substituted units before any preflight provider runs', async () => {
    const fixture = createLifecyclePolicyResolutionSetFixture();
    const request = requestFor(fixture);
    const provider = vi.fn();
    const resolveReceipt = vi.fn((locator: { readonly receipt_id: string }) =>
      fixture.receipts.find((receipt) => receipt.receipt_id === locator.receipt_id),
    );
    const complete = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request,
        action: 'release preflight',
        store: new ReleaseLifecycleFileStore(storeRoot(), request),
        authority,
        resolveReceipt,
        resolvePlanInput: createResolvedReleasePlanInputResolver(fixture.resolutions),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(complete).toMatchObject({
      ok: false,
      phase: 'provider',
      code: 'release-certification-provider-unavailable',
    });
    expect(provider).not.toHaveBeenCalled();

    const firstResolution = fixture.resolutions[0];
    if (firstResolution === undefined) throw new Error('fixture first resolution');

    const missing = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request,
        action: 'release preflight',
        store: new ReleaseLifecycleFileStore(storeRoot(), request),
        authority,
        resolveReceipt,
        resolvePlanInput: createResolvedReleasePlanInputResolver(firstResolution),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(missing).toMatchObject({
      ok: false,
      phase: 'validation',
      code: 'rpl-semantic-verification-not-performed',
    });

    const substituted = await withAuthorityHostTestScope(() =>
      executeReleaseLifecycleAction({
        request,
        action: 'release preflight',
        store: new ReleaseLifecycleFileStore(storeRoot(), request),
        authority,
        resolveReceipt: () => fixture.receipts[0],
        resolvePlanInput: createResolvedReleasePlanInputResolver(fixture.resolutions),
        provider,
        recorded_at: '2026-09-03T00:00:00.000Z',
      }),
    );
    expect(substituted).toMatchObject({
      ok: false,
      phase: 'validation',
      code: 'release-receipt-identity-mismatch',
    });
    expect(provider).not.toHaveBeenCalled();
  });
});
