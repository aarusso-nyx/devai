import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, expect, it } from 'vitest';
import {
  CANONICAL_FORBIDDEN_ACTIONS,
  scanForbiddenActions,
} from '../../src/forbidden-actions/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';
const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root: string, args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function commit(root: string, author = 'Fixture') {
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    `user.name=${author}`,
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'change',
  ]);
  return git(root, ['rev-parse', 'HEAD']);
}
function fixture(path: string, operation: string, author = 'Fixture') {
  const root = mkdtempSync(join(tmpdir(), 'devai-forbidden-paths-'));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'core.quotePath', 'true']);
  const registryPath = join(root, 'registry.json');
  writeFileSync(registryPath, JSON.stringify({ actions: CANONICAL_FORBIDDEN_ACTIONS }));
  mkdirSync(dirname(join(root, path)), { recursive: true });
  if (operation !== 'add')
    writeFileSync(join(root, path), 'original contents retained for rename detection\n');
  commit(root);
  if (operation === 'delete') rmSync(join(root, path));
  else if (operation === 'rename') renameSync(join(root, path), join(root, 'moved.txt'));
  else writeFileSync(join(root, path), 'changed contents\n');
  const head = commit(root, author);
  return { head, result: scanForbiddenActions({ repoRoot: root, registryPath, maxCommits: 1 }) };
}
it.each(
  ['ação.json', 'policy\tone.json', 'policy\none.json'].flatMap((name) =>
    ['add', 'modify', 'delete', 'rename'].map((operation) => ({ path: `law/${name}`, operation })),
  ),
)('detects $operation of protected $path despite Git path quoting', ({ path, operation }) => {
  const { head, result } = fixture(path, operation);
  expect(result.findings).toContainEqual(
    expect.objectContaining({
      forbidden_id: 'FORBID-MUTATE-INVARIANTS',
      source: 'commit-change',
      ref: head,
    }),
  );
});
it('preserves Architect authority for a quoted law path', () => {
  const { result } = fixture('law/ação.json', 'modify', 'DEVAI Architect');
  expect(result.findings.filter((f) => f.forbidden_id === 'FORBID-MUTATE-INVARIANTS')).toEqual([]);
});
