import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProtectedArtifactSinkAdapter,
  readProtectedReleasePrepareCapacity,
  runWithAuthorityHostEffects,
  withProtectedReleasePrepareCapacity,
  type ProtectedReleasePrepareCapacityBinding,
} from '@devai-nyx/authority';
import { canonicalJson } from '@devai-nyx/utils';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { repositoryIdFor } from '../../src/authority/policy.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { RELEASE_PACK_SPEC_DIGEST } from '../../src/services/release-prepare-kernel.js';
import { resolveCliVersion } from '../../src/version.js';

// Invariants: INV-AUTH-002, INV-REL-001

function git(args: readonly string[]): string {
  const result = spawnSync('git', ['-C', process.cwd(), ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

describe('release prepare broker capacity', () => {
  it('reads the actual 256/8192 account and charges both counters through protected sink effects', async () => {
    const entries = canonicalRegistry();
    const entry = entries.find((candidate) => candidate.name === 'release prepare');
    if (entry === undefined) throw new Error('release prepare action missing');
    const root = realpathSync(process.cwd());
    const repository = {
      id: repositoryIdFor(root),
      commit: git(['rev-parse', 'HEAD']),
      tree: git(['rev-parse', 'HEAD^{tree}']),
    };
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
      await runWithAuthorityHostEffects(
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
      );
    } finally {
      host.dispose();
      rmSync(requestRoot, { recursive: true, force: true });
    }
  });
});
