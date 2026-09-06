import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProtectedArtifactSinkAdapter,
  createProtectedExportSignerAdapter,
  createProtectedExportSinkAdapter,
  createProtectedReleaseSinkOwner,
  runWithAuthorityHostEffects,
  withProtectedReleaseExportCapacity,
  withProtectedReleasePrepareCapacity,
  type ProtectedReleaseExportBinding,
} from '@devai-nyx/authority';
import { createReleaseRepositoryTestFixture } from '../../../authority/tests/unit/release-repository-test-fixture.js';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { canonicalRegistry } from '../../src/define-command.js';
import { RELEASE_PACK_SPEC_DIGEST } from '../../src/services/release-prepare-kernel.js';
import { resolveCliVersion } from '../../src/version.js';

const WORKSPACE = resolve(import.meta.dirname, '../../../..');
const PLAN = 'a'.repeat(64);
const DIGEST = (character: string) => character.repeat(64);

function fixture() {
  const repository = createReleaseRepositoryTestFixture('aarusso-nyx/devai', 'devai');
  mkdirSync(join(repository.root, '.devai/config'), { recursive: true });
  mkdirSync(join(repository.root, '.devai/pin'), { recursive: true });
  cpSync(
    join(WORKSPACE, '.devai/pin/constitution.md'),
    join(repository.root, '.devai/pin/constitution.md'),
  );
  writeFileSync(
    join(repository.root, '.devai/config/project.json'),
    `${JSON.stringify({ schemaVersion: '1.0.0', project_type: 'runtime-host', name: 'devai' })}\n`,
  );
  return repository;
}

