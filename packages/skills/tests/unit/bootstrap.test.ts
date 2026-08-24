import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildBootstrapPlan,
  executeBootstrapPlan,
  validateCanonicalPolicyContent,
} from '../../src/bootstrap/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

describe('executeBootstrapPlan --force preserves provenance', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devai-bootstrap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites empty chain + counters when --force is set (fresh init)', () => {
    const plan = buildBootstrapPlan({ targetRoot: dir });
    executeBootstrapPlan(plan, { force: false }); // first init lays the files
    // second init --force with the same plan should overwrite (they're empty).
    const replan = buildBootstrapPlan({ targetRoot: dir });
    const result = executeBootstrapPlan(replan, { force: true });
    expect(result.preserved).toEqual([]);
    expect(result.overwritten).toContain('record/proofs/chain.json');
  });

  it('preserves a populated evidence chain even with --force', () => {
    const plan = buildBootstrapPlan({ targetRoot: dir });
    executeBootstrapPlan(plan, { force: false });
    // Populate the chain: simulate a real record landing.
    const chainPath = join(dir, 'record/proofs/chain.json');
    writeFileSync(
      chainPath,
      JSON.stringify(
        {
          head: 'abc123',
          records: [
            {
              id: 'EV-0000000000000001',
              previous_hash: 'GENESIS',
              hash: 'abc123',
              timestamp: '2026-05-12T00:00:00Z',
              kind: 'audit',
            },
          ],
        },
        null,
        2,
      ),
    );

    const replan = buildBootstrapPlan({ targetRoot: dir });
    const result = executeBootstrapPlan(replan, { force: true });

    // The chain must NOT be touched.
    expect(result.preserved).toContain('record/proofs/chain.json');
    expect(result.overwritten).not.toContain('record/proofs/chain.json');
    const after = JSON.parse(readFileSync(chainPath, 'utf8')) as { records: unknown[] };
    expect(after.records).toHaveLength(1);
  });

  it('preserves populated counters even with --force', () => {
    const plan = buildBootstrapPlan({ targetRoot: dir });
    executeBootstrapPlan(plan, { force: false });
    // Bump TASK counter to simulate active task allocation.
    const countersPath = join(dir, '.devai/state/counters.json');
    writeFileSync(countersPath, JSON.stringify({ TASK: 42, RGR: 0, CTG: 0, ESC: 0 }, null, 2));

    const replan = buildBootstrapPlan({ targetRoot: dir });
    const result = executeBootstrapPlan(replan, { force: true });

    expect(result.preserved).toContain('.devai/state/counters.json');
    const after = JSON.parse(readFileSync(countersPath, 'utf8')) as { TASK: number };
    expect(after.TASK).toBe(42);
  });

  it('does NOT preserve unrelated existing files when --force', () => {
    // README.md or docs/*/README.md are not provenance-critical and
    // should still be overwritten by --force.
    mkdirSync(join(dir, 'product'), { recursive: true });
    writeFileSync(join(dir, 'product/README.md'), 'old content');

    const plan = buildBootstrapPlan({ targetRoot: dir });
    const result = executeBootstrapPlan(plan, { force: true });

    expect(result.overwritten).toContain('product/README.md');
    expect(result.preserved).not.toContain('product/README.md');
  });

  it('does not seed canonical policy from untrusted target policy bytes', () => {
    mkdirSync(join(dir, 'law/policy'), { recursive: true });
    writeFileSync(
      join(dir, 'law/policy/thresholds.json'),
      '{"schemaVersion":"1.0.0","freshness":{"scorecard_failure_max_age_hours":0.0001}}\n',
    );

    const plan = buildBootstrapPlan({ targetRoot: dir });
    const thresholds = plan.entries.find((entry) => entry.path === '.devai/config/thresholds.json');
    expect(thresholds?.content).not.toContain('0.0001');
  });

  it('schema-validates every canonical policy shape before materialization', () => {
    expect(() =>
      validateCanonicalPolicyContent(
        'thresholds.json',
        '{"schemaVersion":"1.0.0","coverage":{"lines":"green"}}',
      ),
    ).toThrow(/thresholds\.json.*schema/i);
    expect(() =>
      validateCanonicalPolicyContent(
        'forbidden-actions.json',
        '{"schemaVersion":"1.0.0","actions":"disabled"}',
      ),
    ).toThrow(/forbidden-actions\.json.*schema/i);
  });

  it('seeds adopter-safe empty guards and scorecard N/A declarations', () => {
    const plan = buildBootstrapPlan({ targetRoot: dir });
    const globGuards = plan.entries.find(
      (entry) => entry.path === '.devai/config/glob-guards.json',
    );
    const scorecardNa = plan.entries.find(
      (entry) => entry.path === '.devai/config/scorecard-na.json',
    );
    expect(JSON.parse(globGuards?.content ?? '{}')).toEqual({
      schemaVersion: '1.0.0',
      guards: [],
    });
    expect(JSON.parse(scorecardNa?.content ?? '{}')).toEqual({
      schemaVersion: '1.0.0',
      cells: [],
    });
  });
});

