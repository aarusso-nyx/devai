import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
const { sandboxWorkspaceAliases } = (await import(
  pathToFileURL(join(process.cwd(), 'scripts/release-host/mutation-workspace-aliases.mjs')).href
)) as { sandboxWorkspaceAliases: (root: string) => Array<{ find: RegExp; replacement: string }> };

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture(exports: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-alias-'));
  roots.push(root);
  const directory = join(root, 'packages/sensors');
  mkdirSync(join(directory, 'src'), { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@devai-nyx/sensors', exports }),
  );
  writeFileSync(join(directory, 'src/index.ts'), 'export const value = 1;');
  writeFileSync(join(directory, 'src/registry.ts'), 'export const value = 2;');
  return { root, directory };
}
it('maps root and explicit development subpaths exactly into the sandbox', () => {
  const { root, directory } = fixture({
    '.': { development: './src/index.ts', default: './dist/index.js' },
    './registry': { development: './src/registry.ts', default: './dist/registry.js' },
    './installed': { import: './dist/installed.js' },
  });
  const aliases = sandboxWorkspaceAliases(root);
  const match = (specifier: string) =>
    aliases.filter(({ find }: { find: RegExp }) => find.test(specifier));
  expect(
    match('@devai-nyx/sensors').map(({ replacement }: { replacement: string }) => replacement),
  ).toEqual([join(directory, 'src/index.ts')]);
  expect(
    match('@devai-nyx/sensors/registry').map(
      ({ replacement }: { replacement: string }) => replacement,
    ),
  ).toEqual([join(directory, 'src/registry.ts')]);
  expect(match('@devai-nyx/sensors/registry/other')).toEqual([]);
  expect(match('@devai-nyx/sensors/installed')).toEqual([]);
  expect(match('@devai-nyx/sensors-extra')).toEqual([]);
});
it.each(['../outside.ts', './src/missing.ts'])(
  'refuses unavailable or escaped entry %s',
  (development) => {
    const { root } = fixture({ '.': { development } });
    expect(() => sandboxWorkspaceAliases(root)).toThrow('release-mutation-workspace-entry-invalid');
  },
);

it('refuses an entrypoint symlink that escapes the instrumented package', () => {
  const { root, directory } = fixture({ '.': { development: './src/index.ts' } });
  writeFileSync(join(root, 'original.ts'), 'export const value = 3;');
  rmSync(join(directory, 'src/index.ts'));
  symlinkSync(join(root, 'original.ts'), join(directory, 'src/index.ts'));
  expect(() => sandboxWorkspaceAliases(root)).toThrow('release-mutation-workspace-entry-invalid');
});
