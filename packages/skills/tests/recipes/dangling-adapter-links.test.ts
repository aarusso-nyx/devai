import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preflightRecipeAdapterInstall } from '../../src/recipes/adapters.js';

let fixture: string;
let repo: string;
const path = '.agents/skills/devai-assess/SKILL.md';
const plan = { files: [{ host: 'codex' as const, path, content: 'canonical instructions\n' }] };

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'devai-recipe-dangling-'));
  repo = join(fixture, 'repository');
  mkdirSync(repo);
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe('recipe installation rejects dangling links during preflight', () => {
  it('refuses a dangling symlink at the generated file target', () => {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(fixture, 'absent-outside-file'), target);
    expect(() => preflightRecipeAdapterInstall(repo, plan)).toThrow(
      /RECIPE_INSTALL_SYMLINK_REFUSED/u,
    );
  });

  it('refuses a dangling directory symlink in the generated path ancestry', () => {
    symlinkSync(join(fixture, 'absent-outside-directory'), join(repo, '.agents'));
    expect(() => preflightRecipeAdapterInstall(repo, plan)).toThrow(
      /RECIPE_INSTALL_SYMLINK_REFUSED/u,
    );
  });

  it('still permits genuinely absent directories and files for an ordinary install', () => {
    expect(preflightRecipeAdapterInstall(repo, plan)).toEqual([
      { ...plan.files[0], absolutePath: join(repo, path) },
    ]);
  });
});