describe('buildBootstrapPlan: adopter constitution binding', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devai-bootstrap-const-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('vendors the canonical constitution even when the target has law/constitution.md', () => {
    mkdirSync(join(dir, 'law'), { recursive: true });
    writeFileSync(join(dir, 'law/constitution.md'), '# Target-local constitution\n');
    const plan = buildBootstrapPlan({ targetRoot: dir });
    const pointer = plan.entries.find((entry) => entry.path === '.devai/constitution.md');
    const vendored = plan.entries.find((entry) => entry.path === '.devai/pin/constitution.md');
    const project = plan.entries.find((entry) => entry.path === '.devai/config/project.json');

    expect(pointer?.content).toMatch(/^# See pin\/constitution\.md$/m);
    expect(vendored?.content).toContain('# DEVAI Constitution');
    expect(vendored?.content).not.toContain('Target-local constitution');
    expect(project?.content).toContain('"constitution"');
  });

  it('plans the canonical regular-file pointer for an empty target', () => {
    const plan = buildBootstrapPlan({ targetRoot: dir });
    const entry = plan.entries.find((e) => e.path === '.devai/constitution.md');
    expect(entry).toBeDefined();
    expect(entry?.content).toMatch(/^# See pin\/constitution\.md$/m);
    expect(entry?.content).toContain('devai init bind --constitution --write');
    expect(entry?.content).not.toContain('<unresolved>');
  });

  it('records the strict tier3 default when no profile is supplied', () => {
    const plan = buildBootstrapPlan({ targetRoot: dir, version: '1.0.0' });
    const project = plan.entries.find((entry) => entry.path === '.devai/config/project.json');
    expect(JSON.parse(project?.content ?? '{}')).toMatchObject({
      schemaVersion: '1.0.0',
      project_type: 'runtime-host',
      authority_enforcement: { mode: 'cli-only' },
      profile: 'tier3',
      devai_version: '1.0.0',
    });
  });

  it('scaffolds the complete tier3 doctor substrate', () => {
    const plan = buildBootstrapPlan({ targetRoot: dir, version: '1.0.0', profile: 'tier3' });
    const paths = new Set(plan.entries.map((entry) => entry.path));
    for (const path of [
      'product/README.md',
      'law/invariants/README.md',
      'law/schemas/README.md',
      'law/adr/README.md',
      'law/glossary/README.md',
      'docs/dev/operations/README.md',
      'docs/dev/security/README.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]) {
      expect(paths).toContain(path);
    }
  });

  it('reconciles a later explicit profile while preserving adopter declarations', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    const projectPath = join(dir, '.devai/config/project.json');
    writeFileSync(
      projectPath,
      `${JSON.stringify({
        devai_version: '1.0.0',
        constitution: { version: '1.0.0', sha256: 'a'.repeat(64) },
        name: 'adopter-owned-name',
        profile: 'tier3',
      })}\n`,
    );

    const plan = buildBootstrapPlan({ targetRoot: dir, version: '1.0.0', profile: 'tier1' });
    const project = plan.entries.find((entry) => entry.path === '.devai/config/project.json');
    expect(project?.action).toBe('overwrite');
    expect(plan.summary.overwrite).toBe(1);

    const result = executeBootstrapPlan(plan);
    expect(result.overwritten).toContain('.devai/config/project.json');
    expect(JSON.parse(readFileSync(projectPath, 'utf8'))).toMatchObject({
      schemaVersion: '1.0.0',
      project_type: 'runtime-host',
      authority_enforcement: { mode: 'cli-only' },
      profile: 'tier1',
      devai_version: '1.0.0',
      name: 'adopter-owned-name',
    });
  });

  it('keeps an existing explicit profile when a later invocation omits --tier', () => {
    const first = buildBootstrapPlan({ targetRoot: dir, version: '1.0.0', profile: 'tier1' });
    executeBootstrapPlan(first);

    const second = buildBootstrapPlan({ targetRoot: dir, version: '1.0.0' });
    const project = second.entries.find((entry) => entry.path === '.devai/config/project.json');
    expect(project?.action).toBe('skip-exists');
    expect(JSON.parse(readFileSync(join(dir, '.devai/config/project.json'), 'utf8')).profile).toBe(
      'tier1',
    );
  });
});

describe('executeBootstrapPlan: writes the adopter constitution binding', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devai-bootstrap-const-exec-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a target constitution separate and writes a regular pointer', () => {
    mkdirSync(join(dir, 'law'), { recursive: true });
    const targetConstitution = join(dir, 'law/constitution.md');
    writeFileSync(targetConstitution, '# Target-local constitution\n');
    const plan = buildBootstrapPlan({ targetRoot: dir });
    const result = executeBootstrapPlan(plan, { force: false });
    expect(result.created).toContain('.devai/constitution.md');
    expect(result.created).toContain('.devai/pin/constitution.md');
    const pointerPath = join(dir, '.devai/constitution.md');
    expect(lstatSync(pointerPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(pointerPath, 'utf8')).toMatch(/^# See pin\/constitution\.md$/m);
    expect(readFileSync(targetConstitution, 'utf8')).toBe('# Target-local constitution\n');
  });

  it('creates a plain-file pointer when the target starts empty', () => {
    const plan = buildBootstrapPlan({ targetRoot: dir });
    const result = executeBootstrapPlan(plan, { force: false });
    expect(result.created).toContain('.devai/constitution.md');
    const pointerPath = join(dir, '.devai/constitution.md');
    const stat = lstatSync(pointerPath);
    expect(stat.isSymbolicLink()).toBe(false);
    const body = readFileSync(pointerPath, 'utf8');
    expect(body).toMatch(/^# See pin\/constitution\.md$/m);
  });
});
// Invariants: INV-DEVAI-009
