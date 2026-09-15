import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { aroundEach, describe, expect, it } from 'vitest';
import {
  buildRecipeAdapterPlan,
  installRecipeAdapters,
  preflightRecipeAdapterInstall,
  type RecipeHost,
} from '../../src/recipes/adapters.js';
import { loadRecipes } from '../../src/recipes/loader.js';
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

describe('recipe adapter selection and installation boundaries', () => {
  it.each([
    ['codex', 'codex'],
    ['claude', 'claude'],
    ['codex', 'unsupported'],
  ])('rejects ambiguous or unsupported host selection %j', (...hosts) => {
    expect(() => buildRecipeAdapterPlan(undefined, hosts as RecipeHost[])).toThrow(
      'INVALID_RECIPE_HOSTS',
    );
  });

  it('keeps each host under its own adapter root and emits parseable canonical metadata', () => {
    const plan = buildRecipeAdapterPlan();
    for (const file of plan.files) {
      expect(
        file.path.startsWith(file.host === 'codex' ? '.agents/skills/' : '.claude/skills/'),
      ).toBe(true);
      if (!file.path.endsWith('/agents/openai.yaml')) continue;
      const base = file.path.slice(0, -'/agents/openai.yaml'.length);
      const manifest = JSON.parse(
        plan.files.find((entry) => entry.path === `${base}/devai.recipe.json`)?.content ?? '{}',
      ) as { name: string; description: string; status: string };
      expect(() => parseYaml(file.content)).not.toThrow();
      expect(parseYaml(file.content)).toEqual({
        interface: { display_name: manifest.name, short_description: manifest.description },
        policy: { allow_implicit_invocation: manifest.status === 'stable' },
      });
      const operations = JSON.parse(
        plan.files.find((entry) => entry.path === `${base}/devai.operations.json`)?.content ?? '{}',
      ) as { schemaVersion: string; recipe: string };
      expect(operations.schemaVersion).toBe('1');
      expect(operations.recipe).toBe(manifest.name);
    }
  });

  it.each(['../outside.txt', '../repo-sibling/file.txt'])(
    'refuses an escaping planned target %s before writing',
    (path) => {
      const repo = mkdtempSync(join(tmpdir(), 'devai-adapter-boundary-'));
      expect(() =>
        preflightRecipeAdapterInstall(repo, {
          files: [{ host: 'codex', path, content: 'never written' }],
        }),
      ).toThrow(`RECIPE_INSTALL_ESCAPE: ${path}`);
    },
  );

  it('reports every conflicting path while preserving the existing bytes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'devai-adapter-conflicts-'));
    const files = ['one.txt', 'two.txt'].map((path) => ({
      host: 'codex' as const,
      path,
      content: 'generated',
    }));
    for (const file of files) writeFileSync(join(repo, file.path), `original ${file.path}`);
    expect(() => preflightRecipeAdapterInstall(repo, { files })).toThrow(
      'RECIPE_ADAPTER_CONFLICT: one.txt, two.txt',
    );
    for (const file of files)
      expect(readFileSync(join(repo, file.path), 'utf8')).toBe(`original ${file.path}`);
  });
});

it.each([
  String.raw`Inspect C:\workspace\repo and "quoted" policy`,
  'Verificar ação: "próxima etapa"',
])('preserves description bytes through generated YAML: %s', (description) => {
  const canonical = loadRecipes()[0];
  if (canonical === undefined) throw new Error('canonical recipe population missing');
  const root = mkdtempSync(join(tmpdir(), 'devai adapter metadata ç '));
  try {
    cpSync(dirname(canonical.resource_dir), root, { recursive: true });
    const manifestPath = join(root, canonical.manifest.name, 'devai.recipe.json');
    const markdownPath = join(root, canonical.manifest.name, 'SKILL.md');
    const manifest = { ...canonical.manifest, description };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(
      markdownPath,
      canonical.skill_markdown.replace(
        `description: ${canonical.manifest.description}`,
        `description: ${description}`,
      ),
    );
    const manifestBytes = readFileSync(manifestPath);
    const markdownBytes = readFileSync(markdownPath);
    const plan = buildRecipeAdapterPlan(root, ['codex']);
    const metadata = plan.files.find(
      (file) => file.path === `.agents/skills/${canonical.manifest.name}/agents/openai.yaml`,
    );
    expect(metadata).toBeDefined();
    expect(() => parseYaml(metadata?.content ?? '')).not.toThrow();
    expect(parseYaml(metadata?.content ?? '')).toEqual({
      interface: { display_name: canonical.manifest.name, short_description: description },
      policy: { allow_implicit_invocation: canonical.manifest.status === 'stable' },
    });
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
    expect(readFileSync(markdownPath)).toEqual(markdownBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
