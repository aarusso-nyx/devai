import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const observation = vi.hoisted(() => ({ stalePresentPath: '' }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // Model the positive existence observation immediately before a competing
    // append owner removes its lock. The subsequent real lstat sees ENOENT.
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path) === observation.stalePresentPath || actual.existsSync(path),
  };
});
import { snapshot } from '../../src/authority/broker-paths.js';

const roots: string[] = [];
afterEach(() => {
  observation.stalePresentPath = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-snapshot-race-'));
  roots.push(path);
  return path;
}
describe('broker snapshots of contended filesystem entries', () => {
  it('records absence when an append lock disappears after a positive existence observation', () => {
    const directory = root();
    observation.stalePresentPath = join(directory, 'chain.json.append.lock');
    expect(snapshot(directory, 'chain.json.append.lock')).toBeUndefined();
  });
  it('records an ordinary absent target', () => {
    expect(snapshot(root(), 'missing')).toBeUndefined();
  });
  it('retains a regular file snapshot', () => {
    const directory = root();
    writeFileSync(join(directory, 'entry'), 'bytes');
    expect(snapshot(directory, 'entry')).toMatchObject({ kind: 'file', size: 5 });
  });
  it('retains a directory snapshot', () => {
    const directory = root();
    mkdirSync(join(directory, 'entry'));
    expect(snapshot(directory, 'entry')).toMatchObject({ kind: 'directory' });
  });
  it('records a dangling symlink as an existing entry', () => {
    const directory = root();
    symlinkSync('missing', join(directory, 'entry'));
    expect(snapshot(directory, 'entry')).toMatchObject({ kind: 'symlink' });
  });
});
