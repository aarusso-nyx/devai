import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDomains } from '../../../spec/src/spec/domains-loader.js';
import { runActionCoverageCheck } from '../../src/commands/spec/validate-action-coverage.js';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const domains = loadDomains(join(repositoryRoot, '.devai/config/domains.json'));
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { readonly root: string; readonly invariants: string } {
  const root = mkdtempSync(join(tmpdir(), 'devai-action-coverage-'));
  roots.push(root);
  const invariants = join(root, 'law/invariants');
  mkdirSync(invariants, { recursive: true });
  return { root, invariants };
}

function run(
  value: ReturnType<typeof fixture>,
  options: Readonly<{ scope?: string; coverageAuthorities?: string }> = {},
) {
  return runActionCoverageCheck({
    repoRoot: value.root,
    invariantsDir: value.invariants,
    domains,
    ...options,
  });
}

describe('action coverage scope and discovery boundaries', () => {
  it('requires the complete registered catalog for an explicitly self-scoped repository', () => {
    const value = fixture();
    const result = run(value, { scope: 'self' });

    expect(result).toMatchObject({
      ok: false,
      scope: 'self',
      registeredCount: 57,
      inScopeCount: 57,
      claimedCount: 0,
      orphanClaims: [],
    });
    expect(result.unclaimed).toHaveLength(57);
    expect(result.unclaimed).toContain('release publish');
    expect(result.unclaimed).toContain('sense inventory');
    expect(result).not.toHaveProperty('adopterFacingAuthorities');
  });

  it('auto-detects self posture only when both source and Redox example markers exist', () => {
    const value = fixture();
    mkdirSync(join(value.root, 'packages/cli/src'), { recursive: true });
    writeFileSync(join(value.root, 'packages/cli/src/bin.ts'), 'export {};\n');
    expect(run(value).scope).toBe('adopter');

    mkdirSync(join(value.root, 'examples/unrelated'), { recursive: true });
    mkdirSync(join(value.root, 'examples/redox-pack-fixture'), { recursive: true });
    expect(run(value).scope).toBe('self');
  });

  it('discovers only default adopter-facing actions in workflow and script content', () => {
    const value = fixture();
    mkdirSync(join(value.root, '.github/workflows'), { recursive: true });
    mkdirSync(join(value.root, 'scripts/nested'), { recursive: true });
    mkdirSync(join(value.root, 'scripts/node_modules/ignored'), { recursive: true });
    writeFileSync(
      join(value.root, '.github/workflows/check.yaml'),
      'steps:\n  - run: devai sense-inventory\n  - run: devai release publish\n',
    );
    writeFileSync(
      join(value.root, 'scripts/nested/check.mjs'),
      "const action = 'sense inventory';\n",
    );
    writeFileSync(
      join(value.root, 'scripts/node_modules/ignored/release.mjs'),
      "const action = 'release publish';\n",
    );

    const result = run(value, { scope: 'adopter' });

    expect(result).toMatchObject({
      ok: false,
      scope: 'adopter',
      inScopeCount: 1,
      claimedCount: 0,
      adopterFacingAuthorities: ['sensor', 'specifier'],
      unclaimed: ['sense inventory'],
    });
  });

  it('honors an explicit release-controller authority without widening to sensors', () => {
    const value = fixture();
    mkdirSync(join(value.root, 'scripts'), { recursive: true });
    writeFileSync(
      join(value.root, 'scripts/release.sh'),
      'devai sense inventory\ndevai release-publish\n',
    );

    const result = run(value, {
      scope: 'adopter',
      coverageAuthorities: ' release_controller ',
    });

    expect(result.adopterFacingAuthorities).toEqual(['release_controller']);
    expect(result.unclaimed).toEqual(['release publish']);
    expect(result.inScopeCount).toBe(1);
  });

  it('reports unknown authorities and falls back to the default set', () => {
    const value = fixture();
    mkdirSync(join(value.root, 'scripts'), { recursive: true });
    writeFileSync(join(value.root, 'scripts/check.cjs'), "'sense record';\n");
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = run(value, {
      scope: 'adopter',
      coverageAuthorities: 'caller_invented',
    });

    expect(write).toHaveBeenCalledWith(
      "check action-coverage: ignoring unknown authority 'caller_invented' in --coverage-authorities\n",
    );
    expect(result.adopterFacingAuthorities).toEqual(['sensor', 'specifier']);
    expect(result.unclaimed).toEqual(['sense record']);
  });
});
