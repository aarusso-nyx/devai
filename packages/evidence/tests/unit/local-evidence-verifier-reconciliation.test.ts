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
 * How `devai evidence local verify` reconciles a claim with the repository it
 * is claimed against, where the native contract and refusal-diagnostic suites
 * stop: the declared policy's authority over the manifest's own carried copy,
 * the joint schema diagnostic for malformed or wrong-producer evidence, the
 * manifest path a trailer-parent subject is bound to, worktree states the
 * subject is derived from, and the roster/mode identities that decide whether
 * a claim is even reachable.
 */

const NOW = new Date('2026-09-01T09:00:00.000Z');
const roots: string[] = [];

interface MutableManifest extends Record<string, unknown> {
  generatedAt: string;
  expiresAt: string;
  subject: { repository: string; commitSha: string; tree: { algorithm: string; value: string } };
  sourceHash: { algorithm: string; value: string; fileCount: number };
  policy: { maxAgeHours: number; requiredJobs: string[]; allowedPlatforms: string[] };
  tools: Record<string, { expected?: string; observed: string[] }>;
  platforms: string[];
  jobs: Record<string, { result: string; metadata: Record<string, string> }>;
}

/** Refusals and acceptances are both compared as data, never as a thrown shape. */
interface Observation {
  readonly result: VerifyLocalResult | null;
  readonly message: string;
  readonly evidenceFailure: boolean;
}

/**
 * A complete, schema-shaped GitHub Actions identity block. Only `testedTree`
 * is varied, so a refusal can only come from the varied member.
 */
const ACTIONS_RUN: Record<string, unknown> = {
  repository: 'example/reconciliation-fixture',
  workflowRef: 'example/reconciliation-fixture/.github/workflows/ci.yml@refs/pull/1/merge',
  eventName: 'pull_request',
  runId: '1',
  runAttempt: 1,
  actor: 'aarusso',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  mergeBaseSha: 'b'.repeat(40),
  testedCommitSha: 'c'.repeat(40),
  testedTree: { algorithm: 'sha1', value: 'd'.repeat(40) },
  digests: {
    workflowPolicySha256: '1'.repeat(64),
    lockfileSha256: '2'.repeat(64),
    toolchainContractSha256: '3'.repeat(64),
    testContractSha256: '4'.repeat(64),
    serviceContractSha256: '5'.repeat(64),
  },
};

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

function headCommit(root: string): string {
  return git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
}

interface Fixture {
  readonly root: string;
  readonly manifestPath: string;
  /** The commit the collected manifest names as its exact subject. */
  readonly subjectCommit: string;
}

