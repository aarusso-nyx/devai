import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { aroundEach, describe, expect, it } from 'vitest';
import { buildRecipeAdapterPlan, installRecipeAdapters } from '../../src/recipes/adapters.js';
import { withAuthorityHostTestScope } from '../unit/authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

describe('v1 RC recipe adapters', () => {
  it('generates thin adapters from identical canonical instruction and policy bytes', () => {
    const plan = buildRecipeAdapterPlan();
    const codex = plan.files.filter((file) => file.host === 'codex');
    const claude = plan.files.filter((file) => file.host === 'claude');

    expect(codex).toHaveLength(28);
    expect(claude).toHaveLength(21);
    for (const name of [
      'devai-assess',
      'devai-plan',
      'devai-fix',
      'devai-docs',
      'devai-scaffold',
      'devai-verify',
      'devai-round',
    ]) {
      const codexSkill = codex.find((file) => file.path.endsWith(`/${name}/SKILL.md`));
      const claudeSkill = claude.find((file) => file.path.endsWith(`/${name}/SKILL.md`));
      const codexManifest = codex.find((file) => file.path.endsWith(`/${name}/devai.recipe.json`));
      const claudeManifest = claude.find((file) =>
        file.path.endsWith(`/${name}/devai.recipe.json`),
      );
      const codexOperations = codex.find((file) =>
        file.path.endsWith(`/${name}/devai.operations.json`),
      );
      const claudeOperations = claude.find((file) =>
        file.path.endsWith(`/${name}/devai.operations.json`),
      );
      expect(codexSkill?.content).toBe(claudeSkill?.content);
      expect(codexManifest?.content).toBe(claudeManifest?.content);
      expect(codexOperations?.content).toBe(claudeOperations?.content);
      const manifest = JSON.parse(codexManifest?.content ?? '{}') as {
        variants?: Record<string, { operations: string[] }>;
      };
      const descriptor = JSON.parse(codexOperations?.content ?? '{}') as {
        operations?: { id: string }[];
      };
      const referenced = [
        ...new Set(Object.values(manifest.variants ?? {}).flatMap((variant) => variant.operations)),
      ].sort();
      expect(descriptor.operations?.map((operation) => operation.id).sort()).toEqual(referenced);
      expect(codexSkill?.content).toContain(
        'read the adjacent `devai.recipe.json` and `devai.operations.json`',
      );
    }
  });

  it('makes the preview recipe explicit-only without duplicating effect policy', () => {
    const metadata = buildRecipeAdapterPlan().files.filter((file) =>
      file.path.endsWith('/agents/openai.yaml'),
    );
    const preview = metadata.find((file) => file.path.includes('/devai-round/'));
    const stable = metadata.filter((file) => !file.path.includes('/devai-round/'));

    expect(preview?.content).toContain('allow_implicit_invocation: false');
    expect(preview?.content).not.toMatch(/effect|write_policy|scope/u);
    expect(stable.every((file) => file.content.includes('allow_implicit_invocation: true'))).toBe(
      true,
    );
  });

  it('installs atomically and is idempotent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devai-recipes-'));
    const first = installRecipeAdapters({ repoRoot: repo });
    const second = installRecipeAdapters({ repoRoot: repo });

    expect(first.written).toHaveLength(49);
    expect(first.unchanged).toHaveLength(0);
    expect(second.written).toHaveLength(0);
    expect(second.unchanged).toHaveLength(49);
    expect(readFileSync(join(repo, '.agents/skills/devai-assess/SKILL.md'), 'utf8')).toBe(
      readFileSync(join(repo, '.claude/skills/devai-assess/SKILL.md'), 'utf8'),
    );
  });

  it('refuses all writes when one generated target has drifted', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devai-recipes-conflict-'));
    const conflict = join(repo, '.agents/skills/devai-assess/SKILL.md');
    mkdirSync(dirname(conflict), { recursive: true });
    writeFileSync(conflict, 'local instructions\n');

    expect(() => installRecipeAdapters({ repoRoot: repo })).toThrow(/RECIPE_ADAPTER_CONFLICT/u);
    expect(readFileSync(conflict, 'utf8')).toBe('local instructions\n');
    expect(() =>
      readFileSync(join(repo, '.claude/skills/devai-assess/SKILL.md'), 'utf8'),
    ).toThrow();
  });

  it('refuses adapter installation through a symlink', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devai-recipes-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'devai-recipes-outside-'));
    symlinkSync(outside, join(repo, '.agents'));

    expect(() => installRecipeAdapters({ repoRoot: repo })).toThrow(
      /RECIPE_INSTALL_SYMLINK_REFUSED/u,
    );
  });

  it('refuses a symlink at an exact adapter file target', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devai-recipes-file-link-'));
    const outside = join(mkdtempSync(join(tmpdir(), 'devai-recipes-file-outside-')), 'SKILL.md');
    writeFileSync(outside, 'outside\n');
    const target = join(repo, '.agents/skills/devai-assess/SKILL.md');
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(outside, target);

    expect(() => installRecipeAdapters({ repoRoot: repo })).toThrow(
      /RECIPE_INSTALL_SYMLINK_REFUSED/u,
    );
    expect(readFileSync(outside, 'utf8')).toBe('outside\n');
  });
});
