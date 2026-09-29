// Record: ADR-GOV-0020 (Inspector Adversarial Acceptance IA-001, IA-002).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { segmentedPlan } from '../../../cli/src/commands/init/plan.js';
import {
  buildBootstrapPlan,
  executeBootstrapPlan,
  type BootstrapPlan,
} from '../../src/bootstrap/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

const VERSION = '1.2.1';
const roots: string[] = [];

aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function target(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-bootstrap-guidance-'));
  roots.push(root);
  return root;
}

function plan(root: string, profile: 'tier2' | 'tier3' = 'tier3'): BootstrapPlan {
  return buildBootstrapPlan({ targetRoot: root, version: VERSION, profile });
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function action(planned: BootstrapPlan, path: string): string | undefined {
  return planned.entries.find((entry) => entry.path === path)?.action;
}

function templateOf(planned: BootstrapPlan, path: string): string {
  const content = planned.entries.find((entry) => entry.path === path)?.content;
  if (content === undefined || content === null) throw new Error(`no template for ${path}`);
  return content;
}

/** Every README.md the bootstrap writes under law/ for the given profile. */
function lawReadmes(planned: BootstrapPlan): string[] {
  return planned.entries
    .map((entry) => entry.path)
    .filter((path) => path.startsWith('law/') && path.endsWith('/README.md'))
    .sort();
}

/** The adopter guidance ADR-GOV-0020 protects under --force. */
function guidancePaths(planned: BootstrapPlan): string[] {
  return ['AGENTS.md', 'CLAUDE.md', ...lawReadmes(planned)]
    .filter((path) => planned.entries.some((entry) => entry.path === path))
    .sort();
}

/**
 * Existing files that are not guidance: the execution overwrites them under --force,
 * so the plan must say replace for each. One sits under law/ without being a README.
 */
const NON_GUIDANCE_EDITS = [
  'docs/dev/operations/README.md',
  'law/policy/mutation-strength.json',
  'product/README.md',
  'record/proofs/README.md',
  'work/audit/README.md',
] as const;

/**
 * An adopter checkout: the bootstrap ran once, then the adopter edited its guidance and
 * several other generated files.
 */
function adopterCheckout(profile: 'tier2' | 'tier3' = 'tier3'): {
  root: string;
  guidance: string[];
  edited: Map<string, string>;
} {
  const root = target();
  executeBootstrapPlan(plan(root, profile));
  const guidance = guidancePaths(plan(root, profile));
  const edited = new Map<string, string>();
  for (const path of guidance) {
    const bytes = `# Adopter-owned ${path}\n\nHand-written guidance that must survive --force.\n`;
    write(root, path, bytes);
    edited.set(path, bytes);
  }
  for (const path of NON_GUIDANCE_EDITS) {
    if (action(plan(root, profile), path) === undefined) continue;
    const bytes = path.endsWith('.json')
      ? `${JSON.stringify({ schemaVersion: '1.0.0', id: 'mutation-strength', status: 'active' })}\n`
      : `# stale ${path}\n`;
    write(root, path, bytes);
    edited.set(path, bytes);
  }
  return { root, guidance, edited };
}

describe('init apply architect --force on an adopter checkout (IA-001)', () => {
  it('leaves edited AGENTS.md, CLAUDE.md, and law READMEs byte-identical and reports them preserved', () => {
    const { root, edited } = adopterCheckout();
    const architect = segmentedPlan(plan(root), 'architect');
    const guidance = guidancePaths(architect);
    expect(guidance).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'CLAUDE.md',
        'law/README.md',
        'law/adr/README.md',
        'law/policy/README.md',
      ]),
    );

    const result = executeBootstrapPlan(architect, { force: true });

    for (const path of guidance) expect(read(root, path)).toBe(edited.get(path));
    expect(result.preserved).toEqual(guidance);
    for (const path of guidance) {
      expect(result.overwritten).not.toContain(path);
      expect(result.created).not.toContain(path);
      expect(result.skipped).not.toContain(path);
    }
  });

  it('still replaces the other existing architect files it overwrites and says so in the plan', () => {
    const { root } = adopterCheckout();
    const architect = segmentedPlan(plan(root), 'architect');
    const replaced = [
      'docs/dev/operations/README.md',
      'law/policy/mutation-strength.json',
      'work/audit/README.md',
    ];
    for (const path of replaced) expect(action(architect, path)).toBe('replace');

    const result = executeBootstrapPlan(architect, { force: true });

    for (const path of replaced) {
      expect(result.overwritten).toContain(path);
      expect(read(root, path)).toBe(templateOf(architect, path));
    }
  });

  it('preserves the law README of the Owner segment the same way', () => {
    const { root, edited } = adopterCheckout();
    const owner = segmentedPlan(plan(root), 'owner');
    const result = executeBootstrapPlan(owner, { force: true });
    expect(read(root, 'law/glossary/README.md')).toBe(edited.get('law/glossary/README.md'));
    expect(result.preserved).toContain('law/glossary/README.md');
    expect(result.overwritten).toEqual(['product/README.md']);
  });
});

