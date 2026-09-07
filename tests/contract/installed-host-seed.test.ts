import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const { inspectInstalledHostSeed } = await import(
  pathToFileURL(resolve('scripts/process/installed-export-command.mjs')).href
);
const roots: string[] = [];
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'installed seed ação-')));
  roots.push(parent);
  const root = join(parent, 'seed'),
    candidateRoot = join(parent, 'candidate');
  mkdirSync(candidateRoot);
  mkdirSync(root);
  mkdirSync(join(root, 'host'));
  mkdirSync(join(root, 'index'));
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    'host/provision-package.mjs': 'throw new Error("inspection must never execute this module");\n',
    'index/release-host-bootstrap.js':
      'throw new Error("inspection must never execute this module");\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const members = Object.fromEntries(
    Object.keys(files).map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(join(root, name)))
        .digest('hex'),
    ]),
  );
  return { root, candidateRoot, members };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('inspects a complete pinned seed without executing its code', () => {
  const f = fixture();
  expect(inspectInstalledHostSeed(f)).toBe(join(f.root, 'host/provision-package.mjs'));
});
it.each(['package.json', 'host/provision-package.mjs', 'index/release-host-bootstrap.js'])(
  'refuses changed approved seed bytes: %s',
  (name) => {
    const f = fixture();
    writeFileSync(join(f.root, name), 'changed');
    expect(() => inspectInstalledHostSeed(f)).toThrow('INSTALLED_HOST_SEED_DIGEST_MISMATCH');
  },
);
it.each(['missing', 'extra', 'empty directory', 'symlink'])(
  'refuses a changed seed population: %s',
  (kind) => {
    const f = fixture();
    if (kind === 'missing') rmSync(join(f.root, 'host/provision-package.mjs'));
    if (kind === 'extra') writeFileSync(join(f.root, 'index/extra.js'), '');
    if (kind === 'empty directory') mkdirSync(join(f.root, 'extra'));
    if (kind === 'symlink') {
      rmSync(join(f.root, 'host/provision-package.mjs'));
      symlinkSync('../index/release-host-bootstrap.js', join(f.root, 'host/provision-package.mjs'));
    }
    expect(() => inspectInstalledHostSeed(f)).toThrow('INSTALLED_HOST_SEED_POPULATION_INVALID');
  },
);
it('refuses seed code inside the candidate', () => {
  const f = fixture();
  expect(() => inspectInstalledHostSeed({ ...f, candidateRoot: f.root })).toThrow(
    'INSTALLED_HOST_SEED_LOCATION_INVALID',
  );
});
it('requires complete external pins before reading seed code', () => {
  expect(() =>
    inspectInstalledHostSeed({ root: '/absent', candidateRoot: '/absent', members: {} }),
  ).toThrow('INSTALLED_HOST_SEED_PINS_REQUIRED');
});
