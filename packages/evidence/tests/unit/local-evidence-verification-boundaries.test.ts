import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { collectLocalEvidence } from '../../src/local-evidence/collect.js';
import {
  verifyLocalEvidence,
  type VerifyLocalInputs,
  type VerifyLocalResult,
} from '../../src/local-evidence/verify.js';

/**
 * Refusal boundaries of `devai evidence local verify` that the native
 * contract suite does not already bind: the exact diagnostic each
 * fail-closed branch produces, the subject a manifest is allowed to
 * name, and the identities (clock, tool, actor, changed files,
 * caller-selected path) a claim cannot substitute.
 */

const REQUIRED_JOBS = ['unit', 'coverage'] as const;
const NOW = new Date('2026-08-22T12:00:00.000Z');
const roots: string[] = [];

interface MutableManifest extends Record<string, unknown> {
  generatedAt: string;
  expiresAt: string;
  subject: { repository: string; commitSha: string; tree: { algorithm: string; value: string } };
  sourceHash: { value: string; fileCount: number };
  policy: { maxAgeHours: number; requiredJobs: string[]; allowedPlatforms: string[] };
  tools: Record<string, { expected?: string; observed: string[] }>;
  jobs: Record<string, { result: string; metadata: Record<string, string> }>;
}

/** Every refusal and every acceptance is compared as data, never as a thrown shape. */
interface Observation {
  readonly result: VerifyLocalResult | null;
  readonly message: string;
  readonly evidenceFailure: boolean;
}

aroundEach((runTest) => withAuthorityHostTestScope(runTest));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: root, encoding: 'utf8' }).trim();
}

function projectConfig(localPolicy: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    project_type: 'runtime-host',
    authority_enforcement: { mode: 'cli-only' },
    profile: 'tier3',
    ci_economy: {
      local_evidence: {
        max_age_hours: 24,
        required_jobs: REQUIRED_JOBS,
        allowed_platforms: ['darwin/arm64'],
        ...localPolicy,
      },
    },
  };
}

function fixture(options: { omitEngines?: boolean; localPolicy?: Record<string, unknown> } = {}): {
  root: string;
  manifestPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'devai-local-evidence-boundaries-'));
  roots.push(root);
  put(root, 'package.json', {
    name: 'boundary-fixture',
    ...(options.omitEngines === true ? {} : { engines: { node: '>=24' } }),
  });
  put(root, '.devai/config/project.json', projectConfig(options.localPolicy));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Boundary Fixture']);
  git(root, ['config', 'user.email', 'boundary@example.invalid']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/example/boundary-fixture.git']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  const jobDirs = Object.fromEntries(
    REQUIRED_JOBS.map((job) => {
      const path = `.artifacts/${job}`;
      put(
        root,
        `${path}/metadata.txt`,
        `job=${job}\nplatform=darwin/arm64\nnode=${process.version}\n`,
      );
      put(root, `${path}/result.txt`, 'success\n');
      return [job, path];
    }),
  );
  const collected = collectLocalEvidence({ repoRoot: root, jobDirs, now: NOW });
  return { root, manifestPath: collected.outputPath };
}

function readManifest(root: string, manifestPath: string): MutableManifest {
  return JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as MutableManifest;
}

function observe(inputs: VerifyLocalInputs): Observation {
  try {
    return { result: verifyLocalEvidence(inputs), message: '', evidenceFailure: false };
  } catch (error) {
    return {
      result: null,
      message: error instanceof Error ? error.message : String(error),
      evidenceFailure: (error as { evidenceFailure?: unknown }).evidenceFailure === true,
    };
  }
}

function gateInputs(
  root: string,
  manifestPath: string,
  overrides: {
    actor?: string;
    trustedActors?: readonly string[] | undefined;
    changedFiles?: readonly string[] | null;
    now?: number;
    manifestPath?: string;
  } = {},
): VerifyLocalInputs {
  return {
    repoRoot: root,
    mode: 'gate',
    now: overrides.now ?? NOW.getTime(),
    ...(overrides.manifestPath === undefined ? {} : { manifestPath: overrides.manifestPath }),
    ...(overrides.trustedActors === undefined ? {} : { trustedActors: overrides.trustedActors }),
    context: {
      eventName: 'push',
      ref: 'refs/heads/main',
      actor: overrides.actor ?? 'aarusso',
      headMessage: `fixture\n\nLocal-CI-Evidence: ${manifestPath}`,
      changedFiles: overrides.changedFiles === undefined ? [] : overrides.changedFiles,
    },
  };
}

function trustedGate(root: string, manifestPath: string): VerifyLocalInputs {
  return gateInputs(root, manifestPath, { trustedActors: ['aarusso'] });
}