describe('bootstrap plan truthfulness about overwrites (IA-002)', () => {
  it('plans skip-exists, never create or replace, for edited guidance the execution keeps', () => {
    const { root, guidance } = adopterCheckout();
    const planned = plan(root);
    for (const path of guidance) expect(action(planned, path)).toBe('skip-exists');
  });

  it('plans replace, never create or skip-exists, for every existing file the execution overwrites', () => {
    const { root } = adopterCheckout();
    const planned = plan(root);
    const result = executeBootstrapPlan(planned, { force: true });

    expect(result.overwritten.length).toBeGreaterThanOrEqual(NON_GUIDANCE_EDITS.length);
    for (const path of result.overwritten) {
      // project.json reconciliation keeps its own always-applied `overwrite` action.
      const expected = path === '.devai/config/project.json' ? 'overwrite' : 'replace';
      expect({ path, action: action(planned, path) }).toEqual({ path, action: expected });
    }
  });

  it('agrees with the execution before the first byte: planned replacements are exactly the overwrites', () => {
    const { root } = adopterCheckout();
    write(root, '.gitignore', 'node_modules/\n');
    const planned = plan(root);
    const planReplaces = planned.entries
      .filter((entry) => ['replace', 'overwrite'].includes(entry.action))
      .map((entry) => entry.path)
      .sort();

    const result = executeBootstrapPlan(planned, { force: true });

    expect(planReplaces).toContain('.gitignore');
    expect(result.overwritten).toEqual(planReplaces);
  });

  it('plans skip-exists for a .gitignore the merge would leave byte-identical', () => {
    const { root } = adopterCheckout();
    write(root, '.gitignore', 'node_modules/\nscratch/\n');
    const planned = plan(root);
    expect(action(planned, '.gitignore')).toBe('skip-exists');
    expect(executeBootstrapPlan(planned, { force: true }).skipped).toContain('.gitignore');
  });

  it('plans replace for an existing AGENTS.md only when the execution would overwrite it', () => {
    const { root } = adopterCheckout();
    const planned = plan(root);
    const result = executeBootstrapPlan(planned, { force: true });
    expect(action(planned, 'AGENTS.md') === 'replace').toBe(
      result.overwritten.includes('AGENTS.md'),
    );
    expect(action(planned, 'AGENTS.md')).not.toBe('create');
  });

  it('writes nothing it planned to replace when --force is absent', () => {
    const { root, edited } = adopterCheckout();
    const planned = plan(root);
    const replacements = planned.entries
      .filter((entry) => action(planned, entry.path) === 'replace')
      .map((entry) => entry.path);
    expect(replacements.length).toBeGreaterThan(0);

    const result = executeBootstrapPlan(planned);

    expect(result.overwritten).toEqual([]);
    for (const path of replacements) expect(result.skipped).toContain(path);
    for (const [path, bytes] of edited) expect(read(root, path)).toBe(bytes);
    for (const path of guidancePaths(planned)) {
      expect(result.skipped).toContain(path);
      expect(result.preserved).not.toContain(path);
    }
  });

  it('keeps every reported roster disjoint', () => {
    const { root } = adopterCheckout();
    const result = executeBootstrapPlan(plan(root), { force: true });
    const all = [...result.created, ...result.overwritten, ...result.skipped, ...result.preserved];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('guidance preservation boundaries', () => {
  it('does not claim to preserve guidance that still equals the template', () => {
    const root = target();
    executeBootstrapPlan(plan(root));
    const planned = plan(root);
    const result = executeBootstrapPlan(planned, { force: true });
    for (const path of guidancePaths(planned)) {
      expect(result.preserved).not.toContain(path);
      expect(read(root, path)).toBe(templateOf(planned, path));
    }
  });

  it.each([true, false])(
    'rechecks guidance an adopter wrote after planning with force=%s',
    (force) => {
      const root = target();
      const planned = plan(root);
      expect(action(planned, 'AGENTS.md')).toBe('create');
      const bytes = '# Adopter guidance written while the plan was under review\n';
      for (const path of ['AGENTS.md', 'CLAUDE.md', 'law/adr/README.md']) write(root, path, bytes);

      const result = executeBootstrapPlan(planned, { force });

      for (const path of ['AGENTS.md', 'CLAUDE.md', 'law/adr/README.md']) {
        expect(read(root, path)).toBe(bytes);
        expect(force ? result.preserved : result.skipped).toContain(path);
        expect(result.created).not.toContain(path);
        expect(result.overwritten).not.toContain(path);
      }
    },
  );

  it('preserves edited law READMEs on a tier2 target that has no agent instructions', () => {
    const { root, guidance, edited } = adopterCheckout('tier2');
    expect(guidance).not.toContain('AGENTS.md');
    expect(guidance).toContain('law/README.md');
    const result = executeBootstrapPlan(plan(root, 'tier2'), { force: true });
    expect(result.preserved).toEqual(guidance);
    for (const path of guidance) expect(read(root, path)).toBe(edited.get(path));
    expect(result.overwritten).toContain('product/README.md');
  });

  it('keeps the provenance rule alongside the guidance rule in one sorted roster', () => {
    const { root, guidance } = adopterCheckout();
    write(root, 'record/proofs/chain.json', '{"head":"retained","records":[{"hash":"retained"}]}');
    const result = executeBootstrapPlan(plan(root), { force: true });
    expect(result.preserved).toEqual([...guidance, 'record/proofs/chain.json'].sort());
  });
});