function fixture(
  options: {
    requiredJobs?: readonly string[];
    allowedPlatforms?: readonly string[];
    now?: Date;
  } = {},
): Fixture {
  const requiredJobs = options.requiredJobs ?? ['unit', 'coverage'];
  const allowedPlatforms = options.allowedPlatforms ?? ['darwin/arm64'];
  const root = mkdtempSync(join(tmpdir(), 'devai-local-evidence-reconciliation-'));
  roots.push(root);
  put(root, 'package.json', { name: 'reconciliation-fixture', engines: { node: '>=24' } });
  put(root, 'src/ordinary.ts', 'export const ordinary = 1;\n');
  put(root, '.devai/config/project.json', {
    schemaVersion: '1.0.0',
    project_type: 'runtime-host',
    authority_enforcement: { mode: 'cli-only' },
    profile: 'tier3',
    ci_economy: {
      local_evidence: {
        max_age_hours: 24,
        required_jobs: requiredJobs,
        allowed_platforms: allowedPlatforms,
      },
    },
  });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Reconciliation Fixture']);
  git(root, ['config', 'user.email', 'reconciliation@example.invalid']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/example/reconciliation-fixture.git']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  const jobDirs = Object.fromEntries(
    requiredJobs.map((job) => {
      const path = `.artifacts/${job}`;
      put(
        root,
        `${path}/metadata.txt`,
        `job=${job}\nplatform=${allowedPlatforms[0] ?? ''}\nnode=${process.version}\n`,
      );
      put(root, `${path}/result.txt`, 'success\n');
      return [job, path];
    }),
  );
  const collected = collectLocalEvidence({ repoRoot: root, jobDirs, now: options.now ?? NOW });
  return { root, manifestPath: collected.outputPath, subjectCommit: headCommit(root) };
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

function claimInputs(
  root: string,
  manifestPath: string,
  overrides: {
    mode?: VerifyLocalInputs['mode'];
    actor?: string;
    trustedActors?: readonly string[];
    changedFiles?: readonly string[] | null;
    manifestPath?: string;
    /** Omit `now` entirely to exercise the verifier's own clock. */
    useDefaultClock?: boolean;
  } = {},
): VerifyLocalInputs {
  return {
    repoRoot: root,
    mode: overrides.mode ?? 'gate',
    ...(overrides.useDefaultClock === true ? {} : { now: NOW.getTime() }),
    ...(overrides.manifestPath === undefined ? {} : { manifestPath: overrides.manifestPath }),
    trustedActors: overrides.trustedActors ?? ['aarusso'],
    context: {
      eventName: 'push',
      ref: 'refs/heads/main',
      actor: overrides.actor ?? 'aarusso',
      headMessage: `fixture\n\nLocal-CI-Evidence: ${manifestPath}`,
      changedFiles: overrides.changedFiles === undefined ? [] : overrides.changedFiles,
    },
  };
}

function strictInputs(root: string, manifestPath: string): VerifyLocalInputs {
  return {
    repoRoot: root,
    mode: 'strict',
    now: NOW.getTime(),
    manifestPath,
    context: {
      eventName: 'workflow_dispatch',
      ref: '',
      actor: '',
      headMessage: '',
      changedFiles: null,
    },
  };
}

describe('local evidence malformed and wrong-producer manifests', () => {
  it.each([
    ['truncated mid-write', (bytes: string) => bytes.slice(0, Math.floor(bytes.length / 3))],
    ['empty', () => ''],
    ['whitespace only', () => '\n \n'],
  ])('refuses a %s manifest as unparsed evidence, preserving its bytes', (_name, damage) => {
    const { root, manifestPath } = fixture();
    const damaged = damage(readFileSync(join(root, manifestPath), 'utf8'));
    put(root, manifestPath, damaged);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toMatch(/^evidence manifest is not valid JSON: \S/u);
    expect(observed.evidenceFailure).toBe(true);
    expect(observed.result).toBeNull();
    expect(readFileSync(join(root, manifestPath), 'utf8')).toBe(damaged);
  });

  it('refuses a manifest path that exists but is not a readable file', () => {
    const { root, manifestPath } = fixture();
    rmSync(join(root, manifestPath));
    mkdirSync(join(root, manifestPath), { recursive: true });
    const observed = observe(claimInputs(root, manifestPath));
    // An unreadable path is never mistaken for an absent claim: it refuses
    // through the parse diagnostic rather than falling back to normal CI.
    expect(observed.message).toMatch(/^evidence manifest is not valid JSON: \S/u);
    expect(observed.evidenceFailure).toBe(true);
    expect(observed.result).toBeNull();
  });

  it('reports every schema error of a malformed run identity in one joined diagnostic', () => {
    const { root, manifestPath } = fixture();
    const manifest = readManifest(root, manifestPath);
    manifest['origin'] = 'actions-run';
    manifest['actionsRun'] = {
      ...ACTIONS_RUN,
      // A sha1-declared tree carrying a sha256-length value satisfies neither
      // arm of the tree identity, so the union reports both arms and itself.
      testedTree: { algorithm: 'sha1', value: 'd'.repeat(64) },
    };
    put(root, manifestPath, manifest);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe(
      'evidence manifest fails schema validation: ' +
        '/actionsRun/testedTree/value must match pattern "^[a-f0-9]{40}$"; ' +
        '/actionsRun/testedTree/algorithm must be equal to constant; ' +
        '/actionsRun/testedTree must match exactly one schema in oneOf',
    );
    expect(observed.evidenceFailure).toBe(true);
  });

  it('refuses a local manifest that carries a GitHub Actions run identity', () => {
    const { root, manifestPath } = fixture();
    const manifest = readManifest(root, manifestPath);
    manifest['actionsRun'] = ACTIONS_RUN;
    put(root, manifestPath, manifest);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe('evidence manifest fails schema validation:  must NOT be valid');
    expect(observed.evidenceFailure).toBe(true);
  });
});

describe('local evidence declared policy authority', () => {
  it('accepts a manifest whose carried policy is strictly narrower than the declared one', () => {
    const { root, manifestPath } = fixture({
      allowedPlatforms: ['darwin/arm64', 'linux/amd64'],
    });
    const manifest = readManifest(root, manifestPath);
    expect(manifest.policy).toEqual({
      maxAgeHours: 24,
      requiredJobs: ['unit', 'coverage'],
      allowedPlatforms: ['darwin/arm64', 'linux/amd64'],
    });
    manifest.policy.maxAgeHours = 1;
    manifest.expiresAt = new Date(Date.parse(manifest.generatedAt) + 60 * 60 * 1000).toISOString();
    manifest.policy.allowedPlatforms = ['darwin/arm64'];
    manifest.policy.requiredJobs = ['unit', 'coverage', 'mutation'];
    put(root, manifestPath, manifest);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe('');
    expect(observed.result?.outcome).toBe('evidence-valid');
  });

  it('enforces the declared job roster, not the extra jobs a manifest claims to require', () => {
    const { root, manifestPath } = fixture();
    const manifest = readManifest(root, manifestPath);
    // The manifest names a job it never collected. The declared policy still
    // selects what is enforced, so this can only ever make a manifest look
    // stricter than it is — it can never excuse a declared job.
    manifest.policy.requiredJobs = ['unit', 'coverage', 'never-collected'];
    put(root, manifestPath, manifest);
    expect(Object.keys(manifest.jobs).sort()).toEqual(['coverage', 'unit']);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe('');
    expect(observed.result?.outcome).toBe('evidence-valid');
  });

  it('refuses a declared job the manifest never carried, once the claim narrows', () => {
    const { root, manifestPath } = fixture();
    const manifest = readManifest(root, manifestPath);
    manifest.jobs = Object.fromEntries(
      Object.entries(manifest.jobs).filter(([name]) => name !== 'coverage'),
    );
    put(root, manifestPath, manifest);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe('manifest missing required job: coverage');
    expect(observed.evidenceFailure).toBe(true);
  });
});

describe('local evidence required job lookup identity', () => {
  it('accepts a successful own job even when its name is a prototype member', () => {
    const { root, manifestPath } = fixture({ requiredJobs: ['unit', 'constructor'] });
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe('');
    expect(observed.result?.outcome).toBe('evidence-valid');
  });

  it('rejects an unsuccessful job through the manifest schema before job reconciliation', () => {
    const { root, manifestPath } = fixture();
    const manifest = readManifest(root, manifestPath);
    const unit = manifest.jobs['unit'];
    if (unit === undefined) throw new Error('fixture unit job missing');
    unit.result = 'failure';
    put(root, manifestPath, manifest);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.result).toBeNull();
    expect(observed.evidenceFailure).toBe(true);
    expect(observed.message).toBe(
      'evidence manifest fails schema validation: /jobs/unit/result must be equal to one of the allowed values',
    );
  });

  it('refuses a required job absent from the manifest even under a prototype-member name', () => {
    // `constructor` is a legal declared job name. The manifest below carries
    // `unit` only, so the claim is incomplete and must be refused as evidence.
    //
    const { root, manifestPath } = fixture({ requiredJobs: ['unit', 'constructor'] });
    const manifest = readManifest(root, manifestPath);
    expect(Object.keys(manifest.jobs).sort()).toEqual(['constructor', 'unit']);
    manifest.jobs = Object.fromEntries(
      Object.entries(manifest.jobs).filter(([name]) => name !== 'constructor'),
    );
    put(root, manifestPath, manifest);
    expect(Object.hasOwn(readManifest(root, manifestPath).jobs, 'constructor')).toBe(false);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.result).toBeNull();
    expect(observed.evidenceFailure).toBe(true);
    expect(observed.message).toBe('manifest missing required job: constructor');
  });
});

