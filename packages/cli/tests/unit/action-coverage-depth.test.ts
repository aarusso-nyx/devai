import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDomains } from '../../../spec/src/spec/domains-loader.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import { resolveCheckPlan, runCheckPlan } from '../../src/commands/check/contracts.js';
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
      registeredCount: 67,
      inScopeCount: 67,
      claimedCount: 0,
      orphanClaims: [],
    });
    expect(result.unclaimed).toHaveLength(67);
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

const RECEIPT = '.devai/config/adopter-policy-binding.json';

/** A repository whose kind is bound only by its adopter-policy receipt (ADR-CHK-0005). */
function boundFixture(policyId: string): ReturnType<typeof fixture> {
  const value = fixture();
  mkdirSync(join(value.root, '.devai/config'), { recursive: true });
  writeFileSync(
    join(value.root, '.devai/config/domains.json'),
    readFileSync(join(repositoryRoot, '.devai/config/domains.json')),
  );
  writeFileSync(
    join(value.root, RECEIPT),
    `${JSON.stringify({ schemaVersion: '1.0.0', policy_id: policyId, policy_version: '1.0.0' })}\n`,
  );
  return value;
}

async function dispatchCoverage(root: string) {
  const plan = resolveCheckPlan(root, { only: 'action-coverage' });
  const report = await runCheckPlan(plan, (member) =>
    executeCheckMember(member, { repoRoot: root }),
  );
  const [result] = report.results;
  if (result === undefined) throw new Error('action-coverage returned no result');
  return { report, result };
}

describe('action coverage through check evaluates the detected repository kind', () => {
  it('evaluates the adopter scope from the receipt even beside framework markers', async () => {
    const value = boundFixture('acme.devai-adoption');
    mkdirSync(join(value.root, 'packages/cli/src'), { recursive: true });
    writeFileSync(join(value.root, 'packages/cli/src/bin.ts'), 'export {};\n');
    mkdirSync(join(value.root, 'examples/redox-pack-fixture'), { recursive: true });
    mkdirSync(join(value.root, 'scripts'), { recursive: true });
    writeFileSync(join(value.root, 'scripts/check.sh'), 'pnpm exec devai sense inventory\n');

    const { result } = await dispatchCoverage(value.root);

    expect(result.status).toBe('fail');
    expect(result.value).toMatchObject({
      ok: false,
      scope: 'adopter',
      unclaimed: ['sense inventory'],
      inScopeCount: 1,
    });
  });

  it('evaluates the self scope from the framework receipt without framework markers', async () => {
    const value = boundFixture('devai.devai-adoption');

    const { result } = await dispatchCoverage(value.root);

    expect(result.status).toBe('fail');
    expect(result.value).toMatchObject({ ok: false, scope: 'self', inScopeCount: 67 });
  });

  it('passes an adopter whose referenced action is claimed by an invariant', async () => {
    const value = boundFixture('acme.devai-adoption');
    const invariant = JSON.parse(
      readFileSync(join(repositoryRoot, 'law/invariants/INV-CORE-002.json'), 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      join(value.invariants, 'INV-CORE-002.json'),
      `${JSON.stringify({ ...invariant, measurable_via: ['sense inventory'] }, null, 2)}\n`,
    );
    mkdirSync(join(value.root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(value.root, '.github/workflows/check.yml'),
      'steps:\n  - run: pnpm exec devai sense inventory\n',
    );

    expect(run(value, { scope: 'adopter' })).toMatchObject({
      ok: true,
      unclaimed: [],
      claimedCount: 1,
      inScopeCount: 1,
    });
    const { report, result } = await dispatchCoverage(value.root);

    expect(result.status).toBe('pass');
    expect(result.value).toMatchObject({
      ok: true,
      scope: 'adopter',
      unclaimed: [],
      claimedCount: 1,
    });
    expect(report.ok).toBe(true);
  });

  it('reports an adopter with no action in scope as an explicit empty population', async () => {
    const value = boundFixture('acme.devai-adoption');

    const { report, result } = await dispatchCoverage(value.root);

    expect(result).toMatchObject({
      id: 'action-coverage',
      status: 'review',
      code: 'CHECK_MEMBER_POPULATION_EMPTY',
    });
    expect(result.value).toMatchObject({
      member: 'action-coverage',
      applicability: 'both',
      repository_kind: 'adopter',
      kind_evidence: { source: RECEIPT, pointer: '/policy_id', value: 'acme.devai-adoption' },
      input_source: 'repository',
      scope: 'adopter',
      population: 0,
    });
    expect(report).toMatchObject({ ok: false, readiness_status: 'review', exit_code: 1 });
  });
});
