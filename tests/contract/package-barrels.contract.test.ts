// Invariants: INV-CORE-011
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BARRELS = [
  'packages/cli/src/index.ts',
  'packages/cli/src/runtime-core.ts',
  'packages/loop/src/index.ts',
  'packages/skills/src/index.ts',
  'packages/spec/src/index.ts',
  'packages/utils/src/index.ts',
] as const;

const PACKAGES_WITH_ROOT_EXPORT = ['loop', 'skills', 'spec', 'utils'] as const;

function statements(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('package barrels', () => {
  it.each(BARRELS)('%s only re-exports', (barrel) => {
    for (const line of statements(readFileSync(barrel, 'utf8'))) {
      expect(line).toMatch(/^export \* from '[^']+';$/);
    }
  });

  it.each(BARRELS)('%s relative re-exports resolve to existing modules', (barrel) => {
    const source = readFileSync(barrel, 'utf8');
    for (const match of source.matchAll(/^export \* from '(\.[^']+)\.js';$/gm)) {
      const target = join(dirname(barrel), match[1] ?? '');
      expect(existsSync(`${target}.ts`) || existsSync(join(target, 'index.ts'))).toBe(true);
    }
  });

  it.each(PACKAGES_WITH_ROOT_EXPORT)(
    '@devai-nyx/%s exposes its source index as the development entry',
    (name) => {
      const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8')) as {
        exports: Record<string, { development?: string }>;
      };
      expect(manifest.exports['.']?.development).toBe('./src/index.ts');
    },
  );
});