describe('local evidence trusted roster identity', () => {
  it('treats an empty allowlist entry as neither a wildcard nor a trusted actor', () => {
    const { root, manifestPath } = fixture();
    const withEmptyEntry = observe(
      claimInputs(root, manifestPath, { trustedActors: ['', 'aarusso'] }),
    );
    expect(withEmptyEntry.message).toBe('');
    expect(withEmptyEntry.result?.outcome).toBe('evidence-valid');
    const onlyEmptyEntries = observe(claimInputs(root, manifestPath, { trustedActors: ['', ''] }));
    expect(onlyEmptyEntries.message).toBe('actor is not trusted for local evidence: aarusso');
    expect(onlyEmptyEntries.evidenceFailure).toBe(true);
  });

  it('compares the actor to the roster exactly, without case folding or trimming', () => {
    const { root, manifestPath } = fixture();
    for (const actor of ['AArusso', 'aarusso ', ' aarusso']) {
      const observed = observe(claimInputs(root, manifestPath, { actor }));
      expect(observed.message, actor).toBe(`actor is not trusted for local evidence: ${actor}`);
      expect(observed.evidenceFailure, actor).toBe(true);
    }
  });
});

describe('local evidence subject derivation under worktree drift', () => {
  it('refuses to derive a subject from a dirty tracked worktree', () => {
    const { root, manifestPath } = fixture();
    put(root, 'src/ordinary.ts', 'export const ordinary = 2;\n');
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe('local evidence requires a clean tracked index and worktree');
    expect(observed.result).toBeNull();
  });

  it('keeps evidence valid when only untracked files appear beside the tracked tree', () => {
    const { root, manifestPath } = fixture();
    // The source hash is defined over git-tracked files, and the subject over
    // the tracked index/worktree: an untracked file is outside both by design.
    put(root, 'src/scratch-note.txt', 'not tracked\n');
    expect(git(root, ['status', '--porcelain=v1', '--untracked-files=no'])).toBe('');
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe('');
    expect(observed.result?.outcome).toBe('evidence-valid');
  });

  it('refuses a trailer commit that carries more than the declared manifest', () => {
    const { root, manifestPath, subjectCommit } = fixture();
    put(root, 'docs/notes.md', 'an unrelated change\n');
    git(root, ['add', '--', manifestPath, 'docs/notes.md']);
    git(root, ['commit', '-qm', 'evidence plus an unrelated change']);
    const observed = observe(claimInputs(root, manifestPath));
    expect(observed.message).toBe(
      `manifest commit subject mismatch: expected ${headCommit(root)}, got ${subjectCommit}`,
    );
    expect(observed.evidenceFailure).toBe(true);
  });

  it('binds the trailer-parent subject to the manifest path actually verified', () => {
    const { root, manifestPath, subjectCommit } = fixture();
    git(root, ['add', '--', manifestPath]);
    git(root, ['commit', '-qm', 'local evidence']);
    const trailerCommit = headCommit(root);
    const relocated = 'record/proofs/work/relocated/local-ci.json';
    put(root, relocated, readFileSync(join(root, manifestPath), 'utf8'));
    expect(observe(strictInputs(root, manifestPath)).result?.outcome).toBe('strict-valid');
    const observed = observe(strictInputs(root, relocated));
    expect(observed.message).toBe(
      `manifest commit subject mismatch: expected ${trailerCommit}, got ${subjectCommit}`,
    );
    expect(observed.evidenceFailure).toBe(true);
  });
});

