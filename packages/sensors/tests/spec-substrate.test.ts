// ADR-SCR-0004 IA-004 and IA-005 (sensor half): on a fixture mirroring DEVAI, the five
// spec sensors read the specification records merged by TASK-0231 and report pass; each
// one stops passing when the record it reads is removed; and removing one invariant
// record turns spec_depth from pass to fail on the same head.
//
// The fixture is built by COPYING the merged records out of this repository, never from
// hand-written stand-ins (TASK-0232 step 2): law/invariants, law/security, law/targets,
// law/trace.json, law/adr, law/policy/sensor-registry.json, the committed
// .devai/config/sensor-inputs.json, the source trees the invariants' scope.code_areas
// claim (packages/*/src, scripts), and every test file law/trace.json names. Deleting a
// record from the repository therefore changes what these tests see.
//
// Interface assumptions the engineer (TASK-0233) must meet in packages/sensors/src:
//   - senseSpecDepth({ repoRoot, adrDir: 'law/adr', invariantsDir: 'law/invariants' })
//     (the inputs .devai/config/sensor-inputs.json declares) reads pass on the fixture,
//     and reads FAIL when an invariant id referenced by law/trace.json, law/targets/*.json,
//     or law/security/*.json has no record under law/invariants (a dangling reference is
//     a removed setpoint, IA-005). The reading names the missing id in a finding.
//   - senseSpecAlignment({ repoRoot }) reads pass: every scope.code_areas glob resolves
//     and the reverse claim over packages/*/src meets its threshold.
//   - senseSpecSecurityCoverage({ repoRoot, surfaces? }) reads the structured records
//     law/security/threat-model.json and law/security/data-handling.json, not markdown
//     under docs/meta/security and not SQL migrations. A data-handling declaration with
//     personal_data.stored false satisfies the PII signal without a pii_map table. When
//     surfaces.rbac is declared false, the RBAC-invariant signal is not demanded. The
//     declaration reaches the sensor EITHER as the `surfaces` option the sense adapters
//     deliver (passed here through the widened local type `Surfaced<T>`, since no
//     options type declares it today) OR by reading
//     <repoRoot>/.devai/config/sensor-inputs.json, which the fixture carries; both are
//     accepted. With rbac declared true and no RBAC-domain invariant it must not pass.
//   - senseSpecPerformanceTargets({ repoRoot }) reads law/targets/performance.json (a
//     type=performance invariant plus at least one target), not use-case keywords: the
//     fixture has no product/use-cases directory.
//   - senseSpecRobustnessTargets({ repoRoot }) reads law/targets/robustness.json (plus
//     the error_semantics invariants), not error-contract files under
//     docs/reference/contracts: the fixture has no docs directory.
//   - Out of this file's reach but stated for the record: harness_invariant_alignment
//     recognizes `node .devai/state/pr-bootstrap/cli/bin.js <action>` as a DEVAI launcher,
//     the form .github/workflows/pull-request-checks.yml uses.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { senseSpecAlignment } from '../src/spec-alignment.js';
import { senseSpecDepth } from '../src/spec-depth.js';
import { senseSpecPerformanceTargets } from '../src/spec-performance-targets.js';
import { senseSpecRobustnessTargets } from '../src/spec-robustness-targets.js';
import {
  senseSpecSecurityCoverage,
  type SpecSecurityCoverageOptions,
} from '../src/spec-security-coverage.js';
import type { SensorReading } from '../src/sensor-reading.js';

interface DeclaredSurfaces {
  readonly http: boolean;
  readonly database: boolean;
  readonly rbac: boolean;
  readonly actions: boolean;
}

/** A sensor's options widened by the declared `surfaces` the adapters deliver. */
type Surfaced<T> = T & { readonly surfaces?: DeclaredSurfaces };

const NOW = '2026-09-27T00:00:00.000Z';
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const REMOVED_INVARIANT = 'INV-CORE-001';

const RECORD_PATHS = [
  'law/invariants',
  'law/security',
  'law/targets',
  'law/trace.json',
  'law/adr',
  'law/policy/sensor-registry.json',
  '.devai/config/sensor-inputs.json',
  'scripts',
] as const;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

const declaredInputs = JSON.parse(
  readFileSync(join(REPO_ROOT, '.devai/config/sensor-inputs.json'), 'utf8'),
) as {
  inputs: { spec_depth?: { adrDir?: string; invariantsDir?: string } };
  surfaces: DeclaredSurfaces;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copyInto(root: string, rel: string): void {
  const from = join(REPO_ROOT, rel);
  if (!existsSync(from)) return;
  const to = join(root, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !SKIP_DIRS.has(src.split(/[\\/]/).pop() ?? ''),
  });
}

function tracedTestPaths(): string[] {
  const trace = JSON.parse(readFileSync(join(REPO_ROOT, 'law/trace.json'), 'utf8')) as {
    invariants?: ReadonlyArray<{ tests?: ReadonlyArray<{ path?: string }> }>;
    test_corpus?: ReadonlyArray<{ path?: string }>;
  };
  const paths = [
    ...(trace.invariants ?? []).flatMap((entry) => (entry.tests ?? []).map((t) => t.path)),
    ...(trace.test_corpus ?? []).map((row) => row.path),
  ];
  return [...new Set(paths.filter((p): p is string => typeof p === 'string'))];
}

/** A fixture mirroring DEVAI: a copy of the merged records and the code they claim. */
function mirrorDevai(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-spec-substrate-'));
  roots.push(root);
  for (const rel of RECORD_PATHS) copyInto(root, rel);
  for (const pkg of readdirSync(join(REPO_ROOT, 'packages'))) copyInto(root, `packages/${pkg}/src`);
  for (const rel of tracedTestPaths()) copyInto(root, rel);
  return root;
}

