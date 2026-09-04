import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createProtectedReleaseHostAdapter,
  runWithAuthorityHostEffects,
} from '@devai-nyx/authority';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { repositoryIdFor } from '../../src/authority/policy.js';
import { resolveCliVersion } from '../../src/version.js';

const workspace = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const PLAN = 'c'.repeat(64);
const TASK = 'd'.repeat(64);
const HELPER = 'e'.repeat(64);

function fixture(repositoryId: string): { readonly root: string; readonly request: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-authority-repository-id-'));
  roots.push(root);
  mkdirSync(join(root, '.devai/config'), { recursive: true });
  mkdirSync(join(root, '.devai/pin'), { recursive: true });
  cpSync(join(workspace, '.devai/pin/constitution.md'), join(root, '.devai/pin/constitution.md'));
  writeFileSync(
    join(root, '.devai/config/project.json'),
    `${JSON.stringify({ schemaVersion: '1.0.0', project_type: 'runtime-host', name: repositoryId })}\n`,
  );
  const request = join(root, 'request.json');
  writeFileSync(
    request,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: 'release certify',
      repository_locator: { id: repositoryId, commit: COMMIT, tree: TREE },
      candidate_locator: { commit: COMMIT, tree: TREE, release_units: [] },
      receipt_locators: [
        {
          kind: 'release-plan-receipt',
          receipt_id: 'RPL-0000000000000000',
          receipt_digest_sha256: PLAN,
          path: 'receipts/plan.json',
        },
      ],
    })}\n`,
  );
  return { root, request };
}

async function invokeProtectedCertify(root: string, request: string, repositoryId: string) {
  const entries = canonicalRegistry();
  const entry = entries.find((candidate) => candidate.name === 'release certify');
  if (entry === undefined) throw new Error('release certify action missing');
  const broker = createAuthorityHostBroker({
    entry,
    entries,
    argv: [
      process.execPath,
      'devai',
      'release',
      'certify',
      '--request',
      request,
      '--as-role',
      'inspector',
      '--write',
    ],
    role: 'inspector',
    declaration: { as_role: 'inspector' },
    repository_root: root,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
  const adapter = createProtectedReleaseHostAdapter({
    action_id: 'release certify',
    repository: { id: repositoryId, commit: COMMIT, tree: TREE },
    task_policy_digest_sha256: TASK,
    plan_receipt_digest_sha256: PLAN,
    helper_identity_sha256: HELPER,
  });
  let invoked = false;
  try {
    await runWithAuthorityHostEffects(broker.scope, () =>
      adapter.invokeSink(() => {
        invoked = true;
      }),
    );
  } finally {
    broker.dispose();
  }
  return invoked;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('authority repository identity boundary', () => {
  it.each([
    ['DEVAI', 'aarusso-nyx/devai', 'aarusso-nyx-devai'],
    ['STYNX', 'stynx-nyx/stynx', 'stynx-nyx-stynx'],
  ])(
    '%s canonical id currently collides with its slash-normalized policy id',
    async (_name, id, normalized) => {
      const fixtureValue = fixture(id);

      // This records the current grammar/broker mismatch for the approved canonical ID.
      expect(repositoryIdFor(fixtureValue.root)).toBe(normalized);
      await expect(
        invokeProtectedCertify(fixtureValue.root, fixtureValue.request, id),
      ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      await expect(
        invokeProtectedCertify(fixtureValue.root, fixtureValue.request, 'foreign/repository'),
      ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    },
  );
});
