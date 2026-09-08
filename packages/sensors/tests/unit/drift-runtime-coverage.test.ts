import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { senseDocsDrift } from '../../src/docs-drift.js';
import { senseSiteDrift } from '../../src/site-drift.js';
import type { SensorReading } from '../../src/sensor-reading.js';

const NOW = '2026-09-08T12:00:00.000Z';
const HOST_NOW = '2031-01-02T03:04:05.000Z';
const CONSTITUTION_VERSION = '1.4.0';

let root: string;

function write(path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function codes(reading: SensorReading): readonly string[] {
  return (reading.findings ?? []).map((finding) => finding.code);
}

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

/**
 * The site-drift sensor issues every Git read through the authority process
 * boundary, so its behaviour is only observable inside a real host-effect
 * scope. This grants exactly the read-only verbs the sensor documents.
 */
function withGitReadScope<T>(callback: () => T): T {
  const issuer = createAuthorityDecisionIssuer({
    issuer_id: 'sensors-drift-test-authority',
    issuer_version: '1.0.0',
    invocation_id: 'sensors-drift-1',
    canonicalSha256: (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(value) ?? '')
        .digest('hex'),
    randomId: () => 'sensors-drift-receipt',
    now: () => NOW,
    receipt_ttl_ms: 30_000,
  }) as { dispose: () => unknown };
  const scope: AuthorityHostEffectScope = {
    action_id: 'sense site drift',
    invocation_id: 'sensors-drift-1',
    effect: 'read',
    receipt_store: issuer,
    apply_effect: (request, apply) => {
      const [executable, args] = request.arguments;
      if (
        request.kind !== 'process' ||
        executable !== 'git' ||
        !Array.isArray(args) ||
        !['log', 'ls-tree', 'merge-base', 'rev-parse', 'show', 'tag'].includes(String(args[0]))
      ) {
        throw new Error('SENSORS_TEST_PROCESS_NOT_READ_ONLY');
      }
      return apply();
    },
  };
  try {
    return runWithAuthorityHostEffects(scope, callback);
  } finally {
    issuer.dispose();
  }
}

describe('senseSiteDrift repository-versus-deployment observation', () => {
  const IDENT = [
    '-c',
    'user.name=DEVAI Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
  ] as const;

  function git(...args: string[]): string {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  function commit(message: string): string {
    git('add', '-A');
    git(...IDENT, 'commit', '--quiet', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  }

  /** Write a gh-pages tip carrying `message` into the local remote-tracking ref. */
  function publish(message: string): string {
    const emptyTree = execFileSync('git', ['mktree'], {
      cwd: root,
      encoding: 'utf8',
      input: '',
    }).trim();
    const tip = git(...IDENT, 'commit-tree', emptyTree, '-m', message);
    git('update-ref', 'refs/remotes/origin/gh-pages', tip);
    return tip;
  }

  function publishFrom(source: string): string {
    return publish(`docs: publish from ${source}`);
  }

  function sense(): SensorReading {
    return withGitReadScope(() => senseSiteDrift({ repoRoot: root, now: NOW }));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devai-site-drift-'));
    git('init', '--quiet');
  });

  it('reports an unavailable HEAD before the first commit', () => {
    const reading = sense();

    expect(reading.sensor).toEqual({ name: 'site-drift', kind: 'site_drift' });
    expect(reading.command).toBe('devai sense site drift');
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(reading.status).toBe('unknown');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SITE_DRIFT_HEAD_UNAVAILABLE',
        message: 'Repository HEAD is unavailable.',
      },
    ]);
    expect(reading.metrics).toEqual({});
  });

  it('reports missing local gh-pages provenance without fetching', () => {
    const head = commit('base');

    const reading = sense();

    expect(reading.status).toBe('unknown');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SITE_DRIFT_PROVENANCE_UNAVAILABLE',
        message:
          'Local refs/remotes/origin/gh-pages is unavailable; fetch or live verification is required.',
      },
    ]);
    expect(reading.metrics).toEqual({ repository_head: head });
  });

  it.each([
    ['a subject that is not the publication verb', `chore: publish from ${'a'.repeat(40)}`],
    ['an abbreviated source sha', `docs: publish from ${'a'.repeat(39)}`],
    ['an uppercase source sha', `docs: publish from ${'A'.repeat(40)}`],
    ['a trailing suffix after the sha', `docs: publish from ${'a'.repeat(40)} (rebuild)`],
  ])('rejects a gh-pages tip message with %s', (_label, message) => {
    const head = commit('base');
    const tip = publish(message);

    const reading = sense();

    expect(reading.status).toBe('unknown');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SITE_DRIFT_PROVENANCE_MALFORMED',
        message: 'The gh-pages tip message must be exactly "docs: publish from <40-hex-sha>".',
      },
    ]);
    expect(reading.metrics).toEqual({ repository_head: head, published_tip: tip });
  });

  it('reports a published source that is absent from local objects', () => {
    const head = commit('base');
    const missing = 'b'.repeat(40);
    const tip = publishFrom(missing);

    const reading = sense();

    expect(reading.status).toBe('unknown');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SITE_DRIFT_SOURCE_UNREACHABLE',
        message: `Published source ${missing} is not reachable from local objects.`,
      },
    ]);
    expect(reading.metrics).toEqual({ repository_head: head, published_tip: tip });
  });

  it('reports a reachable published source that does not lead to HEAD', () => {
    const base = commit('base');
    const trunk = git('rev-parse', '--abbrev-ref', 'HEAD');
    git('checkout', '--quiet', '-b', 'side');
    const sideways = commit('sideways');
    git('checkout', '--quiet', trunk);
    const head = commit('trunk advance');
    const tip = publishFrom(sideways);

    const reading = sense();

    expect(base).not.toBe(sideways);
    expect(reading.status).toBe('unknown');
    expect(reading.findings).toEqual([
      {
        severity: 'warning',
        code: 'SITE_DRIFT_SOURCE_NON_ANCESTRAL',
        message: `Published source ${sideways} is not an ancestor of repository HEAD.`,
      },
    ]);
    expect(reading.metrics).toEqual({
      repository_head: head,
      published_tip: tip,
      published_source: sideways,
    });
  });

  it('passes when the published source is HEAD itself', () => {
    write('README.md', '# fixture\n');
    const head = commit('base');
    const tip = publishFrom(head);

    const reading = sense();

    expect(reading.status).toBe('pass');
    expect(reading.findings).toEqual([]);
    expect(reading.metrics).toEqual({
      repository_head: head,
      published_tip: tip,
      published_source: head,
      changed_path_count: 0,
      published_input_count: 0,
      package_version_drift_count: 0,
      package_release_count: 0,
    });
  });

  describe('published-input classification', () => {
    let base = '';

    beforeEach(() => {
      write('README.md', '# fixture\n');
      write('GOVERNANCE.md', '# governance\n');
      write('docs/site/index.html', '<html></html>\n');
      write('docs/other/notes.md', '# notes\n');
      write('law/policy/limits.json', '{}\n');
      write('src/app.ts', 'export const app = 1;\n');
      writeJson('docs/_ia/categories.json', {
        rootFileAllowlist: [{ source: 'GOVERNANCE.md' }, { source: 42 }],
      });
      base = commit('published base');
    });

    it('flags only the inputs the published site is built from', () => {
      // Two commits: `git log --name-only` separates them with a blank line,
      // which must not enter the changed-path set.
      write('README.md', '# fixture, revised\n');
      write('GOVERNANCE.md', '# governance, revised\n');
      commit('advance the root inputs');
      write('docs/site/index.html', '<html lang="en"></html>\n');
      write('docs/other/notes.md', '# notes, revised\n');
      write('law/policy/limits.json', '{ "worktrees": 4 }\n');
      write('src/app.ts', 'export const app = 2;\n');
      const head = commit('advance');
      const tip = publishFrom(base);

      const reading = sense();

      expect(reading.status).toBe('review');
      expect(reading.findings).toEqual([
        {
          severity: 'warning',
          code: 'SITE_DRIFT_PUBLISHED_INPUT',
          message: 'GOVERNANCE.md changed after the published source.',
          file: 'GOVERNANCE.md',
        },
        {
          severity: 'warning',
          code: 'SITE_DRIFT_PUBLISHED_INPUT',
          message: 'README.md changed after the published source.',
          file: 'README.md',
        },
        {
          severity: 'warning',
          code: 'SITE_DRIFT_PUBLISHED_INPUT',
          message: 'docs/site/index.html changed after the published source.',
          file: 'docs/site/index.html',
        },
        {
          severity: 'warning',
          code: 'SITE_DRIFT_PUBLISHED_INPUT',
          message: 'law/policy/limits.json changed after the published source.',
          file: 'law/policy/limits.json',
        },
      ]);
      expect(reading.metrics).toEqual({
        repository_head: head,
        published_tip: tip,
        published_source: base,
        changed_path_count: 6,
        published_input_count: 4,
        package_version_drift_count: 0,
        package_release_count: 0,
      });
    });

    it('keeps the default allowlist when the IA manifest is malformed at HEAD', () => {
      write('GOVERNANCE.md', '# governance, revised\n');
      write('README.md', '# fixture, revised\n');
      write('docs/_ia/categories.json', '{ not json\n');
      commit('advance with a malformed manifest');
      publishFrom(base);

      const reading = sense();

      expect(reading.status).toBe('review');
      expect(codes(reading)).toEqual(['SITE_DRIFT_PUBLISHED_INPUT', 'SITE_DRIFT_PUBLISHED_INPUT']);
      expect((reading.findings ?? []).map((finding) => finding.file)).toEqual([
        'README.md',
        'docs/_ia/categories.json',
      ]);
      expect(reading.metrics).toMatchObject({
        changed_path_count: 3,
        published_input_count: 2,
      });
    });
  });

  it('fails on package-version drift across the tracked manifests', () => {
    writeJson('package.json', { name: 'root', version: '1.0.0' });
    writeJson('packages/cli/package.json', { name: 'cli', version: '1.0.0' });
    writeJson('packages/utils/package.json', { name: 'utils', version: '1.0.0' });
    writeJson('packages/broken/package.json', { name: 'broken', version: '1.0.0' });
    writeJson('packages/deep/nested/package.json', { name: 'nested', version: '1.0.0' });
    const base = commit('published base');

    writeJson('package.json', { name: 'root', version: '1.1.0' });
    writeJson('packages/utils/package.json', { name: 'utils' });
    write('packages/broken/package.json', '{ not json\n');
    writeJson('packages/new/package.json', { name: 'new', version: '2.0.0' });
    writeJson('packages/deep/nested/package.json', { name: 'nested', version: '9.9.9' });
    const head = commit('advance');
    const tip = publishFrom(base);

    const reading = sense();

    expect(reading.status).toBe('fail');
    expect(reading.findings).toEqual([
      {
        severity: 'error',
        code: 'SITE_DRIFT_PACKAGE_VERSION',
        message: 'package.json has a different package version than the published source.',
        file: 'package.json',
      },
      {
        severity: 'error',
        code: 'SITE_DRIFT_PACKAGE_VERSION',
        message:
          'packages/broken/package.json has a different package version than the published source.',
        file: 'packages/broken/package.json',
      },
      {
        severity: 'error',
        code: 'SITE_DRIFT_PACKAGE_VERSION',
        message:
          'packages/utils/package.json has a different package version than the published source.',
        file: 'packages/utils/package.json',
      },
      // Manifests that exist only at HEAD follow the published-source listing:
      // the union preserves insertion order rather than re-sorting.
      {
        severity: 'error',
        code: 'SITE_DRIFT_PACKAGE_VERSION',
        message:
          'packages/new/package.json has a different package version than the published source.',
        file: 'packages/new/package.json',
      },
    ]);
    expect(reading.metrics).toEqual({
      repository_head: head,
      published_tip: tip,
      published_source: base,
      changed_path_count: 5,
      published_input_count: 0,
      package_version_drift_count: 4,
      package_release_count: 0,
    });
  });

  it('fails on release tags that strictly follow the published source', () => {
    const base = commit('published base');
    const middle = commit('middle');
    const trunk = git('rev-parse', '--abbrev-ref', 'HEAD');
    const head = commit('head');
    git('checkout', '--quiet', '-b', 'side');
    const sideways = commit('sideways');
    git('checkout', '--quiet', trunk);

    git('tag', 'v1.2.3', middle);
    git('tag', '@devai-nyx/cli@1.4.0', middle);
    git('tag', 'nightly', middle);
    git('tag', '1.2', middle);
    git('tag', 'v0.1.0', base);
    git('tag', 'v9.9.9', sideways);
    const tip = publishFrom(base);

    const reading = sense();

    expect(reading.status).toBe('fail');
    expect(reading.findings).toEqual([
      {
        severity: 'error',
        code: 'SITE_DRIFT_PACKAGE_RELEASE',
        message: 'Package release tag @devai-nyx/cli@1.4.0 follows the published source.',
      },
      {
        severity: 'error',
        code: 'SITE_DRIFT_PACKAGE_RELEASE',
        message: 'Package release tag v1.2.3 follows the published source.',
      },
    ]);
    expect(reading.metrics).toEqual({
      repository_head: head,
      published_tip: tip,
      published_source: base,
      changed_path_count: 0,
      published_input_count: 0,
      package_version_drift_count: 0,
      package_release_count: 2,
    });
  });

  it('stamps the caller clock and otherwise falls back to the host clock', () => {
    const head = commit('base');
    publishFrom(head);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(HOST_NOW));

    expect(sense().timestamp).toBe(NOW);
    expect(withGitReadScope(() => senseSiteDrift({ repoRoot: root })).timestamp).toBe(HOST_NOW);
  });
});

