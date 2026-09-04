import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProtectedReleaseHostAdapter,
  runWithAuthorityHostEffects,
} from '@devai-nyx/authority';
import { createReleaseRepositoryTestFixture } from '../../../authority/tests/unit/release-repository-test-fixture.js';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { repositoryIdFor } from '../../src/authority/policy.js';
import { resolveCliVersion } from '../../src/version.js';

const workspace = resolve(import.meta.dirname, '../../../..');
const PLAN = 'c'.repeat(64);
const TASK = 'd'.repeat(64);
const HELPER = 'e'.repeat(64);

function fixture(repositoryId: string, authorityId: string) {
  const repository = createReleaseRepositoryTestFixture(repositoryId, authorityId);
  mkdirSync(join(repository.root, '.devai/config'), { recursive: true });
  mkdirSync(join(repository.root, '.devai/pin'), { recursive: true });
  cpSync(
    join(workspace, '.devai/pin/constitution.md'),
    join(repository.root, '.devai/pin/constitution.md'),
  );
  writeFileSync(
    join(repository.root, '.devai/config/project.json'),
    `${JSON.stringify({ schemaVersion: '1.0.0', project_type: 'runtime-host', name: authorityId })}\n`,
  );
  const request = join(repository.root, 'request.json');
  writeFileSync(
    request,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: 'release certify',
      repository_locator: repository.repository,
      candidate_locator: {
        commit: repository.repository.commit,
        tree: repository.repository.tree,
        release_units: [],
      },
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
  return { ...repository, request };
}

async function invoke(
  value: ReturnType<typeof fixture>,
  bindingRepository = value.repository,
  before?: () => void,
) {
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
      value.request,
      '--as-role',
      'inspector',
      '--write',
    ],
    role: 'inspector',
    declaration: { as_role: 'inspector' },
    repository_root: value.root,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
  const adapter = createProtectedReleaseHostAdapter({
    action_id: 'release certify',
    repository: bindingRepository,
    task_policy_digest_sha256: TASK,
    plan_receipt_digest_sha256: PLAN,
    helper_identity_sha256: HELPER,
  });
  try {
    return await value.run(async () => {
      before?.();
      return await runWithAuthorityHostEffects(broker.scope, () => adapter.invokeSink(() => true));
    });
  } finally {
    broker.dispose();
  }
}

describe('authority repository identity boundary', () => {
  it.each([
    ['DEVAI', 'aarusso-nyx/devai', 'aarusso-nyx-devai'],
    ['STYNX', 'stynx-nyx/stynx', 'stynx-nyx-stynx'],
  ])('%s keeps canonical release id separate from its authority slug', async (_name, id, slug) => {
    const value = fixture(id, slug);
    try {
      expect(repositoryIdFor(value.root)).toBe(slug);
      await expect(invoke(value)).resolves.toBe(true);
      await expect(invoke(value, { ...value.repository, id: slug })).rejects.toThrow(
        'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
      );
      await expect(
        invoke(value, { ...value.repository, id: 'foreign/repository' }),
      ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    } finally {
      value.dispose();
    }
  });

  it('refuses candidate and raw-origin drift before the protected callback', async () => {
    const value = fixture('aarusso-nyx/devai', 'aarusso-nyx-devai');
    try {
      await expect(
        invoke(value, { ...value.repository, commit: 'a'.repeat(value.repository.commit.length) }),
      ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
      await expect(
        invoke(value, value.repository, () =>
          execFileSync('/usr/bin/git', [
            '-C',
            value.root,
            'remote',
            'set-url',
            'origin',
            'ssh://git@github.com/aarusso-nyx/devai.git',
          ]),
        ),
      ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
    } finally {
      value.dispose();
    }
  });
});