function request(
  repository: ReturnType<typeof fixture>,
  action: 'release export' | 'release prepare',
  destination = exportBinding(repository).destination,
) {
  const path = join(repository.root, `${action.replaceAll(' ', '-')}-request.json`);
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      request_kind: 'release-lifecycle-request',
      action_id: action,
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
      ...(action === 'release export'
        ? { provider: { kind: 'evidence-export', provider_id: 'fixture-export' }, destination }
        : {}),
    })}\n`,
  );
  return path;
}

function exportBinding(repository: ReturnType<typeof fixture>): ProtectedReleaseExportBinding {
  return {
    action_id: 'release export',
    repository: repository.repository,
    candidate: { commit: repository.repository.commit, tree: repository.repository.tree },
    plan_receipt_digest_sha256: PLAN,
    parent_artifact_sink: {
      sink_id: 'fixture-sink',
      transaction_handle: 'prepared-transaction',
      committed_manifest_handle: 'prepared-commit',
      committed_manifest_sha256: DIGEST('b'),
      committed_manifest_size_bytes: 1,
      commit_protocol: 'devai.artifact-sink.two-phase.v1',
    },
    sink_id: 'fixture-sink',
    destination: { kind: 'evidence-destination', exact_identifier: 's3://fixture/export' },
    trust: {
      trust_root_id: 'fixture/trust',
      trust_store_digest_sha256: DIGEST('c'),
      key_id: 'fixture-key',
      signature_algorithm: 'ed25519',
    },
    attempt_id: 'RLA-0123456789abcdef',
    export_spec_digest_sha256: '77ab8fd69d2b3d4edeaebd12b516eb5c15fe910f93ff4516deadd466f0853f98',
    closure_inputs: [
      {
        package_id: '@fixture/package',
        sha256: DIGEST('d'),
        size_bytes: 1,
        expected_installed_package: {
          name: '@aarusso-nyx/devai',
          version: '1.5.0',
          archive_sha256: DIGEST('e'),
          content_manifest_sha256: DIGEST('f'),
        },
        policy_resolution_digest_sha256: DIGEST('1'),
      },
    ],
  };
}

function broker(
  repository: ReturnType<typeof fixture>,
  action: 'release export' | 'release prepare',
  requestPath: string,
) {
  const entries = canonicalRegistry();
  const entry = entries.find((candidate) => candidate.name === action);
  if (entry === undefined) throw new Error(`missing ${action} action`);
  return createAuthorityHostBroker({
    entry,
    entries,
    argv: [
      process.execPath,
      'devai',
      ...action.split(' '),
      '--request',
      requestPath,
      '--as-role',
      'architect',
      '--write',
    ],
    role: 'architect',
    declaration: { as_role: 'architect' },
    repository_root: repository.root,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
}

async function withExportBroker<T>(
  repository: ReturnType<typeof fixture>,
  binding: ProtectedReleaseExportBinding,
  destination = binding.destination,
  callback: (value: {
    readonly sink: ReturnType<typeof createProtectedExportSinkAdapter>;
    readonly signer: ReturnType<typeof createProtectedExportSignerAdapter>;
    readonly host: ReturnType<typeof broker>;
  }) => Promise<T>,
): Promise<T> {
  const host = broker(
    repository,
    'release export',
    request(repository, 'release export', destination),
  );
  const sink = createProtectedExportSinkAdapter(binding);
  const signer = createProtectedExportSignerAdapter(binding);
  try {
    return await repository.run(
      async () =>
        await runWithAuthorityHostEffects(
          host.scope,
          async () =>
            await withProtectedReleaseExportCapacity(
              {
                action_id: 'release export',
                repository: binding.repository,
                candidate: binding.candidate,
                plan_receipt_digest_sha256: binding.plan_receipt_digest_sha256,
              },
              async () => await callback({ sink, signer, host }),
            ),
        ),
    );
  } finally {
    host.dispose();
  }
}

describe('release export broker protected adapters', () => {
  it('routes exactly one export sink and one signer through the live export account', async () => {
    const repository = fixture();
    const binding = exportBinding(repository);
    const owner = createProtectedReleaseSinkOwner('export', binding.sink_id);
    let sinkCalls = 0;
    let signerCalls = 0;
    try {
      await withExportBroker(repository, binding, binding.destination, async ({ sink, signer }) => {
        expect(sink.invokeSink(() => ++sinkCalls, owner)).toBe(1);
        expect(signer.invokeSigner(() => ++signerCalls)).toBe(1);
      });
      expect({ sinkCalls, signerCalls }).toEqual({ sinkCalls: 1, signerCalls: 1 });
    } finally {
      repository.dispose();
    }
  });

  it('does not treat a prepare sink as an export sink, while a real prepare broker remains allowed', async () => {
    const repository = fixture();
    const exportValue = exportBinding(repository);
    const exportOwner = createProtectedReleaseSinkOwner('export', exportValue.sink_id);
    const prepareOwner = createProtectedReleaseSinkOwner('artifact', 'prepared-sink');
    let prepareCalls = 0;
    try {
      await withExportBroker(repository, exportValue, exportValue.destination, async ({ sink }) => {
        const prepare = createProtectedArtifactSinkAdapter({
          action_id: 'release prepare',
          repository: repository.repository,
          plan_receipt_digest_sha256: PLAN,
          pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
          sink_id: 'prepared-sink',
        });
        expect(() => prepare.invokeSink(() => ++prepareCalls, prepareOwner)).toThrow(
          'AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH',
        );
        expect(sink.invokeSink(() => 'export', exportOwner)).toBe('export');
      });
      expect(prepareCalls).toBe(0);

      const prepareHost = broker(
        repository,
        'release prepare',
        request(repository, 'release prepare'),
      );
      const prepare = createProtectedArtifactSinkAdapter({
        action_id: 'release prepare',
        repository: repository.repository,
        plan_receipt_digest_sha256: PLAN,
        pack_spec_digest_sha256: RELEASE_PACK_SPEC_DIGEST,
        sink_id: 'prepared-sink',
      });
      try {
        await repository.run(
          async () =>
            await runWithAuthorityHostEffects(
              prepareHost.scope,
              async () =>
                await withProtectedReleasePrepareCapacity(
                  {
                    action_id: 'release prepare',
                    repository: repository.repository,
                    candidate: {
                      commit: repository.repository.commit,
                      tree: repository.repository.tree,
                    },
                    plan_receipt_digest_sha256: PLAN,
                  },
                  async () => {
                    expect(prepare.invokeSink(() => ++prepareCalls, prepareOwner)).toBe(1);
                  },
                ),
            ),
        );
      } finally {
        prepareHost.dispose();
      }
      expect(prepareCalls).toBe(1);
    } finally {
      repository.dispose();
    }
  });

  it.each([
    [
      'destination',
      (value: ProtectedReleaseExportBinding) => ({
        ...value.destination,
        exact_identifier: 's3://fixture/other',
      }),
    ],
    [
      'trust',
      (value: ProtectedReleaseExportBinding) => ({
        ...value.destination,
        trust: { ...value.trust, key_id: 'other-key' },
      }),
    ],
  ])(
    'refuses a request %s that differs from the captured export binding',
    async (_name, select) => {
      const repository = fixture();
      const binding = exportBinding(repository);
      const owner = createProtectedReleaseSinkOwner('export', binding.sink_id);
      let calls = 0;
      try {
        await expect(
          withExportBroker(repository, binding, select(binding), async ({ sink }) => {
            sink.invokeSink(() => ++calls, owner);
          }),
        ).rejects.toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');
        expect(calls).toBe(0);
      } finally {
        repository.dispose();
      }
    },
  );

  it('pins the complete export binding for one live account and rejects forged protected operations', async () => {
    const repository = fixture();
    const binding = exportBinding(repository);
    const owner = createProtectedReleaseSinkOwner('export', binding.sink_id);
    let calls = 0;
    try {
      await withExportBroker(repository, binding, binding.destination, async ({ sink, host }) => {
        expect(sink.invokeSink(() => ++calls, owner)).toBe(1);
        const [closure] = binding.closure_inputs;
        if (closure === undefined) throw new Error('fixture closure missing');
        for (const changed of [
          { ...binding, attempt_id: 'RLA-fedcba9876543210' },
          {
            ...binding,
            parent_artifact_sink: {
              ...binding.parent_artifact_sink,
              committed_manifest_handle: 'other-prepared-commit',
            },
          },
          {
            ...binding,
            closure_inputs: [{ ...closure, policy_resolution_digest_sha256: DIGEST('2') }],
          },
        ]) {
          const changedSink = createProtectedExportSinkAdapter(changed);
          expect(() => changedSink.invokeSink(() => ++calls, owner)).toThrow(
            'AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID',
          );
        }
        expect(() =>
          host.scope.apply_effect(
            {
              kind: 'protected-release',
              symbol: 'protectedExportOperation',
              arguments: [Object.freeze({})],
            },
            () => ++calls,
          ),
        ).toThrow('AUTHORITY_PROTECTED_RELEASE_ACTION_MISMATCH');
      });
      expect(calls).toBe(1);
    } finally {
      repository.dispose();
    }
  });
});
