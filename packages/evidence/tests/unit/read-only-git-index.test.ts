import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, expect, it, vi } from 'vitest';
import { gatherGitContext } from '../../src/evidence/git-context.js';
import { verifyProofAnchors } from '../../src/evidence/anchors.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];
aroundEach((run) => withAuthorityHostTestScope(run));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-readonly-index-'));
  roots.push(root);
  const git = (args: readonly string[], optional = '0') =>
    execFileSync('/usr/bin/git', [...args], {
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: optional,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git(['init', '--quiet', '--template=', '--initial-branch=main']);
  mkdirSync(join(root, 'record/proofs'), { recursive: true });
  const chain = join(root, 'record/proofs/chain.json');
  writeFileSync(chain, JSON.stringify({ head: null, records: [] }) + '\n');
  writeFileSync(
    join(root, 'record/proofs/anchor-baseline.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      record: 'ADR-EVI-0002',
      cutoff: '2026-10-24T00:00:00.000Z',
      entries: [],
    }) + '\n',
  );
  git(['add', '--all']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@invalid.test',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  const index = join(root, '.git/index'),
    before = readFileSync(index),
    epoch = readFileSync(chain);
  // Content stays identical but the tracked stat cache is definitely stale.
  const old = new Date(Date.now() - 60000);
  utimesSync(chain, old, old);
  vi.stubEnv('GIT_OPTIONAL_LOCKS', '1');
  return { root, index, before, chain, epoch, git };
}
it('Git context overrides contrary parent optional-locks and leaves the physical index untouched', () => {
  const f = fixture();
  expect(gatherGitContext(f.root).dirty_files).toEqual([]);
  expect(readFileSync(f.index)).toEqual(f.before);
  expect(readFileSync(f.chain)).toEqual(f.epoch);
  // Independent native control proves this fixture can expose a cache write.
  f.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], '1');
  expect(readFileSync(f.index)).not.toEqual(f.before);
});
it('historical proof verification overrides contrary parent optional-locks without refreshing the index', () => {
  const f = fixture();
  expect(verifyProofAnchors({ repoRoot: f.root, write: false }).valid).toBe(true);
  expect(readFileSync(f.index)).toEqual(f.before);
  expect(readFileSync(f.chain)).toEqual(f.epoch);
  f.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], '1');
  expect(readFileSync(f.index)).not.toEqual(f.before);
});
