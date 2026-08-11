import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANONICAL_FORBIDDEN_ACTIONS,
  checkForbiddenRegistryCoverage,
  loadForbiddenWaivers,
  scanForbiddenActions,
} from '../../src/forbidden-actions/index.js';
import { withAuthorityHostTestScope } from './authority-host-test-scope.js';

aroundEach((runTest) => withAuthorityHostTestScope(runTest));

let dir = '';
let registryPath = '';

function writeRegistry(body: Record<string, unknown>): void {
  writeFileSync(registryPath, JSON.stringify(body, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devai-forbidden-'));
  registryPath = join(dir, 'forbidden-actions.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('checkForbiddenRegistryCoverage', () => {
  it('reports full coverage when the registry carries every canonical entry', () => {
    writeRegistry({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS });
    const result = checkForbiddenRegistryCoverage(registryPath);
    expect(result.ok).toBe(true);
    expect(result.unwaived_missing).toEqual([]);
    expect(result.present).toHaveLength(CANONICAL_FORBIDDEN_ACTIONS.length);
    expect(result.canonical_total).toBe(CANONICAL_FORBIDDEN_ACTIONS.length);
  });

  it('reports an unwaived gap when a canonical entry is silently dropped', () => {
    const trimmed = CANONICAL_FORBIDDEN_ACTIONS.filter((e) => e.id !== 'FORBID-RM-RF');
    writeRegistry({ schemaVersion: '1.0.0', actions: trimmed });
    const result = checkForbiddenRegistryCoverage(registryPath);
    expect(result.ok).toBe(false);
    expect(result.unwaived_missing).toEqual(['FORBID-RM-RF']);
  });

  it('treats a waived entry as covered, not a gap', () => {
    const trimmed = CANONICAL_FORBIDDEN_ACTIONS.filter((e) => e.id !== 'FORBID-RM-RF');
    writeRegistry({
      schemaVersion: '1.0.0',
      actions: trimmed,
      waivers: [{ id: 'FORBID-RM-RF', reason: 'repo has no shell execution surface at all' }],
    });
    const result = checkForbiddenRegistryCoverage(registryPath);
    expect(result.ok).toBe(true);
    expect(result.unwaived_missing).toEqual([]);
    expect(result.waived).toEqual([
      { id: 'FORBID-RM-RF', reason: 'repo has no shell execution surface at all' },
    ]);
  });

  it('ignores waivers for non-canonical ids', () => {
    writeRegistry({
      schemaVersion: '1.0.0',
      actions: CANONICAL_FORBIDDEN_ACTIONS,
      waivers: [{ id: 'FORBID-NOT-REAL', reason: 'made up id, should be dropped from output' }],
    });
    const result = checkForbiddenRegistryCoverage(registryPath);
    expect(result.ok).toBe(true);
    expect(result.waived).toEqual([]);
  });

  it('treats client-added entries as additive and irrelevant to canonical coverage', () => {
    writeRegistry({
      schemaVersion: '1.0.0',
      actions: [
        ...CANONICAL_FORBIDDEN_ACTIONS,
        {
          id: 'FORBID-CLIENT-CUSTOM',
          action: 'Something this repo specifically forbids',
          rationale: 'local policy',
          severity: 'medium',
        },
      ],
    });
    const result = checkForbiddenRegistryCoverage(registryPath);
    expect(result.ok).toBe(true);
    expect(result.present).not.toContain('FORBID-CLIENT-CUSTOM');
  });

  it('treats a missing registry file as full non-coverage', () => {
    const result = checkForbiddenRegistryCoverage(join(dir, 'does-not-exist.json'));
    expect(result.ok).toBe(false);
    expect(result.unwaived_missing).toHaveLength(CANONICAL_FORBIDDEN_ACTIONS.length);
  });
});

describe('loadForbiddenWaivers', () => {
  it('returns an empty array when the file has no waivers field', () => {
    writeRegistry({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS });
    expect(loadForbiddenWaivers(registryPath)).toEqual([]);
  });

  it('returns an empty array for an unparseable file rather than throwing', () => {
    writeFileSync(registryPath, '{ not valid json');
    expect(loadForbiddenWaivers(registryPath)).toEqual([]);
  });
});

describe('scanForbiddenActions', () => {
  function writeContextAwareRegistry(): void {
    const actions = CANONICAL_FORBIDDEN_ACTIONS.map((entry) =>
      entry.id === 'FORBID-DROP-PROD'
        ? {
            ...entry,
            allowed_change_line_patterns: [
              '\\b(?:DROP\\s+(?:TABLE|DATABASE)|TRUNCATE\\s+TABLE)\\s+(?:IF\\s+EXISTS\\s+)?(?:devai_task_[A-Za-z0-9_]+\\b|devai_task_<id>|devai_template\\b)(?=\\s*(?:[\\"\'`]|;|$))',
            ],
          }
        : entry,
    );
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions }),
    );
  }

  function seedRepository(): void {
    writeFileSync(join(dir, 'README.md'), 'seed\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
  }

  function writeCiAdr(options?: {
    readonly status?: 'active' | 'superseded';
    readonly affectedRule?: string;
    readonly malformed?: boolean;
  }): void {
    mkdirSync(join(dir, 'law/adr'), { recursive: true });
    writeFileSync(
      join(dir, 'law/adr/ADR-014-ci-checker.md'),
      options?.malformed === true
        ? '---\nid: ADR-014\nstatus active\n---\n'
        : `---\nid: ADR-014\ntype: adr\nstatus: ${options?.status ?? 'active'}\naffected_rules:\n  - ${options?.affectedRule ?? 'scripts/check-workflows.mjs'}\n---\n`,
    );
  }

  function commitCiCheckerChange(): string {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/check-workflows.mjs'), 'export const checked = true;\n');
    execFileSync('git', ['add', 'scripts/check-workflows.mjs'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Engineer',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'fix: strengthen workflow checker',
      ],
      { cwd: dir },
    );
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  }

  it('accepts a CI checker change with exact active ADR affected-rule coverage', () => {
    writeContextAwareRegistry();
    writeCiAdr();
    seedRepository();
    commitCiCheckerChange();

    expect(
      scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings.filter(
        (finding) => finding.forbidden_id === 'FORBID-CI-WITHOUT-ADR',
      ),
    ).toEqual([]);
  });

  it('scans every commit after an exact base even when a trailing window would omit it', () => {
    writeContextAwareRegistry();
    seedRepository();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    writeFileSync(join(dir, 'unsafe.txt'), 'git push --force\n');
    execFileSync('git', ['add', 'unsafe.txt'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'fixture unsafe evidence',
      ],
      { cwd: dir },
    );
    writeFileSync(join(dir, 'later.txt'), 'safe\n');
    execFileSync('git', ['add', 'later.txt'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'later safe evidence',
      ],
      { cwd: dir },
    );

    expect(
      scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings.some(
        (finding) => finding.forbidden_id === 'FORBID-FORCE-PUSH',
      ),
    ).toBe(false);
    expect(
      scanForbiddenActions({ repoRoot: dir, sinceRef: base, maxCommits: 1 }).findings.some(
        (finding) => finding.forbidden_id === 'FORBID-FORCE-PUSH',
      ),
    ).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['superseded', { status: 'superseded' as const }],
    ['unrelated', { affectedRule: '.github/workflows/ci.yml' }],
    ['malformed', { malformed: true }],
  ])('rejects a CI checker change when ADR coverage is %s', (_label, options) => {
    writeContextAwareRegistry();
    if (options !== undefined) writeCiAdr(options);
    seedRepository();
    const sha = commitCiCheckerChange();

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-CI-WITHOUT-ADR',
        source: 'commit-change',
        ref: sha,
      }),
    );
  });

  it('fails closed when the registry is missing or has no executable patterns', () => {
    expect(
      scanForbiddenActions({ repoRoot: dir, registryPath: join(dir, 'missing.json') }).findings,
    ).toContainEqual(expect.objectContaining({ forbidden_id: 'FORBIDDEN-REGISTRY-INVALID' }));

    writeRegistry({
      schemaVersion: '1.0.0',
      actions: CANONICAL_FORBIDDEN_ACTIONS.map(({ detect_patterns: _patterns, ...entry }) => entry),
    });
    expect(
      scanForbiddenActions({ repoRoot: dir, registryPath, maxCommits: 1 }).findings,
    ).toContainEqual(expect.objectContaining({ forbidden_id: 'FORBIDDEN-REGISTRY-INVALID' }));
    expect(checkForbiddenRegistryCoverage(registryPath).ok).toBe(false);
  });

  it('fails closed when the registry bytes are malformed', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    writeFileSync(join(dir, '.devai/config/forbidden-actions.json'), '{ malformed');
    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({ forbidden_id: 'FORBIDDEN-REGISTRY-INVALID' }),
    );
  });

  it('fails closed when committed history cannot be inspected', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBIDDEN-SCAN-UNAVAILABLE',
        source: 'commit-change',
      }),
    );
  });

  it('detects a forbidden law deletion hidden behind a neutral commit message', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, 'law'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    writeFileSync(join(dir, 'law/constitution.md'), 'governed\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    rmSync(join(dir, 'law/constitution.md'));
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'chore: tidy',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({ forbidden_id: 'FORBID-DELETE-AUTHORITY-DOCS' }),
    );
  });

  it('does not vacuously suppress protected-path message evidence on an unrelated change', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, 'packages/demo'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    writeFileSync(join(dir, 'packages/demo/index.ts'), 'export {};\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    writeFileSync(join(dir, 'packages/demo/index.ts'), 'export const changed = true;\n');
    execFileSync('git', ['add', 'packages/demo/index.ts'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'git add .devai/config/forbidden-actions.json',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-MUTATE-INVARIANTS',
        source: 'commit-message',
      }),
    );
  });

  it('KR-R5-027 does not classify a nested record segment as the top-level record tree', () => {
    const source = join(dir, 'packages/cli/src/commands/record/run.ts');
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, 'packages/cli/src/commands/record'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    writeFileSync(source, 'export const value = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Engineer',
        '-c',
        'user.email=engineer@example.com',
        'commit',
        '-qm',
        'seed',
      ],
      { cwd: dir },
    );
    writeFileSync(source, 'export const value = 2;\n');
    execFileSync('git', ['add', 'packages/cli/src/commands/record/run.ts'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Engineer',
        '-c',
        'user.email=engineer@example.com',
        'commit',
        '-qm',
        'fix(r0005): change nested record command',
      ],
      { cwd: dir },
    );

    expect(
      scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings.filter(
        (finding) => finding.forbidden_id === 'FORBID-MUTATE-INVARIANTS',
      ),
    ).toEqual([]);
  });

  it.each([
    ['law/constitution.md', 'governed\n', 'changed\n'],
    ['law/trace.json', '{}\n', '{"changed":true}\n'],
    ['record/proofs/compliance/closures/PC-0001.json', '{}\n', '{"changed":true}\n'],
  ])('detects a neutral in-place mutation of %s', (path, initial, changed) => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    writeFileSync(join(dir, path), initial);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    writeFileSync(join(dir, path), changed);
    execFileSync('git', ['add', path], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'chore: tidy',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({ source: 'commit-change' }),
    );
  });

  it('detects a protected file renamed out of the governed tree', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, 'law'), { recursive: true });
    mkdirSync(join(dir, 'scratch'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    writeFileSync(join(dir, 'law/constitution.md'), 'governed\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    execFileSync('git', ['mv', 'law/constitution.md', 'scratch/constitution.md'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'chore: reorganize',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-DELETE-AUTHORITY-DOCS',
        source: 'commit-change',
      }),
    );
  });

  it('detects a protected deletion introduced by a merge commit', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, 'law'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    writeFileSync(join(dir, 'law/constitution.md'), 'governed\n');
    writeFileSync(join(dir, 'README.md'), 'seed\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    const initialBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-qb', 'remove-law'], { cwd: dir });
    rmSync(join(dir, 'law/constitution.md'));
    writeFileSync(join(dir, 'large-merge-fixture.txt'), 'x'.repeat(1_100_000));
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'remove',
      ],
      { cwd: dir },
    );
    execFileSync('git', ['checkout', '-q', initialBranch], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'main\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'main'],
      { cwd: dir },
    );
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'merge',
        '--no-ff',
        '-qm',
        'merge',
        'remove-law',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-DELETE-AUTHORITY-DOCS',
        source: 'commit-change',
      }),
    );
  });

  it('does not duplicate constituent evidence on a tree-identical synthetic merge', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    writeFileSync(join(dir, 'README.md'), 'seed\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    const initialBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), 'git push --force example\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'feature',
      ],
      { cwd: dir },
    );
    const featureCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-q', initialBranch], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'merge',
        '--no-ff',
        '-qm',
        'synthetic merge',
        'feature',
      ],
      { cwd: dir },
    );

    const findings = scanForbiddenActions({ repoRoot: dir, maxCommits: 3 }).findings.filter(
      (finding) => finding.forbidden_id === 'FORBID-FORCE-PUSH',
    );
    expect(findings).toEqual([
      expect.objectContaining({ ref: featureCommit, source: 'commit-change' }),
    ]);
  });

  it('does not classify an Inspector-authored test-only fixture as action evidence', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.devai/config/forbidden-actions.json'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    writeFileSync(
      join(dir, 'tests/forbidden-command.test.ts'),
      `${['git', 'push', '--force'].join(' ')} example\n`,
    );
    execFileSync('git', ['add', 'tests/forbidden-command.test.ts'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Inspector',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'test: add fixture',
      ],
      { cwd: dir },
    );

    expect(
      scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings.filter(
        (finding) => finding.forbidden_id === 'FORBID-FORCE-PUSH',
      ),
    ).toEqual([]);
  });

  it('keeps message evidence active on an Inspector-authored test-only commit', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.devai/config/forbidden-actions.json'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    writeFileSync(join(dir, 'tests/example.test.ts'), 'export {};\n');
    execFileSync('git', ['add', 'tests/example.test.ts'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Inspector',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        ['git', 'push', '--force'].join(' '),
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-FORCE-PUSH',
        source: 'commit-message',
      }),
    );
  });

  it('keeps change evidence active on a mixed-path Inspector commit', () => {
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    mkdirSync(join(dir, 'packages/demo'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions: CANONICAL_FORBIDDEN_ACTIONS }),
    );
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.devai/config/forbidden-actions.json'], { cwd: dir });
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'seed'],
      { cwd: dir },
    );
    const fixture = `${['git', 'push', '--force'].join(' ')} example\n`;
    writeFileSync(join(dir, 'tests/example.test.ts'), fixture);
    writeFileSync(join(dir, 'packages/demo/index.ts'), fixture);
    execFileSync('git', ['add', 'tests/example.test.ts', 'packages/demo/index.ts'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Inspector',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'test: mixed fixture',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-FORCE-PUSH',
        source: 'commit-change',
      }),
    );
  });

  it('accepts a destructive SQL occurrence whose changed line is explicitly dev-scoped', () => {
    writeContextAwareRegistry();
    seedRepository();
    mkdirSync(join(dir, 'packages/demo'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/demo/action.txt'),
      'Terminate connections + DROP DATABASE devai_task_<id>\n',
    );
    execFileSync('git', ['add', 'packages/demo/action.txt'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Engineer',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'feat: add bounded development cleanup',
      ],
      { cwd: dir },
    );

    expect(
      scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings.filter(
        (finding) => finding.forbidden_id === 'FORBID-DROP-PROD',
      ),
    ).toEqual([]);
  });

  it('still reports an unsafe occurrence when the same change contains safe dev SQL', () => {
    writeContextAwareRegistry();
    seedRepository();
    mkdirSync(join(dir, 'packages/demo'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/demo/action.txt'),
      ['DROP DATABASE devai_task_<id>', 'TRUNCATE TABLE production_accounts', ''].join('\n'),
    );
    execFileSync('git', ['add', 'packages/demo/action.txt'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Engineer',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'feat: add cleanup actions',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-DROP-PROD',
        source: 'commit-change',
        matched: 'TRUNCATE TABLE',
      }),
    );
  });

  it('never applies change-line context to commit-message evidence', () => {
    writeContextAwareRegistry();
    seedRepository();
    writeFileSync(join(dir, 'README.md'), 'changed\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Engineer',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'DROP DATABASE devai_task_<id>',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-DROP-PROD',
        source: 'commit-message',
      }),
    );
  });

  it('fails closed when an allowed change-line pattern is invalid', () => {
    const actions = CANONICAL_FORBIDDEN_ACTIONS.map((entry) =>
      entry.id === 'FORBID-DROP-PROD' ? { ...entry, allowed_change_line_patterns: ['['] } : entry,
    );
    mkdirSync(join(dir, '.devai/config'), { recursive: true });
    writeFileSync(
      join(dir, '.devai/config/forbidden-actions.json'),
      JSON.stringify({ schemaVersion: '1.0.0', actions }),
    );
    seedRepository();

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({ forbidden_id: 'FORBIDDEN-REGISTRY-INVALID' }),
    );
  });

  it.each([
    'DROP TABLE production_accounts; -- devai_template',
    'DROP TABLE devai_task_x, customers',
  ])('does not let an unrelated same-line dev identity suppress %s', (sql) => {
    writeContextAwareRegistry();
    seedRepository();
    mkdirSync(join(dir, 'packages/demo'), { recursive: true });
    writeFileSync(join(dir, 'packages/demo/action.txt'), `${sql}\n`);
    execFileSync('git', ['add', 'packages/demo/action.txt'], { cwd: dir });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=DEVAI Engineer',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'feat: add cleanup action',
      ],
      { cwd: dir },
    );

    expect(scanForbiddenActions({ repoRoot: dir, maxCommits: 1 }).findings).toContainEqual(
      expect.objectContaining({
        forbidden_id: 'FORBID-DROP-PROD',
        source: 'commit-change',
      }),
    );
  });
});
// Invariants: INV-DEVAI-001
