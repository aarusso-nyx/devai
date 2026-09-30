import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import {
  type AdopterPolicyTarget,
  resolveAdopterPolicyProjection,
} from '../../src/services/adopter-policy.js';

// ADR-AUT-0003 (source grammar, IA-003, IA-007) and ADR-GOV-0024 (IA-002): the adopter
// policy admits one optional closed authority block; a malformed block is refused before
// any target is staged, and a block-free source projects exactly as it did before.
const ROOT = resolve(import.meta.dirname, '../../../..');

const REFERENCE_AUTHORITY = {
  extension_id: 'detran.path-authority',
  roots: ['apps', 'backend', 'frontend', 'mobile', 'portal', 'src'],
  classes: {
    test: { selectors: ['**/*.spec.*', '**/*.test.*', '**/test/**', '**/tests/**'] },
    architecture: { selectors: ['**/ddl/**/*.sql', '**/blueprints/**'] },
  },
} as const;

const basePolicy = {
  schemaVersion: '1.0.0',
  policy_id: 'detran.devai-adoption',
  policy_version: '1.1.0',
  project: { project_type: 'runtime-host' },
} as const;

const currentProject = { schemaVersion: '1.0.0', project_type: 'runtime-host' } as const;

function withAuthority(authority: unknown) {
  return { ...basePolicy, authority };
}

function validate(document: unknown): { ok: boolean; errors: unknown } {
  const validator = getValidator('adopter-policy.schema.json');
  const ok = validator(document) === true;
  return { ok, errors: validator.errors };
}

/**
 * Calls the projection with the bound constitution version. The input is built as a
 * variable so the optional constitutionVersion field TASK-0513 adds type-checks both
 * before and after that field exists.
 */
function project(policy: unknown, constitutionVersion = '1.0.2') {
  const input = { policy, currentProject, frameworkVersion: '1.7.0', constitutionVersion };
  return resolveAdopterPolicyProjection(input);
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('adopter policy authority block: schema', () => {
  it('admits the reference block of ADR-AUT-0003', () => {
    const result = validate(withAuthority(REFERENCE_AUTHORITY));
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  });

  it('admits a block with roots only, so the test class takes the package defaults', () => {
    expect(validate(withAuthority({ roots: ['apps'] })).ok).toBe(true);
  });

  it('admits a policy with no authority block', () => {
    expect(validate(basePolicy).ok).toBe(true);
  });

  it.each([
    ['an unknown block key', { ...REFERENCE_AUTHORITY, precedence: 900 }],
    ['an unknown class', { roots: ['apps'], classes: { docs: { selectors: ['**/*.md'] } } }],
    [
      'an unknown key inside a class',
      { roots: ['apps'], classes: { test: { selectors: ['**/*.spec.*'], role: 'engineer' } } },
    ],
    ['a missing roots list', { classes: REFERENCE_AUTHORITY.classes }],
    ['an empty roots list', { roots: [] }],
    ['a root with a separator', { roots: ['apps/web'] }],
    ['a dot-segment root', { roots: ['..'] }],
    ['a root with a glob metacharacter', { roots: ['app*'] }],
    ['two equal roots', { roots: ['apps', 'apps'] }],
    [
      'an architecture class without a selectors list',
      { roots: ['apps'], classes: { architecture: {} } },
    ],
    ['an empty selector', { roots: ['apps'], classes: { architecture: { selectors: [''] } } }],
    ['a reserved-shape extension id', { roots: ['apps'], extension_id: 'Detran path' }],
  ])('refuses %s', (_label, authority) => {
    expect(validate(withAuthority(authority)).ok).toBe(false);
  });
});

describe('adopter policy authority block: projection', () => {
  it('refuses a schema-malformed block with ADOPTER_POLICY_INVALID and returns no target', () => {
    let files: ReadonlyMap<AdopterPolicyTarget, string> | undefined;
    expect(() => {
      files = project(withAuthority({ roots: ['apps/web'] })).files;
    }).toThrow(/^ADOPTER_POLICY_INVALID:/u);
    expect(files).toBeUndefined();
  });

  it.each([
    ['a core-table root', { roots: ['law'] }, 'ADOPTER_AUTHORITY_ROOT_CORE_PREFIX'],
    ['a root that prefixes another', { roots: ['app', 'apps'] }, 'ADOPTER_AUTHORITY_ROOT_NESTED'],
    [
      'a selector that starts with a root segment',
      { roots: ['apps'], classes: { architecture: { selectors: ['apps/**/ddl/**'] } } },
      'ADOPTER_AUTHORITY_SELECTOR_ROOTED',
    ],
    [
      'a brace selector',
      { roots: ['apps'], classes: { test: { selectors: ['**/*.{spec,test}.ts'] } } },
      'ADOPTER_AUTHORITY_SELECTOR_INVALID',
    ],
    [
      'an architecture class with no selectors',
      { roots: ['apps'], classes: { architecture: { selectors: [] } } },
      'ADOPTER_AUTHORITY_ARCHITECTURE_SELECTORS_REQUIRED',
    ],
    [
      'the package extension id',
      { roots: ['apps'], extension_id: 'devai-adopter-authority' },
      'ADOPTER_AUTHORITY_EXTENSION_ID_RESERVED',
    ],
  ])('refuses %s with its named code before any target is staged', (_label, authority, code) => {
    // The schema admits each of these; only the compiler can refuse them.
    expect(validate(withAuthority(authority)).ok).toBe(true);
    let files: ReadonlyMap<AdopterPolicyTarget, string> | undefined;
    expect(() => {
      files = project(withAuthority(authority)).files;
    }).toThrow(new RegExp(`^${code}(?::|$)`, 'u'));
    expect(files).toBeUndefined();
  });

  it('refuses a valid block while the bound constitution is below 1.0.2', () => {
    for (const version of ['1.0.1', '1.0.0']) {
      expect(() => project(withAuthority(REFERENCE_AUTHORITY), version)).toThrow(
        /^ADOPTER_AUTHORITY_CONSTITUTION_VERSION(?::|$)/u,
      );
    }
  });

  it('admits the reference block once the bound constitution is 1.0.2', () => {
    const withBlock = project(withAuthority(REFERENCE_AUTHORITY));
    const without = project(basePolicy);
    expect([...withBlock.files.keys()]).toEqual([...without.files.keys()]);
  });

  it('projects a block-free source byte-identically to the bound framework receipt', () => {
    const receipt = JSON.parse(
      readFileSync(resolve(ROOT, '.devai/config/adopter-policy-binding.json'), 'utf8'),
    ) as { source_path: string; materialized: Record<string, string> };
    const policy = JSON.parse(readFileSync(resolve(ROOT, receipt.source_path), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(policy).not.toHaveProperty('authority');
    const current = JSON.parse(
      readFileSync(resolve(ROOT, '.devai/config/project.json'), 'utf8'),
    ) as { devai_version: string };
    const { files } = resolveAdopterPolicyProjection({
      policy,
      currentProject: current,
      frameworkVersion: current.devai_version,
    });
    const digests = Object.fromEntries([...files].map(([path, bytes]) => [path, sha256(bytes)]));
    expect(digests).toEqual(receipt.materialized);
    for (const [path, bytes] of files) {
      expect(bytes, path).toBe(readFileSync(resolve(ROOT, path), 'utf8'));
    }
  });
});