function remove(root: string, rel: string): void {
  const target = join(root, rel);
  expect(existsSync(target), `${rel} is a merged record the fixture copied`).toBe(true);
  rmSync(target, { recursive: true, force: true });
}

function specDepth(root: string): SensorReading {
  return senseSpecDepth({
    repoRoot: root,
    adrDir: declaredInputs.inputs.spec_depth?.adrDir ?? 'law/adr',
    invariantsDir: declaredInputs.inputs.spec_depth?.invariantsDir ?? 'law/invariants',
    now: NOW,
  }).reading;
}

function securityCoverage(root: string, surfaces: DeclaredSurfaces): SensorReading {
  const opts: Surfaced<SpecSecurityCoverageOptions> = { repoRoot: root, surfaces, now: NOW };
  return senseSpecSecurityCoverage(opts);
}

function describeReading(reading: SensorReading): string {
  return JSON.stringify({
    status: reading.status,
    findings: reading.findings,
    metrics: reading.metrics,
  });
}

describe('ADR-SCR-0004: the spec sensors read the specification substrate', () => {
  it('the fixture carries the merged records and DEVAI declares rbac absent', () => {
    const root = mirrorDevai();
    expect(
      readdirSync(join(root, 'law/invariants')).filter((f) => f.endsWith('.json')).length,
    ).toBe(
      readdirSync(join(REPO_ROOT, 'law/invariants')).filter((f) => f.endsWith('.json')).length,
    );
    for (const rel of [
      'law/security/threat-model.json',
      'law/security/data-handling.json',
      'law/targets/performance.json',
      'law/targets/robustness.json',
      `law/invariants/${REMOVED_INVARIANT}.json`,
    ]) {
      expect(existsSync(join(root, rel)), rel).toBe(true);
    }
    expect(existsSync(join(root, 'docs')), 'no markdown threat model or error contracts').toBe(
      false,
    );
    expect(existsSync(join(root, 'product/use-cases')), 'no use-case keywords').toBe(false);
    expect(declaredInputs.surfaces.rbac).toBe(false);
  });

  it('spec_depth reads pass on the mirror', () => {
    const reading = specDepth(mirrorDevai());
    expect(reading.status, describeReading(reading)).toBe('pass');
  });

  it('spec_alignment reads pass on the mirror', () => {
    const reading = senseSpecAlignment({ repoRoot: mirrorDevai(), now: NOW });
    expect(reading.status, describeReading(reading)).toBe('pass');
  });

  it('spec_security_coverage reads pass from the threat model and data handling records', () => {
    const reading = securityCoverage(mirrorDevai(), declaredInputs.surfaces);
    expect(reading.status, describeReading(reading)).toBe('pass');
    expect(
      (reading.findings ?? []).filter((f) => f.severity === 'warning' || f.severity === 'error'),
    ).toEqual([]);
  });

  it('spec_performance_targets reads pass from law/targets/performance.json', () => {
    const reading = senseSpecPerformanceTargets({ repoRoot: mirrorDevai(), now: NOW });
    expect(reading.status, describeReading(reading)).toBe('pass');
  });

  it('spec_robustness_targets reads pass from law/targets/robustness.json', () => {
    const reading = senseSpecRobustnessTargets({ repoRoot: mirrorDevai(), now: NOW });
    expect(reading.status, describeReading(reading)).toBe('pass');
  });
});

describe('ADR-SCR-0004 IA-005: removing a record stops the pass on the same head', () => {
  it(`removing ${REMOVED_INVARIANT} turns spec_depth from pass to fail`, () => {
    const root = mirrorDevai();
    const before = specDepth(root);
    expect(before.status, describeReading(before)).toBe('pass');

    remove(root, `law/invariants/${REMOVED_INVARIANT}.json`);
    const after = specDepth(root);
    expect(after.status, describeReading(after)).toBe('fail');
    expect(JSON.stringify(after.findings)).toContain(REMOVED_INVARIANT);
  });

  it('removing the threat model stops spec_security_coverage passing', () => {
    const root = mirrorDevai();
    remove(root, 'law/security/threat-model.json');
    expect(securityCoverage(root, declaredInputs.surfaces).status).not.toBe('pass');
  });

  it('removing the data handling declaration stops spec_security_coverage passing', () => {
    const root = mirrorDevai();
    remove(root, 'law/security/data-handling.json');
    expect(securityCoverage(root, declaredInputs.surfaces).status).not.toBe('pass');
  });

  it('declaring rbac present without an RBAC invariant stops spec_security_coverage passing', () => {
    const root = mirrorDevai();
    const reading = securityCoverage(root, { ...declaredInputs.surfaces, rbac: true });
    // Only meaningful while DEVAI has no RBAC-domain invariant; the mirror is DEVAI's.
    const hasRbac = readdirSync(join(root, 'law/invariants')).some((f) =>
      readFileSync(join(root, 'law/invariants', f), 'utf8').includes('"domain": "RBAC"'),
    );
    expect(hasRbac).toBe(false);
    expect(reading.status, describeReading(reading)).not.toBe('pass');
  });

  it('removing the performance targets stops spec_performance_targets passing', () => {
    const root = mirrorDevai();
    remove(root, 'law/targets/performance.json');
    expect(senseSpecPerformanceTargets({ repoRoot: root, now: NOW }).status).not.toBe('pass');
  });

  it('removing the robustness targets stops spec_robustness_targets passing', () => {
    const root = mirrorDevai();
    remove(root, 'law/targets/robustness.json');
    expect(senseSpecRobustnessTargets({ repoRoot: root, now: NOW }).status).not.toBe('pass');
  });
});
