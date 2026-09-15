import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, expect, it, vi } from 'vitest';
import { gatherGitContext } from '../../src/evidence/git-context.js';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';

const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const head = 'a'.repeat(40);
// Exercise the real subprocess transport and parser, including a Git failure,
// without requiring the installed Git to emit a malformed porcelain stream.
function transport(status: string, failStatus = false) {
  const root = mkdtempSync(join(tmpdir(), 'devai-git-transport-'));
  roots.push(root);
  const executable = join(root, 'git');
  writeFileSync(
    executable,
    `#!${process.execPath}\nif(process.argv[2]==='rev-parse'){process.stdout.write('${head}\\n');}else{process.stdout.write(Buffer.from('${Buffer.from(status).toString('base64')}','base64'));process.exitCode=${failStatus ? 1 : 0};}\n`,
  );
  chmodSync(executable, 0o700);
  vi.stubEnv('PATH', root);
  return root;
}

it('preserves the verified head but discards output from a failed status command', () => {
  const root = transport(' M untrusted.txt\0', true);
  expect(gatherGitContext(root)).toEqual({ head_sha: head, dirty_files: [] });
});

it.each([
  {
    label: 'three-character status with no path',
    status: ' M \0?? valid.txt\0',
    expected: ['valid.txt'],
  },
  {
    label: 'empty rename source',
    status: 'R  target.txt\0\0?? valid.txt\0',
    expected: ['target.txt', 'valid.txt'],
  },
  { label: 'absent rename source', status: 'R  target.txt', expected: ['target.txt'] },
  {
    label: 'copy source and following path',
    status: 'C  target.txt\0source.txt\0?? valid.txt\0',
    expected: ['target.txt', 'source.txt', 'valid.txt'],
  },
])('handles $label without adding an empty or undefined dirty path', ({ status, expected }) => {
  const root = transport(status);
  expect(gatherGitContext(root)).toEqual({ head_sha: head, dirty_files: expected });
});
