import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { senseTestWeakening } from '../../src/test-weakening.js';

let root: string;
function git(...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-weakening-real-git-'));
  git('init', '-q');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const source = 'expect(1).toBe(1); expect(2).toBe(2);';

describe('test weakening exact Git file population', () => {
  it.each(['space name.test.ts', 'ação.test.ts', 'line\nbreak.spec.ts'])(
    'compares the exact changed filename %j through real Git',
    async (name) => {
      writeFileSync(join(root, name), source);
      git('add', '--', name);
      git('commit', '-qm', 'base');
      writeFileSync(join(root, name), 'expect(1).toBe(1);');
      const reading = await withAuthorityHostTestScope(() =>
        senseTestWeakening({ cwd: root, baseRef: 'HEAD' }),
      );
      expect(reading.status).toBe('fail');
      expect(reading.metrics).toEqual({ files_checked: 1, drift_count: 1 });
      expect(reading.findings?.map((f) => [f.file, f.code])).toEqual([
        [name, 'unjustified_weakening'],
      ]);
    },
  );

  it('confirms a staged new file is absent from the existing base tree', async () => {
    writeFileSync(join(root, 'existing.test.ts'), source);
    git('add', '.');
    git('commit', '-qm', 'base');
    writeFileSync(join(root, 'new.test.ts'), source);
    git('add', '--', 'new.test.ts');
    const reading = await withAuthorityHostTestScope(() =>
      senseTestWeakening({ cwd: root, baseRef: 'HEAD' }),
    );
    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({ files_checked: 0, drift_count: 0 });
  });
});