describe('senseDocsDrift machine-checkable prose claims', () => {
  const CONSTITUTION = [
    '# Constitution',
    '',
    `**Version:** ${CONSTITUTION_VERSION}`,
    '',
    '## Article 27 — Worktrees',
    '',
    'Concurrency is governed by policy.',
    '',
  ].join('\n');

  function sense(options: Partial<Parameters<typeof senseDocsDrift>[0]> = {}): SensorReading {
    return senseDocsDrift({ repoRoot: root, now: NOW, ...options });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devai-docs-drift-'));
    write('README.md', '# fixture\n');
    write('CLAUDE.md', '# claude\n');
    write('law/constitution.md', CONSTITUTION);
    write('law/schemas/a.schema.json', '{}\n');
    write('law/schemas/b.schema.json', '{}\n');
    write('law/schemas/c.schema.json', '{}\n');
    write('law/schemas/notes.json', '{}\n');
    write('law/schemas/d.schema.json.bak', '{}\n');
  });

  it('passes on the preferred claim-free state', () => {
    const reading = sense();

    expect(reading.sensor).toEqual({ name: 'docs-drift', kind: 'docs_drift' });
    expect(reading.command).toBe('devai sense-docs-drift');
    expect(reading.tier).toBe('L0');
    expect(reading.deterministic).toBe(true);
    expect(reading.timestamp).toBe(NOW);
    expect(reading.status).toBe('pass');
    expect(codes(reading)).toEqual([
      'DOCS_DRIFT_NO_SCHEMA_COUNT_CLAIM',
      'DOCS_DRIFT_NO_SCHEMA_COUNT_CLAIM',
      'DOCS_DRIFT_CAP_CHECK_DISABLED',
      'DOCS_DRIFT_NO_SNAPSHOT',
    ]);
    expect((reading.findings ?? []).map((finding) => finding.file)).toEqual([
      'README.md',
      'CLAUDE.md',
      undefined,
      undefined,
    ]);
    expect(reading.metrics).toEqual({
      schema_file_count: 3,
      claims_checked: 0,
      drift_count: 0,
    });
  });

  it('skips an absent claim file without failing', () => {
    const reading = sense({ claimFiles: ['README.md', 'HANDBOOK.md'] });

    expect(reading.status).toBe('pass');
    expect(reading.findings).toContainEqual({
      severity: 'info',
      code: 'DOCS_DRIFT_CLAIM_FILE_ABSENT',
      message: 'HANDBOOK.md not present; skipped.',
      file: 'HANDBOOK.md',
    });
  });

  it('fails a schema-count claim that disagrees with the schema population', () => {
    write('README.md', '# fixture\n\nThe registry holds 4 JSON Schema files today.\n');

    const reading = sense({ claimFiles: ['README.md'] });

    expect(reading.status).toBe('fail');
    expect(reading.findings).toEqual([
      {
        severity: 'error',
        code: 'DOCS_DRIFT_SCHEMA_COUNT',
        message: 'README.md claims 4 JSON Schema files; law/schemas contains 3.',
        file: 'README.md',
      },
      {
        severity: 'info',
        code: 'DOCS_DRIFT_CAP_CHECK_DISABLED',
        message: 'worktree_cap_source not configured; cap-coherence check skipped.',
      },
      {
        severity: 'info',
        code: 'DOCS_DRIFT_NO_SNAPSHOT',
        message: '.devai/pin/constitution.md not present; version-coherence check skipped.',
      },
    ]);
    expect(reading.metrics).toEqual({
      schema_file_count: 3,
      claims_checked: 1,
      drift_count: 1,
    });
  });

  it('accepts every accurate schema-count claim in a file', () => {
    write('README.md', '# fixture\n\n3 JSON Schema files ship; exactly 3 json schema file each.\n');

    const reading = sense({ claimFiles: ['README.md'] });

    expect(reading.status).toBe('pass');
    expect(codes(reading)).toEqual(['DOCS_DRIFT_CAP_CHECK_DISABLED', 'DOCS_DRIFT_NO_SNAPSHOT']);
    expect(reading.metrics).toEqual({
      schema_file_count: 3,
      claims_checked: 2,
      drift_count: 0,
    });
  });

  it('counts schemas in the configured directory only', () => {
    write('README.md', '# fixture\n\n0 JSON Schema files are registered.\n');

    const reading = sense({ claimFiles: ['README.md'], schemasDir: 'law/absent-schemas' });

    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ schema_file_count: 0, claims_checked: 1 });

    const drifted = sense({ claimFiles: ['README.md'], schemasDir: 'law/schemas' });
    expect(drifted.findings).toContainEqual({
      severity: 'error',
      code: 'DOCS_DRIFT_SCHEMA_COUNT',
      message: 'README.md claims 0 JSON Schema files; law/schemas contains 3.',
      file: 'README.md',
    });
  });

  describe('decision-range claims', () => {
    beforeEach(() => {
      write(
        'law/register/DECISIONS.md',
        [
          '# Decisions',
          '',
          '### DII-7 — first',
          '### DII-131 — highest',
          '### DII-42 — middle',
          '#### DII-999 — a subsection, not a register entry',
          'prose mentioning ### DII-888 inline',
          '',
        ].join('\n'),
      );
    });

    it('fails a stale decision-range claim', () => {
      write('README.md', '# fixture\n\nDecisions D-1…D-140 are recorded.\n');

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('fail');
      expect(reading.findings).toEqual([
        {
          severity: 'error',
          code: 'DOCS_DRIFT_DECISION_RANGE',
          message: 'README.md claims the decision log runs to D-140; the highest entry is D-131.',
          file: 'README.md',
        },
        {
          severity: 'info',
          code: 'DOCS_DRIFT_CAP_CHECK_DISABLED',
          message: 'worktree_cap_source not configured; cap-coherence check skipped.',
        },
        {
          severity: 'info',
          code: 'DOCS_DRIFT_NO_SNAPSHOT',
          message: '.devai/pin/constitution.md not present; version-coherence check skipped.',
        },
      ]);
      expect(reading.metrics).toMatchObject({ claims_checked: 1, drift_count: 1 });
    });

    it('accepts an accurate decision-range claim in either dotted form', () => {
      write('README.md', '# fixture\n\nD-1...D-131 and D-1..D-131 are both recorded.\n');

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('pass');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_DECISION_RANGE');
      expect(reading.metrics).toMatchObject({ claims_checked: 2, drift_count: 0 });
    });

    it('reports the preferred claim-free README state', () => {
      const reading = sense({ claimFiles: [] });

      expect(reading.findings).toContainEqual({
        severity: 'info',
        code: 'DOCS_DRIFT_NO_DECISION_RANGE_CLAIM',
        message: 'README.md carries no decision-range claim (preferred state).',
        file: 'README.md',
      });
      expect(reading.metrics).toMatchObject({ claims_checked: 0 });
    });

    it('skips the check entirely when README.md is absent', () => {
      rmSync(join(root, 'README.md'));

      const reading = sense({ claimFiles: [] });

      expect(codes(reading)).not.toContain('DOCS_DRIFT_NO_DECISION_RANGE_CLAIM');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_DECISION_RANGE');
    });
  });

  describe('worktree cap coherence', () => {
    function withCapProse(prose: string): void {
      write(
        'law/constitution.md',
        [
          '# Constitution',
          '',
          `**Version:** ${CONSTITUTION_VERSION}`,
          '',
          `Concurrency is ${prose}.`,
          '',
        ].join('\n'),
      );
    }

    it('reports a configured cap source that does not exist', () => {
      withCapProse('capped at four');

      const reading = sense({ claimFiles: [], worktreeCapSource: 'src/worktrees.ts' });

      expect(reading.status).toBe('fail');
      expect(reading.findings).toContainEqual({
        severity: 'error',
        code: 'DOCS_DRIFT_CAP_SOURCE_NOT_FOUND',
        message: 'worktree_cap_source src/worktrees.ts not found.',
        file: 'src/worktrees.ts',
      });
      expect(reading.metrics).toMatchObject({ claims_checked: 0, drift_count: 1 });
    });

    it.each([
      ['a spelled cap that matches the constant', 'capped at four', 'WORKTREE_CAP = 4'],
      ['a numeric cap that matches the constant', 'capped at 4', 'WORKTREE_CAP=4'],
    ])('accepts %s', (_label, prose, constant) => {
      withCapProse(prose);
      write('src/worktrees.ts', `export const ${constant};\n`);

      const reading = sense({ claimFiles: [], worktreeCapSource: 'src/worktrees.ts' });

      expect(reading.status).toBe('pass');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_WORKTREE_CAP');
      expect(reading.metrics).toMatchObject({ claims_checked: 1, drift_count: 0 });
    });

    it.each([
      [
        'a spelled cap above the constant',
        'capped at five',
        'export const WORKTREE_CAP = 4;\n',
        'five',
        '4',
      ],
      [
        'an unparsable cap word',
        'capped at eleven',
        'export const WORKTREE_CAP = 4;\n',
        'eleven',
        '4',
      ],
      [
        'a source carrying no constant',
        'capped at four',
        'export const OTHER = 4;\n',
        'four',
        '(not found)',
      ],
    ])('fails on %s', (_label, prose, source, claimed, actual) => {
      withCapProse(prose);
      write('src/worktrees.ts', source);

      const reading = sense({ claimFiles: [], worktreeCapSource: 'src/worktrees.ts' });

      expect(reading.status).toBe('fail');
      expect(reading.findings).toContainEqual({
        severity: 'error',
        code: 'DOCS_DRIFT_WORKTREE_CAP',
        message: `law/constitution.md states a cap of ${claimed}; src/worktrees.ts enforces WORKTREE_CAP = ${actual}.`,
        file: 'law/constitution.md',
      });
      expect(reading.metrics).toMatchObject({ claims_checked: 1, drift_count: 1 });
    });

    it('ignores superseded cap prose quoted in the amendment history', () => {
      write(
        'law/constitution.md',
        [
          '# Constitution',
          '',
          `**Version:** ${CONSTITUTION_VERSION}`,
          '',
          'Concurrency is governed by policy.',
          '',
          '## Amendment history',
          '',
          'Prior text: concurrency is capped at nine.',
          '',
        ].join('\n'),
      );
      write('src/worktrees.ts', 'export const WORKTREE_CAP = 4;\n');

      const reading = sense({ claimFiles: [], worktreeCapSource: 'src/worktrees.ts' });

      expect(reading.status).toBe('pass');
      expect(reading.findings).toContainEqual({
        severity: 'info',
        code: 'DOCS_DRIFT_CONSTITUTION_NO_CAP_VALUE',
        message: 'law/constitution.md states no cap value (cap is policy; preferred state).',
        file: 'law/constitution.md',
      });
      expect(reading.metrics).toMatchObject({ claims_checked: 0 });
    });

    it('reads the live articles up to the canonical amendment heading only', () => {
      write(
        'law/constitution.md',
        [
          '# Constitution',
          '',
          `**Version:** ${CONSTITUTION_VERSION}`,
          '',
          'Superseded prose is quoted under ## Amendment history',
          '',
          'Concurrency is capped at four.',
          '',
          '## Amendment history',
          '',
          'Prior text: concurrency is capped at nine.',
          '',
        ].join('\n'),
      );
      write('src/worktrees.ts', 'export const WORKTREE_CAP = 4;\n');

      const reading = sense({ claimFiles: [], worktreeCapSource: 'src/worktrees.ts' });

      expect(reading.status).toBe('pass');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_CONSTITUTION_NO_CAP_VALUE');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_WORKTREE_CAP');
      expect(reading.metrics).toMatchObject({ claims_checked: 1 });
    });

    it('auto-detects the canonical cap source and prefers an explicit override', () => {
      withCapProse('capped at four');
      write('packages/loop/src/worktrees.ts', 'export const WORKTREE_CAP = 8;\n');
      write('src/worktrees.ts', 'export const WORKTREE_CAP = 4;\n');

      expect(sense({ claimFiles: [] }).findings).toContainEqual({
        severity: 'error',
        code: 'DOCS_DRIFT_WORKTREE_CAP',
        message:
          'law/constitution.md states a cap of four; packages/loop/src/worktrees.ts enforces WORKTREE_CAP = 8.',
        file: 'law/constitution.md',
      });
      expect(codes(sense({ claimFiles: [], worktreeCapSource: 'src/worktrees.ts' }))).not.toContain(
        'DOCS_DRIFT_WORKTREE_CAP',
      );
    });

    it('fails closed and skips cap coherence when the Constitution is absent', () => {
      rmSync(join(root, 'law/constitution.md'));
      write('src/worktrees.ts', 'export const WORKTREE_CAP = 4;\n');

      const reading = sense({ claimFiles: [], worktreeCapSource: 'src/worktrees.ts' });

      expect(reading.status).toBe('fail');
      expect(reading.findings).toEqual([
        {
          severity: 'critical',
          code: 'DOCS_DRIFT_CONSTITUTION_NOT_FOUND',
          message: 'law/constitution.md is required for DEVAI docs-drift checks.',
          file: 'law/constitution.md',
        },
      ]);
      expect(reading.metrics).toMatchObject({ claims_checked: 0, drift_count: 1 });
    });
  });

  describe('pinned Constitution snapshot', () => {
    it('accepts a snapshot pinned at the live version', () => {
      write('.devai/pin/constitution.md', CONSTITUTION);

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('pass');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_CONSTITUTION_VERSION');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_NO_SNAPSHOT');
      expect(reading.metrics).toMatchObject({ claims_checked: 1, drift_count: 0 });
    });

    it.each([
      ['a stale pinned version', CONSTITUTION.replace(CONSTITUTION_VERSION, '1.3.0'), '1.3.0', 1],
      ['a snapshot with no version header', '# Constitution\n\nNo header.\n', '(no version)', 0],
    ])('fails on %s', (_label, snapshot, pinned, claimsChecked) => {
      write('.devai/pin/constitution.md', snapshot);

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('fail');
      expect(reading.findings).toContainEqual({
        severity: 'error',
        code: 'DOCS_DRIFT_CONSTITUTION_VERSION',
        message: `law/constitution.md is at ${CONSTITUTION_VERSION}; .devai/pin/constitution.md pins ${pinned}.`,
        file: '.devai/pin/constitution.md',
      });
      expect(reading.metrics).toMatchObject({ claims_checked: claimsChecked, drift_count: 1 });
    });

    it('recognises a snapshot that resolves to the canonical Constitution', () => {
      mkdirSync(join(root, '.devai/pin'), { recursive: true });
      symlinkSync(join(root, 'law/constitution.md'), join(root, '.devai/pin/constitution.md'));

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('pass');
      expect(reading.findings).toContainEqual({
        severity: 'info',
        code: 'DOCS_DRIFT_CONSTITUTION_SELF_PIN',
        message: '.devai/pin/constitution.md resolves to the canonical Constitution.',
        file: '.devai/pin/constitution.md',
      });
      expect(reading.metrics).toMatchObject({ claims_checked: 0 });
    });
  });

  describe('narrative page version claims', () => {
    it('accepts a status page that matches the Constitution and the package line', () => {
      write(
        'docs/start/status.md',
        `# Status\n\nConstitution **${CONSTITUTION_VERSION}**; the **1.5.x** line is current.\n`,
      );
      writeJson('packages/cli/package.json', { name: 'cli', version: '1.5.2' });

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('pass');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_STATUS_CONSTITUTION_VERSION');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_STATUS_PACKAGE_LINE');
      expect(reading.metrics).toMatchObject({ claims_checked: 1 });
    });

    it('fails a status page that trails both the Constitution and the package line', () => {
      write('docs/start/status.md', '# Status\n\nConstitution **1.3.0**; the **1.4.x** line.\n');
      writeJson('packages/cli/package.json', { name: 'cli', version: '1.5.2' });

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('fail');
      expect(reading.findings).toContainEqual({
        severity: 'error',
        code: 'DOCS_DRIFT_STATUS_CONSTITUTION_VERSION',
        message: `docs/start/status.md claims Constitution 1.3.0; law/constitution.md is at ${CONSTITUTION_VERSION}.`,
        file: 'docs/start/status.md',
      });
      expect(reading.findings).toContainEqual({
        severity: 'error',
        code: 'DOCS_DRIFT_STATUS_PACKAGE_LINE',
        message: 'docs/start/status.md claims the 1.4.x line; @devai-nyx/* packages are at 1.5.x.',
        file: 'docs/start/status.md',
      });
      expect(reading.metrics).toMatchObject({ claims_checked: 1, drift_count: 2 });
    });

    it('cannot check the package line without the CLI manifest', () => {
      write('docs/start/status.md', '# Status\n\nThe **1.4.x** line.\n');

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('pass');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_STATUS_PACKAGE_LINE');
      expect(reading.metrics).toMatchObject({ claims_checked: 1 });
    });

    it('fails a SECURITY.md that hardcodes the supported line', () => {
      write('SECURITY.md', '# Security\n\nReports should target the current 1.5.x release.\n');

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('fail');
      expect(reading.findings).toContainEqual({
        severity: 'error',
        code: 'DOCS_DRIFT_SECURITY_HARDCODED_LINE',
        message:
          'SECURITY.md hardcodes a supported version line ("target the current N.M.x"); keep the sentence version-free.',
        file: 'SECURITY.md',
      });
      expect(reading.metrics).toMatchObject({ claims_checked: 1, drift_count: 1 });
    });

    it('accepts a version-free SECURITY.md supported line', () => {
      write('SECURITY.md', '# Security\n\nReports should target the current supported release.\n');

      const reading = sense({ claimFiles: [] });

      expect(reading.status).toBe('pass');
      expect(codes(reading)).not.toContain('DOCS_DRIFT_SECURITY_HARDCODED_LINE');
      expect(reading.metrics).toMatchObject({ claims_checked: 1 });
    });
  });

  it('stamps the caller clock and otherwise falls back to the host clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(HOST_NOW));

    expect(sense({ claimFiles: [] }).timestamp).toBe(NOW);
    expect(senseDocsDrift({ repoRoot: root, claimFiles: [] }).timestamp).toBe(HOST_NOW);
  });
});
