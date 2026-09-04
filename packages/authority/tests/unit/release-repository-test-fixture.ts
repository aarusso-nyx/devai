import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createProtectedReleaseRepositoryContext,
  withProtectedReleaseRepositoryContext,
} from '../../src/boundaries/host-effects.js';

const GIT = '/usr/bin/git';

export function createReleaseRepositoryTestFixture(
  repositoryId = 'fixture/repository',
  authorityRepositoryId = 'fixture-repository',
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'devai release fixture ç ')));
  const git = (args: readonly string[]) =>
    execFileSync(GIT, ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.name', 'DEVAI Release Fixture']);
  git(['config', 'user.email', 'release-fixture@example.invalid']);
  git(['remote', 'add', 'origin', `https://github.com/${repositoryId}.git`]);
  writeFileSync(join(root, 'README.md'), 'release repository fixture\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'initial']);
  const repository = Object.freeze({
    id: repositoryId,
    commit: git(['rev-parse', 'HEAD']),
    tree: git(['rev-parse', 'HEAD^{tree}']),
  });
  const context = createProtectedReleaseRepositoryContext({
    repository_root: root,
    authority_repository_id: authorityRepositoryId,
    read_expected_release_repository_id: () => repositoryId,
    repository,
  });
  return Object.freeze({
    repository,
    run: async <T>(callback: () => T | Promise<T>): Promise<T> =>
      await withProtectedReleaseRepositoryContext(context, callback),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  });
}
