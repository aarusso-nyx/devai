import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, expect, it, vi } from 'vitest';
import { runScaffolder } from '../../src/operations/scaffold/runner.js';
import type { StackAdapterPack } from '../../src/pack-resolver/index.js';
import { withAuthorityHostTestScope } from '../unit/authority-host-test-scope.js';

const race = vi.hoisted(() => ({
  target: undefined as string | undefined,
  beforeWrite: undefined as ((write: typeof writeFileSync) => void) | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
      if (args[0] === race.target && race.beforeWrite) {
        const callback = race.beforeWrite;
        race.beforeWrite = undefined;
        callback(original.writeFileSync);
      }
      return original.writeFileSync(...args);
    },
  };
});
const roots: string[] = [];
aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  race.target = undefined;
  race.beforeWrite = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['file', 'symlink'] as const)(
  'preserves a concurrently created %s and reports only completed scaffold writes',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'devai-scaffold-race-'));
    roots.push(root);
    const blueprint = readFileSync(new URL('./fixtures/blueprint.json', import.meta.url));
    writeFileSync(join(root, 'blueprint.json'), blueprint);
    writeFileSync(join(root, 'template.txt'), 'export const generated = true;\n');
    writeFileSync(join(root, 'owner.txt'), 'owner bytes\n');
    mkdirSync(join(root, 'out'));
    const target = join(root, 'out/second.ts');
    race.target = target;
    race.beforeWrite = (write) => {
      if (kind === 'symlink') symlinkSync(join(root, 'owner.txt'), target);
      else write(target, 'concurrent owner bytes\n');
    };
    const result = runScaffolder({
      spec: {
        operationId: 'fixture-scaffold',
        templateIds: ['fixture'],
        deriveTasks: () => [
          { template_id: 'fixture', target_path: 'out/first.ts' },
          { template_id: 'fixture', target_path: 'out/second.ts' },
        ],
      },
      ctx: {
        repoRoot: root,
        inputs: { blueprint_path: 'blueprint.json' },
        allowedPaths: ['out/first.ts', 'out/second.ts'],
        canonicalPack: {
          id: 'fixture-pack',
          _packDir: root,
          templates: {
            fixture: { path: 'template.txt', consumed_by: 'fixture-scaffold' },
          },
        } as unknown as StackAdapterPack,
      },
    });
    expect(race.beforeWrite).toBeUndefined();
    expect(readFileSync(join(root, 'owner.txt'), 'utf8')).toBe('owner bytes\n');
    expect(readFileSync(join(root, 'out/second.ts'), 'utf8')).toBe(
      kind === 'symlink' ? 'owner bytes\n' : 'concurrent owner bytes\n',
    );
    expect(result.status).toBe('fail');
    expect(result.evidence).toMatchObject({ files_created: ['out/first.ts'], files_modified: [] });
    expect(readFileSync(join(root, 'out/first.ts'), 'utf8')).toContain(
      'export const generated = true;',
    );
    expect(readFileSync(join(root, 'blueprint.json'))).toEqual(blueprint);
  },
);
