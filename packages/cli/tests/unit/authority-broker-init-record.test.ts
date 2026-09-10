// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
import { runWithAuthorityHostEffects, type AuthorityHostEffectRequest } from '@devai-nyx/authority';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAuthorityHostBroker } from '../../src/authority/broker.js';
import { getFullRegistry, type RegistryEntry } from '../../src/define-command.js';
import { computeManifestHash, deriveEvidenceId } from '../../src/runtime-core.js';
import { resolveCliVersion } from '../../src/version.js';
import { createSelfContainedRepositoryFixture } from '../helpers/self-contained-repository-fixture.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const originalArgv = [...process.argv];
const originalStdout = process.stdout.write;
const fixtures: Array<ReturnType<typeof createSelfContainedRepositoryFixture>> = [];
let entries: readonly RegistryEntry[];

beforeAll(async () => {
  process.argv = [process.execPath, 'devai', '--help'];
  process.stdout.write = (() => true) as typeof process.stdout.write;
  await import('../../src/bin.js');
  entries = getFullRegistry();
  process.stdout.write = originalStdout;
  process.argv = [...originalArgv];
});

afterEach(() => {
  vi.useRealTimers();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

afterAll(() => {
  process.stdout.write = originalStdout;
  process.argv = [...originalArgv];
});

function effect(
  kind: AuthorityHostEffectRequest['kind'],
  symbol: string,
  args: readonly unknown[],
): AuthorityHostEffectRequest {
  return { kind, symbol, arguments: args };
}

function initBroker() {
  const fixture = createSelfContainedRepositoryFixture(ROOT, {
    paths: ['.devai/config/project.json', '.devai/pin/constitution.md'],
  });
  fixtures.push(fixture);
  const entry = entries.find((candidate) => candidate.name === 'init apply harness');
  if (entry === undefined) throw new Error('missing init apply harness action');
  const host = createAuthorityHostBroker({
    entry,
    entries,
    argv: [
      process.execPath,
      'devai',
      'init',
      'apply',
      'harness',
      '--as-role',
      'architect',
      '--write',
    ],
    role: 'architect',
    declaration: { as_role: 'architect' },
    repository_root: fixture.root,
    package_version: resolveCliVersion(),
    bootstrap_policy: true,
  });
  return { fixture, host };
}

describe('authority broker init-record boundary', () => {
  it('captures filesystem mutation while passing only read-only processes', () => {
    const { fixture, host } = initBroker();
    const recorder = host.record_init('harness');
    try {
      expect(recorder.scope).toMatchObject({
        action_id: 'init record',
        effect: 'harness-write',
      });
      expect(
        recorder.scope.apply_effect(
          effect('process', 'spawnSync', ['git', ['status']]),
          () => 'read-result',
        ),
      ).toBe('read-result');
      expect(() =>
        recorder.scope.apply_effect(
          effect('process', 'spawnSync', ['git', ['commit']]),
          () => 'forbidden',
        ),
      ).toThrow('AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED');
      expect(
        recorder.scope.apply_effect(
          effect('filesystem', 'mkdirSync', [join(fixture.root, '.devai')]),
          () => 'must-not-run',
        ),
      ).toBeUndefined();
      expect(() =>
        recorder.scope.apply_effect(effect('filesystem', 'mkdirSync', [17]), () => undefined),
      ).toThrow('AUTHORITY_FS_TARGET_INVALID');

      runWithAuthorityHostEffects(host.scope, recorder.execute);

      expect(
        JSON.parse(readFileSync(join(fixture.root, '.devai/state/evidence-chain.json'), 'utf8')),
      ).toMatchObject({ records: [{ action: 'init.apply-harness' }] });

      const denied = host.record_init('harness');
      let deniedApplied = false;
      denied.scope.apply_effect(
        effect('filesystem', 'writeFileSync', [join(fixture.root, '.devai'), '{}\n']),
        () => {
          deniedApplied = true;
        },
      );
      expect(() => runWithAuthorityHostEffects(host.scope, denied.execute)).toThrow(
        'AUTHORITY_ACTION_DENIED',
      );
      expect(deniedApplied).toBe(false);
    } finally {
      host.dispose();
    }
  });

  it('appends exact evidence records and preserves existing counters', () => {
    const { fixture, host } = initBroker();
    const state = join(fixture.root, '.devai/state');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'counters.json'), '{"round":7}\n');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2031-02-03T04:05:06.000Z'));
      const firstRecord = host.record_init('harness');
      runWithAuthorityHostEffects(host.scope, firstRecord.execute);
      const first = JSON.parse(readFileSync(join(state, 'evidence-chain.json'), 'utf8')) as {
        head: string;
      };
      vi.setSystemTime(new Date('2031-02-03T04:06:07.000Z'));
      const secondRecord = host.record_init('owner');
      runWithAuthorityHostEffects(host.scope, secondRecord.execute);

      expect(readFileSync(join(state, 'counters.json'), 'utf8')).toBe('{"round":7}\n');
      const chain = JSON.parse(readFileSync(join(state, 'evidence-chain.json'), 'utf8')) as {
        head: string;
        records: Array<Record<string, unknown>>;
      };
      expect(chain.records).toHaveLength(2);
      const firstGit = (chain.records[0]?.['context'] as Record<string, unknown>)['git'] as Record<
        string,
        unknown
      >;
      const firstIdentity = {
        timestamp: '2031-02-03T04:05:06.000Z',
        actor: 'devai-cli',
        actor_role: 'harness',
        action: 'init.apply-harness',
        status: 'completed',
        git_head_sha: firstGit['head_sha'],
        artifact_sha256s: [],
        previous_run_hash: null,
      };
      expect(chain.records[0]).toMatchObject({
        schemaVersion: '1.0.0',
        id: deriveEvidenceId(firstIdentity),
        timestamp: '2031-02-03T04:05:06.000Z',
        actor: 'devai-cli',
        actor_role: 'harness',
        action: 'init.apply-harness',
        status: 'completed',
        context: { repo_root: fixture.root },
        artifacts: [],
        notes: ['initiated_by=architect'],
        previous_run_hash: null,
        manifest_hash: computeManifestHash({
          ...firstIdentity,
          id: deriveEvidenceId(firstIdentity),
        }),
      });
      const secondGit = (chain.records[1]?.['context'] as Record<string, unknown>)['git'] as Record<
        string,
        unknown
      >;
      const secondIdentity = {
        timestamp: '2031-02-03T04:06:07.000Z',
        actor: 'devai-cli',
        actor_role: 'harness',
        action: 'init.apply-owner',
        status: 'completed',
        git_head_sha: secondGit['head_sha'],
        artifact_sha256s: [],
        previous_run_hash: first.head,
      };
      expect(chain.records[1]).toMatchObject({
        schemaVersion: '1.0.0',
        id: deriveEvidenceId(secondIdentity),
        timestamp: '2031-02-03T04:06:07.000Z',
        actor: 'devai-cli',
        actor_role: 'harness',
        action: 'init.apply-owner',
        status: 'completed',
        context: { repo_root: fixture.root },
        artifacts: [],
        notes: ['initiated_by=architect'],
        previous_run_hash: first.head,
        manifest_hash: computeManifestHash({
          ...secondIdentity,
          id: deriveEvidenceId(secondIdentity),
        }),
      });
      expect(chain.head).toBe(chain.records[1]?.['manifest_hash']);
    } finally {
      host.dispose();
    }
  });
});
