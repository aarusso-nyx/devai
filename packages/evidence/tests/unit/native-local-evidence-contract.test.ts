import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import {
  BUILT_IN_FORBIDDEN_PATHS,
  resolveLocalEvidencePolicy,
} from '../../src/local-evidence/config.js';
import { collectLocalEvidence } from '../../src/local-evidence/collect.js';
import { normalizeActorList, verifyLocalEvidence } from '../../src/local-evidence/verify.js';

const REQUIRED_JOBS = ['unit', 'api', 'db-postgis', 'browser-e2e', 'mutation', 'coverage'] as const;
const roots: string[] = [];

interface MutableManifest extends Record<string, unknown> {
  generatedAt: string;
  expiresAt: string;
  subject: { commitSha: string; tree: { value: string } };
  policy: { maxAgeHours: number };
  jobs: Record<string, { result: string; metadata: Record<string, string> }>;
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'devai-native-local-evidence-'));
  roots.push(root);
  put(root, 'package.json', { name: 'teat-fixture', engines: { node: '>=24' } });
  put(root, '.devai/config/project.json', {
    schemaVersion: '1.0.0',
    project_type: 'runtime-host',
    authority_enforcement: { mode: 'cli-only' },
    profile: 'tier3',
    ci_economy: {
      local_evidence: {
        max_age_hours: 24,
        required_jobs: REQUIRED_JOBS,
        allowed_platforms: ['darwin/arm64'],
      },
    },
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Inspector Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'inspector@example.invalid'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/teat-fixture.git'], {
    cwd: root,
  });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
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
  const now = new Date('2026-08-22T12:00:00.000Z');
  const collected = collectLocalEvidence({ repoRoot: root, jobDirs, now });
  return { root, now, manifestPath: collected.outputPath };
}

function gate(root: string, manifestPath: string, now: Date, actor = 'aarusso') {
  return verifyLocalEvidence({
    repoRoot: root,
    mode: 'gate',
    manifestPath: undefined,
    now: now.getTime(),
    trustedActors: [actor],
    context: {
      eventName: 'push',
      ref: 'refs/heads/main',
      actor,
      headMessage: `fixture\n\nLocal-CI-Evidence: ${manifestPath}`,
      changedFiles: [],
    },
  });
}

describe('native local evidence policy', () => {
  it('binds the TEAT job floor, 24-hour age, darwin/arm64, and immutable forbidden paths', () => {
    const { root } = fixture();
    expect(resolveLocalEvidencePolicy(root)).toMatchObject({
      maxAgeHours: 24,
      requiredJobs: REQUIRED_JOBS,
      allowedPlatforms: ['darwin/arm64'],
    });
    expect(BUILT_IN_FORBIDDEN_PATHS).toEqual(
      expect.arrayContaining(['.github/workflows/', '.devai/config/', 'law/policy/']),
    );
  });

  it('accepts only complete exact-subject evidence from a named trusted actor', () => {
    const { root, now, manifestPath } = fixture();
    expect(gate(root, manifestPath, now)).toMatchObject({
      evidenceMode: true,
      outcome: 'evidence-valid',
    });
    expect(() =>
      verifyLocalEvidence({
        repoRoot: root,
        mode: 'gate',
        now: now.getTime(),
        trustedActors: ['different-actor'],
        context: {
          eventName: 'push',
          ref: 'refs/heads/main',
          actor: 'aarusso',
          headMessage: `Local-CI-Evidence: ${manifestPath}`,
          changedFiles: [],
        },
      }),
    ).toThrow(/not trusted/u);
    expect(() => normalizeActorList('*')).toThrow(/wildcard|named actor/u);
  });

  it('rejects stale, incomplete, failed, platform-, commit-, tree-, and policy-mismatched receipts', () => {
    const { root, now, manifestPath } = fixture();
    const absolute = join(root, manifestPath);
    const original = JSON.parse(readFileSync(absolute, 'utf8')) as MutableManifest;
    const cases: Array<readonly [string, (manifest: MutableManifest) => void, RegExp]> = [
      [
        'stale',
        (manifest) => {
          manifest.generatedAt = '2026-08-20T00:00:00.000Z';
          manifest.expiresAt = '2026-08-21T00:00:00.000Z';
        },
        /stale|expired/u,
      ],
      [
        'incomplete',
        (manifest) => {
          delete manifest.jobs.coverage;
        },
        /missing required job/u,
      ],
      [
        'failed',
        (manifest) => {
          const unit = manifest.jobs['unit'];
          if (unit === undefined) throw new Error('fixture unit job missing');
          unit.result = 'failed';
        },
        /schema validation|did not succeed/u,
      ],
      [
        'platform',
        (manifest) => {
          const unit = manifest.jobs['unit'];
          if (unit === undefined) throw new Error('fixture unit job missing');
          unit.metadata['platform'] = 'linux/amd64';
        },
        /disallowed platform/u,
      ],
      [
        'commit',
        (manifest) => {
          manifest.subject.commitSha = 'a'.repeat(40);
        },
        /commit subject mismatch/u,
      ],
      [
        'tree',
        (manifest) => {
          manifest.subject.tree.value = 'b'.repeat(40);
        },
        /tree subject mismatch/u,
      ],
      [
        'policy',
        (manifest) => {
          manifest.policy.maxAgeHours = 25;
        },
        /exceeds declared/u,
      ],
    ];
    for (const [name, mutate, diagnostic] of cases) {
      const candidate = structuredClone(original);
      mutate(candidate);
      writeFileSync(absolute, `${JSON.stringify(candidate, null, 2)}\n`);
      expect(() => gate(root, manifestPath, now), name).toThrow(diagnostic);
    }
  });

  it('rejects absent receipts and every built-in policy-path mutation', () => {
    const { root, now, manifestPath } = fixture();
    expect(() =>
      verifyLocalEvidence({
        repoRoot: root,
        mode: 'strict',
        manifestPath: 'record/proofs/work/local-evidence/absent.json',
        now: now.getTime(),
        context: { eventName: '', ref: '', actor: '', headMessage: '', changedFiles: [] },
      }),
    ).toThrow(/missing evidence manifest/u);
    for (const changed of [
      '.github/workflows/ci.yml',
      '.devai/config/project.json',
      'law/policy/mutation-strength.json',
    ]) {
      expect(() =>
        verifyLocalEvidence({
          repoRoot: root,
          mode: 'gate',
          now: now.getTime(),
          trustedActors: ['aarusso'],
          context: {
            eventName: 'push',
            ref: 'refs/heads/main',
            actor: 'aarusso',
            headMessage: `Local-CI-Evidence: ${manifestPath}`,
            changedFiles: [changed],
          },
        }),
      ).toThrow(/policy-sensitive/u);
    }
  });
});