describe('local evidence verification refusal diagnostics', () => {
  it('states the accepted evidence outcome exactly, without paraphrase', () => {
    const { root, manifestPath } = fixture();
    const observed = observe(trustedGate(root, manifestPath));
    expect(observed.message).toBe('');
    expect(observed.result).toEqual({
      evidenceMode: true,
      outcome: 'evidence-valid',
      message: 'trusted local CI evidence is valid; heavy jobs may skip',
      manifestPath,
    });
  });

  it('refuses a caller-selected manifest path in gate mode before reading any manifest', () => {
    const { root, manifestPath } = fixture();
    const observed = observe(gateInputs(root, manifestPath, { manifestPath }));
    expect(observed.message).toBe('caller-selected manifest paths are forbidden in gate mode');
    expect(observed.evidenceFailure).toBe(true);
    expect(observed.result).toBeNull();
  });

  it('reports no manifest path and the pull-request refusal when no policy is declared', () => {
    const { root, manifestPath } = fixture();
    put(root, '.devai/config/project.json', {
      schemaVersion: '1.0.0',
      project_type: 'runtime-host',
    });
    const observed = observe({
      repoRoot: root,
      mode: 'gate',
      now: NOW.getTime(),
      context: {
        eventName: 'pull_request',
        ref: 'refs/heads/main',
        actor: 'aarusso',
        headMessage: `fixture\n\nLocal-CI-Evidence: ${manifestPath}`,
        changedFiles: [],
      },
    });
    expect(observed.message).toBe('');
    expect(observed.result).toEqual({
      evidenceMode: false,
      outcome: 'pr-disabled',
      message: 'pull request evidence mode is disabled; normal CI is required',
      manifestPath: '',
    });
  });
});

describe('local evidence clock and subject identity', () => {
  it('refuses a schema-shaped leap-second generatedAt that no clock can parse', () => {
    const { root, manifestPath } = fixture();
    const manifest = readManifest(root, manifestPath);
    manifest.generatedAt = '2026-08-22T23:59:60.000Z';
    put(root, manifestPath, manifest);
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(true);
    const observed = observe(trustedGate(root, manifestPath));
    expect(observed.message).toBe('manifest generatedAt is not a valid timestamp');
    expect(observed.evidenceFailure).toBe(true);
  });

  it('refuses a tree identity claimed under the wrong hash algorithm', () => {
    const { root, manifestPath } = fixture();
    const manifest = readManifest(root, manifestPath);
    expect(manifest.subject.tree.algorithm).toBe('sha1');
    manifest.subject.tree.algorithm = 'sha256';
    put(root, manifestPath, manifest);
    const observed = observe(trustedGate(root, manifestPath));
    expect(observed.message).toBe('manifest tree subject mismatch');
    expect(observed.evidenceFailure).toBe(true);
  });

  it('accepts the current commit as its own subject without consulting a trailer parent', () => {
    const { root, manifestPath } = fixture();
    const manifest = readManifest(root, manifestPath);
    // A commit that adds the manifest and a commit that removes it again:
    // HEAD then changes exactly the declared manifest against a single
    // parent, so the trailer-parent subject is derivable — and wrong.
    git(root, ['add', '--', manifestPath]);
    git(root, ['commit', '-qm', 'add evidence']);
    git(root, ['rm', '-q', '--', manifestPath]);
    git(root, ['commit', '-qm', 'remove evidence']);
    const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const parent = git(root, ['rev-parse', '--verify', 'HEAD^^{commit}']);
    expect(git(root, ['rev-parse', '--verify', 'HEAD^{tree}'])).toBe(manifest.subject.tree.value);
    expect(head).not.toBe(parent);
    manifest.subject.commitSha = head;
    put(root, manifestPath, manifest);
    const observed = observe(trustedGate(root, manifestPath));
    expect(observed.message).toBe('');
    expect(observed.result?.outcome).toBe('evidence-valid');
  });
});

describe('local evidence tool, actor and changed-file identity', () => {
  it('accepts evidence from a repository that declares no Node engine range', () => {
    const { root, manifestPath } = fixture({ omitEngines: true });
    expect(readManifest(root, manifestPath).tools['node']).toEqual({
      expected: '',
      observed: [process.version],
    });
    const observed = observe(trustedGate(root, manifestPath));
    expect(observed.message).toBe('');
    expect(observed.result?.outcome).toBe('evidence-valid');
  });

  it('refuses evidence mode when no trusted-actor allowlist is supplied at all', () => {
    const { root, manifestPath } = fixture();
    const observed = observe(gateInputs(root, manifestPath, { trustedActors: undefined }));
    expect(observed.message).toBe('evidence mode requires a trusted-actor allowlist');
    expect(observed.evidenceFailure).toBe(true);
  });

  it('names every prohibited changed file, in order, in a single refusal', () => {
    const { root, manifestPath } = fixture();
    const observed = observe(
      gateInputs(root, manifestPath, {
        trustedActors: ['aarusso'],
        changedFiles: [
          '.github/workflows/ci.yml',
          'src/ordinary.ts',
          'law/policy/mutation-strength.json',
        ],
      }),
    );
    expect(observed.message).toBe(
      'evidence mode cannot be used with policy-sensitive file changes: .github/workflows/ci.yml, law/policy/mutation-strength.json',
    );
    expect(observed.evidenceFailure).toBe(true);
  });
});
