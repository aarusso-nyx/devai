import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishPrivateNoReplacePreparedSteps } from '../../src/boundaries/host-publish.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-prepared-private-'));
  roots.push(root);
  const target = join(root, 'approval.json');
  const name = `.approval.json.${String(process.pid)}-${randomUUID()}.publish-staged`;
  return { root, target, name };
}
const bytes = 'PUBLIC_TEST_MARKER_NO_PRIVATE_KEY\n';

describe('internal fixed sibling private publisher', () => {
  it('publishes exact prepared bytes with0600 and returns the final native identity', () => {
    const f = fixture();
    const identity = publishPrivateNoReplacePreparedSteps(f.target, f.name, bytes);
    const actual = lstatSync(f.target, { bigint: true });
    expect(readFileSync(f.target, 'utf8')).toBe(bytes);
    expect(readdirSync(f.root)).toEqual(['approval.json']);
    expect(actual.mode & 0o7777n).toBe(0o600n);
    expect(actual.nlink).toBe(1n);
    expect({ dev: actual.dev, ino: actual.ino, birthtimeNs: actual.birthtimeNs }).toEqual(identity);
  });

  it.each([
    '../approval.json',
    '/tmp/approval.json',
    '.approval.json.1-00000000-0000-4000-8000-000000000000.publish-staged',
    '.foreign.json.PID-00000000-0000-4000-8000-000000000000.publish-staged',
    '.approval.json.PID-00000000-0000-1000-8000-000000000000.publish-staged',
    '.approval.json.PID-00000000-0000-4000-0000-000000000000.publish-staged',
    '.approval.json.PID-00000000-0000-4000-8000-000000000000.publish-staged/foreign',
    '.approval.json.PID-00000000-0000-4000-8000-000000000000.publish-staged\0',
  ])('rejects a non-derived prepared name before guard or filesystem effects: %s', (name) => {
    const f = fixture();
    let guards = 0;
    expect(() =>
      publishPrivateNoReplacePreparedSteps(
        f.target,
        name.replace('PID', String(process.pid)),
        bytes,
        {
          verifyPrepared: () => {
            guards++;
          },
        },
      ),
    ).toThrow('AUTHORITY_PRIVATE_PUBLICATION_PREPARED_PATH_INVALID');
    expect(guards).toBe(0);
    expect(readdirSync(f.root)).toEqual([]);
  });

  it('preserves a foreign exact scratch target without writing or removing it', () => {
    const f = fixture();
    const scratch = join(f.root, f.name);
    writeFileSync(scratch, 'FOREIGN\n', { flag: 'wx', mode: 0o600 });
    const before = lstatSync(scratch, { bigint: true });
    expect(() => publishPrivateNoReplacePreparedSteps(f.target, f.name, bytes)).toThrow();
    expect(readFileSync(scratch, 'utf8')).toBe('FOREIGN\n');
    expect(lstatSync(scratch, { bigint: true }).ino).toBe(before.ino);
    expect(readdirSync(f.root)).toEqual([f.name]);
  });

  it('preserves a foreign publication and removes only its own scratch', () => {
    const f = fixture();
    writeFileSync(f.target, 'FOREIGN\n', { flag: 'wx', mode: 0o600 });
    const before = lstatSync(f.target, { bigint: true });
    expect(() => publishPrivateNoReplacePreparedSteps(f.target, f.name, bytes)).toThrow();
    expect(readFileSync(f.target, 'utf8')).toBe('FOREIGN\n');
    expect(lstatSync(f.target, { bigint: true }).ino).toBe(before.ino);
    expect(readdirSync(f.root)).toEqual(['approval.json']);
  });

  it('a changed prepared guard refuses publication and cleans only known scratch', () => {
    const f = fixture();
    let guards = 0;
    expect(() =>
      publishPrivateNoReplacePreparedSteps(f.target, f.name, bytes, {
        verifyPrepared: () => {
          if (++guards === 2) throw new Error('STALE_NATIVE_SOURCE');
        },
      }),
    ).toThrow('STALE_NATIVE_SOURCE');
    expect(readdirSync(f.root)).toEqual([]);
  });
});
