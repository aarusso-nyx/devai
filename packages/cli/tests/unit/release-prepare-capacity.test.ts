import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProtectedArtifactSinkAdapter,
  createProtectedReleaseRepositoryContext,
  readProtectedReleasePrepareCapacity,
  runWithAuthorityHostEffects,
  withProtectedReleasePrepareCapacity,
  withProtectedReleaseRepositoryContext,
  type ProtectedReleasePrepareCapacityBinding,
} from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { repositoryIdFor } from '../../src/authority/policy.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { RELEASE_PACK_SPEC_DIGEST } from '../../src/services/release-prepare-kernel.js';
import { resolveCliVersion } from '../../src/version.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

// Invariants: INV-AUTH-002, INV-REL-001

const sourceFixtures: Array<ReturnType<typeof createSelfContainedRepositoryFixture>> = [];
afterEach(() => {
  for (const fixture of sourceFixtures.splice(0)) fixture.cleanup();
});

describe('release prepare broker capacity', () => {
  it('reads the actual 256/8192 account and charges both counters through protected sink effects', async () => {
    const entries = canonicalRegistry();
    const entry = entries.find((candidate) => candidate.name === 'release prepare');
    if (entry === undefined) throw new Error('release prepare action missing');
    const fixture = createSelfContainedRepositoryFixture(
      resolve(import.meta.dirname, '../../../..'),
      {
        paths: ['.devai/pin/constitution.md'],
      },
    );
    sourceFixtures.push(fixture);
    const root = fixture.root;
    // The supported parser requires GitHub-shaped origins. This synthetic local
    // config is never fetched/pushed; the shared fixture has no remotes by default.
    const releaseRepositoryId = 'fixture-owner/release-capacity';
    fixture.git(['config', 'remote.origin.url', `https://github.com/${releaseRepositoryId}.git`]);
    const repository = {
      id: releaseRepositoryId,
      commit: fixture.commit,
      tree: fixture.tree,
    };
    const repositoryContext = createProtectedReleaseRepositoryContext({
      repository_root: root,
      authority_repository_id: repositoryIdFor(root),
      read_expected_release_repository_id: () => releaseRepositoryId,
      repository,
    });
    const planDigest = '1'.repeat(64);
    const candidate = { commit: repository.commit, tree: repository.tree };
    const binding: ProtectedReleasePrepareCapacityBinding = {
      action_id: 'release prepare',
      repository,
      candidate,
      plan_receipt_digest_sha256: planDigest,
    };
    const requestRoot = mkdtempSync(join(tmpdir(), 'devai-release-prepare-capacity-'));
    const requestPath = join(requestRoot, 'request.json');
    writeFileSync(
      requestPath,
      `${canonicalJson({
        schemaVersion: '1.0.0',
        request_kind: 'release-lifecycle-request',
        action_id: 'release prepare',
        repository_locator: repository,
        candidate_locator: { commit: candidate.commit, tree: candidate.tree, release_units: [] },
        receipt_locators: [
          {
            kind: 'release-plan-receipt',
            receipt_id: 'RPL-0000000000000000',
            receipt_digest_sha256: planDigest,
            path: 'receipts/plan.json',
          },
        ],
      })}\n`,
    );
    const host = createAuthorityHostBroker({
      entry,
      entries,
      argv: [
        process.execPath,
        'devai',
        'release',
        'prepare',
        '--request',
        requestPath,
        '--as-role',
        'architect',
        '--write',
      ],
      role: 'architect',
      declaration: { as_role: 'architect' },
      repository_root: root,
      package_version: resolveCliVersion(),
      bootstrap_policy: true,
    });
    const sink = createProtectedArtifactSinkAdapter({
      action_id: 'release prepare',
      repository,
      plan_receipt_digest_sha256: planDigest,
      pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
      sink_id: 'capacity-test-sink',
    });
    try {
      await withProtectedReleaseRepositoryContext(repositoryContext, () =>
        runWithAuthorityHostEffects(
          host.scope,
          async () =>
            await withProtectedReleasePrepareCapacity(binding, async () => {
              expect(readProtectedReleasePrepareCapacity(binding)).toEqual({
                remaining_batches: 256,
                remaining_targets: 8192,
              });
              for (let count = 0; count < 109; count += 1) sink.invokeSink(() => undefined);
              expect(readProtectedReleasePrepareCapacity(binding)).toEqual({
                remaining_batches: 147,
                remaining_targets: 8083,
              });
            }),
        ),
      );
    } finally {
      host.dispose();
      rmSync(requestRoot, { recursive: true, force: true });
    }
  });
});
