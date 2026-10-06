// Invariants: INV-CORE-011
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RootExport {
  readonly types?: string;
  readonly development?: string;
  readonly import?: string;
  readonly default?: string;
}

interface Manifest {
  readonly exports?: Record<string, RootExport | string>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Every workspace package that declares a root export, whatever its shape, from its manifest. */
const ROOT_EXPORT_PACKAGES = readdirSync('packages', { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`packages/${entry.name}/package.json`))
  .map((entry) => entry.name)
  .filter((name) => {
    const root = readJson<Manifest>(`packages/${name}/package.json`).exports?.['.'];
    return root !== undefined;
  })
  .sort();

/**
 * The barrels INV-CORE-011 claims: the indexes of the packages whose index holds no code, plus
 * the CLI barrels. Other package indexes (authority, effects-check, schemas) declare code and
 * are not claimed here.
 */
const BARRELS = [
  'packages/cli/src/index.ts',
  'packages/cli/src/runtime-core.ts',
  'packages/loop/src/index.ts',
  'packages/skills/src/index.ts',
  'packages/spec/src/index.ts',
  'packages/utils/src/index.ts',
];

function statements(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('package barrels', () => {
  it('derives every claimed package index from a workspace package with a root export', () => {
    for (const barrel of BARRELS.filter((path) => path !== 'packages/cli/src/index.ts')) {
      const name = barrel.split('/')[1] ?? '';
      if (name !== 'cli') expect(ROOT_EXPORT_PACKAGES).toContain(name);
    }
  });

  it.each(BARRELS)('%s only re-exports', (barrel) => {
    for (const line of statements(readFileSync(barrel, 'utf8'))) {
      expect(line).toMatch(/^export (type )?(\*|\{[^}]*\}) from '[^']+';$/);
    }
  });

  it.each(BARRELS)('%s relative re-exports resolve to existing modules', (barrel) => {
    const source = readFileSync(barrel, 'utf8');
    for (const match of source.matchAll(/from '(\.[^']+)\.js';/g)) {
      const target = join(dirname(barrel), match[1] ?? '');
      expect(existsSync(`${target}.ts`) || existsSync(join(target, 'index.ts'))).toBe(true);
    }
  });

  it.each(ROOT_EXPORT_PACKAGES)(
    '@devai-nyx/%s root export is its source index in development and its build in production',
    (name) => {
      const declared = readJson<Manifest>(`packages/${name}/package.json`).exports?.['.'];
      // A string or any non-conditional shape cannot carry the development and production entries.
      expect(typeof declared).toBe('object');
      const root = declared as RootExport;
      expect(root.development).toBe('./src/index.ts');
      expect(root.default).toBe('./dist/index.js');
      expect(root.types).toBe('./dist/index.d.ts');
      expect(root.import ?? root.default).toBe('./dist/index.js');
      const compiler = readJson<{ compilerOptions?: { rootDir?: string; outDir?: string } }>(
        `packages/${name}/tsconfig.json`,
      ).compilerOptions;
      expect(compiler?.rootDir).toBe('./src');
      expect(compiler?.outDir).toBe('./dist');
    },
  );
});
