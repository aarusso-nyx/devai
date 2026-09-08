import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { introspectRepo } from '../../src/bootstrap/introspect.js';

let root: string;
const now = '2026-09-08T09:15:00.000Z';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-introspection-secret-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function file(path: string, content = ''): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

it.each(['\n', '\r', '\u2028', '\u2029'])(
  'flags a secret filename containing a line terminator: %j',
  (separator) => {
    file('secret.prod', 'TOKEN=1');
    file(`secret.prod${separator}backup`, 'TOKEN=1');
    const result = introspectRepo({ targetRoot: root, now });
    expect(result.protected_surfaces).toEqual(['secret.prod', `secret.prod${separator}backup`]);
  },
);