describe('local evidence claim reachability by mode', () => {
  it('grants evidence mode in auto mode on the same trusted main-push claim as gate mode', () => {
    const { root, manifestPath } = fixture();
    const auto = observe(claimInputs(root, manifestPath, { mode: 'auto' }));
    expect(auto.message).toBe('');
    expect(auto.result).toEqual({
      evidenceMode: true,
      outcome: 'evidence-valid',
      message: 'trusted local CI evidence is valid; heavy jobs may skip',
      manifestPath,
    });
    expect(observe(claimInputs(root, manifestPath)).result).toEqual(auto.result);
  });

  it('binds a caller-selected manifest path in auto mode to the committed trailer', () => {
    const { root, manifestPath } = fixture();
    const selected = 'record/proofs/work/local-evidence/other.json';
    const observed = observe(
      claimInputs(root, manifestPath, { mode: 'auto', manifestPath: selected }),
    );
    expect(observed.message).toBe(
      `Local-CI-Evidence trailer must point to ${selected}, got ${manifestPath}`,
    );
    expect(observed.evidenceFailure).toBe(true);
  });

  it('verifies against its own clock when the caller supplies none', () => {
    const { root, manifestPath } = fixture({ now: new Date() });
    const observed = observe(claimInputs(root, manifestPath, { useDefaultClock: true }));
    expect(observed.message).toBe('');
    expect(observed.result?.outcome).toBe('evidence-valid');
  });
});
