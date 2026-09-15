// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import type { AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { canonicalSha256 } from '@devai-nyx/utils';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { boundedSelectors, makeEnvelope, processTarget } from '../../src/authority/broker.js';

const REPOSITORY = 'devai-test';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function request(executable: string, args: readonly string[]): AuthorityHostEffectRequest {
  return { kind: 'process', symbol: 'spawnSync', arguments: [executable, args] };
}

describe('authority broker selector and envelope values', () => {
  it.each([
    ['protected-export-signer', 'release export', 'protected-export-signer-v1', 'sign'],
    ['artifact-sink', 'release export', 'trusted-export-artifact-sink-v1', 'write'],
    ['artifact-sink', 'release prepare', 'trusted-artifact-sink-v3', 'write'],
    [
      'protected-certification-provider',
      'release certify',
      'devai-protected-certification-provider-v3',
      'execute',
    ],
    [
      'protected-certification-provider',
      'release preflight',
      'devai-protected-certification-provider-v3',
      'execute',
    ],
    [
      'certification-evidence-sink',
      'release certify',
      'trusted-certification-evidence-sink-v1',
      'write',
    ],
  ] as const)('binds %s for %s to %s/%s', (kind, action, systemId, operationId) => {
    expect(boundedSelectors(kind, REPOSITORY, action)).toEqual([
      {
        kind: 'remote',
        system_id: systemId,
        endpoint_ids: ['host'],
        operation_ids: [operationId],
        publication: false,
      },
    ]);
  });

  it.each([
    ['artifact-sink', 'task start'],
    ['protected-export-signer', 'release prepare'],
    ['protected-certification-provider', 'task start'],
    ['certification-evidence-sink', 'release preflight'],
  ] as const)('does not grant the %s protected selector to %s', (kind, action) => {
    expect(boundedSelectors(kind, REPOSITORY, action)).toEqual([
      {
        kind: 'remote',
        system_id: 'local-llm',
        endpoint_ids: ['claude', 'codex'],
        operation_ids: ['invoke'],
        publication: false,
      },
    ]);
  });

  it('binds filesystem operations to the exact repository', () => {
    expect(boundedSelectors('fs', REPOSITORY, 'task start')).toEqual([
      {
        kind: 'fs',
        repository_id: REPOSITORY,
        canonical_relative_path_glob: '**',
        operations: ['create', 'update', 'delete', 'rename'],
      },
    ]);
  });

  it('binds Git reference operations to the exact repository', () => {
    expect(boundedSelectors('git-ref', REPOSITORY, 'round run')).toEqual([
      {
        kind: 'git-ref',
        repository_id: REPOSITORY,
        ref_glob: 'refs/**',
        operations: ['create', 'update', 'delete', 'merge', 'push'],
      },
    ]);
  });

  it('binds database operations to the protected control connection', () => {
    expect(boundedSelectors('db', REPOSITORY, 'task start')).toEqual([
      {
        kind: 'db',
        connection_id: 'devai-control',
        database_id_glob: '**',
        object_id_glob: '**',
        operations: ['insert', 'update', 'delete', 'ddl', 'execute'],
      },
    ]);
  });

  it.each([
    ['sense run', 'local-llm', ['claude', 'codex']],
    ['evidence record', 'local-command', ['test-runner']],
    ['round run', 'local-command', ['routine-executor']],
    ['task start', 'local-llm', ['claude', 'codex']],
  ] as const)('binds the %s remote selector', (action, systemId, endpointIds) => {
    expect(boundedSelectors('remote', REPOSITORY, action)).toEqual([
      {
        kind: 'remote',
        system_id: systemId,
        endpoint_ids: endpointIds,
        operation_ids: ['invoke'],
        publication: false,
      },
    ]);
  });

  it('binds Mermaid output for either the command name or an absolute binary path', () => {
    for (const executable of ['mmdc', '/opt/tools/mmdc']) {
      expect(
        processTarget(
          request(executable, ['--input', 'diagram.mmd', '--output', 'scratch/result.svg']),
          'round run',
          ROOT,
          REPOSITORY,
          [],
        ),
      ).toEqual({
        kind: 'fs',
        id: 'fs:scratch/result.svg',
        repository_id: REPOSITORY,
        canonical_relative_path: 'scratch/result.svg',
        operation: 'create',
      });
    }
  });

  it('classifies an existing Mermaid output as an update', () => {
    expect(
      processTarget(
        request('mmdc', ['--output', 'package.json']),
        'round run',
        ROOT,
        REPOSITORY,
        [],
      ),
    ).toMatchObject({ canonical_relative_path: 'package.json', operation: 'update' });
  });

  it.each([
    ['mmdc', ['--input', 'diagram.mmd']],
    ['mmdc', ['--output']],
    ['other', ['--output', 'scratch/result.svg']],
  ] as const)('rejects an incomplete Mermaid target for %s %j', (executable, args) => {
    expect(
      processTarget(request(executable, args), 'round run', ROOT, REPOSITORY, []),
    ).toBeUndefined();
  });

  it('builds a binding envelope whose digest covers every unsigned field', () => {
    const input = {
      invocationId: 'invocation-1',
      actionId: 'devai.action.test',
      effect: 'local-write',
      repositoryId: REPOSITORY,
      consent: { mode: 'explicit' },
      policy: { version: '1.0.0' },
      now: '2026-09-06T12:00:00.000Z',
    };
    const envelope = makeEnvelope(input);
    const { issued_by: issuedBy, ...unsigned } = envelope;
    expect(issuedBy).toEqual({
      adapter_id: 'devai-cli-authority',
      adapter_version: '1.0.0',
      envelope_digest_sha256: canonicalSha256({
        ...unsigned,
        issued_by: {
          adapter_id: 'devai-cli-authority',
          adapter_version: '1.0.0',
        },
      }),
    });
    expect(envelope).toMatchObject({
      envelope_id: 'envelope-invocation-1',
      request: {
        request_id: 'request-invocation-1',
        repository_id: REPOSITORY,
        action_id: 'devai.action.test',
        dry_run: false,
        requested_at: input.now,
        invocation_id: input.invocationId,
        consent: input.consent,
      },
      action_effect: 'local-write',
      enforcement_mode: 'binding',
      policy: input.policy,
    });
  });
});
