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
import {
  normalizeActorList,
  parseTrailerPath,
  verifyLocalEvidence,
} from '../../src/local-evidence/verify.js';

const REQUIRED_JOBS = ['unit', 'api', 'db-postgis', 'browser-e2e', 'mutation', 'coverage'] as const;
const roots: string[] = [];

interface MutableManifest extends Record<string, unknown> {
  generatedAt: string;
  expiresAt: string;
  subject: { repository: string; commitSha: string; tree: { value: string } };
  sourceHash: { value: string; fileCount: number };
  policy: { maxAgeHours: number; requiredJobs: string[]; allowedPlatforms: string[] };
  tools: Record<string, { observed: string[] }>;
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

function fixture(
  options: {
    packageFields?: Record<string, unknown>;
    localPolicy?: Record<string, unknown>;
    metadata?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'devai-native-local-evidence-'));
  roots.push(root);
  put(root, 'package.json', {
    name: 'teat-fixture',
    engines: { node: '>=24' },
    ...options.packageFields,
  });
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
        ...options.localPolicy,
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
        `job=${job}\nplatform=darwin/arm64\nnode=${process.version}\n${options.metadata ?? ''}`,
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

describe('local evidence independent trust and freshness checks', () => {
  const changes: Array<[string, (manifest: MutableManifest) => void, RegExp]> = [
    [
      'future timestamp',
      (m) => {
        m.generatedAt = '2026-08-22T12:05:00.001Z';
      },
      /in the future/u,
    ],
    [
      'forged expiry',
      (m) => {
        m.expiresAt = '2026-08-23T12:00:00.001Z';
      },
      /expiresAt does not equal/u,
    ],
    [
      'missing policy job',
      (m) => {
        m.policy.requiredJobs = m.policy.requiredJobs.filter((j) => j !== 'unit');
      },
      /missing declared job: unit/u,
    ],
    [
      'broader platform policy',
      (m) => {
        m.policy.allowedPlatforms.push('linux/amd64');
      },
      /allows undeclared platform/u,
    ],
    [
      'different repository',
      (m) => {
        m.subject.repository = 'other/repository';
      },
      /repository subject mismatch/u,
    ],
    [
      'changed source hash',
      (m) => {
        m.sourceHash.value = '0'.repeat(64);
      },
      /source hash mismatch/u,
    ],
    [
      'changed source population',
      (m) => {
        m.sourceHash.fileCount += 1;
      },
      /source file count mismatch/u,
    ],
    [
      'absent Node identity',
      (m) => {
        delete m.tools.node;
      },
      /node versions must all use major 24/u,
    ],
    [
      'mixed Node identities',
      (m) => {
        m.tools.node = { observed: [process.version, 'v23.0.0'] };
      },
      /node versions must all use major 24/u,
    ],
    [
      'misnamed job metadata',
      (m) => {
        const unit = m.jobs.unit;
        if (unit === undefined) throw new Error('fixture unit missing');
        unit.metadata.job = 'coverage';
      },
      /job unit metadata does not match/u,
    ],
    [
      'missing job platform',
      (m) => {
        const unit = m.jobs.unit;
        if (unit === undefined) throw new Error('fixture unit missing');
        delete unit.metadata.platform;
      },
      /schema validation:.*platform/u,
    ],
  ];
  it.each(changes)('refuses %s independently', (_name, mutate, diagnostic) => {
    const { root, now, manifestPath } = fixture();
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as MutableManifest;
    mutate(manifest);
    put(root, manifestPath, manifest);
    expect(() => gate(root, manifestPath, now)).toThrow(diagnostic);
  });

  it('accepts the exact maximum age and refuses one millisecond beyond it', () => {
    const { root, now, manifestPath } = fixture();
    const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(gate(root, manifestPath, expiry).outcome).toBe('evidence-valid');
    expect(() => gate(root, manifestPath, new Date(expiry.getTime() + 1))).toThrow(/stale/u);
  });

  it('accepts exactly five minutes of clock skew', () => {
    const { root, now, manifestPath } = fixture();
    expect(gate(root, manifestPath, new Date(now.getTime() - 5 * 60 * 1000)).outcome).toBe(
      'evidence-valid',
    );
  });

  it.each(['{invalid', '{}'])('refuses malformed manifest content %s', (content) => {
    const { root, now, manifestPath } = fixture();
    put(root, manifestPath, content);
    expect(() => gate(root, manifestPath, now)).toThrow(/not valid JSON|schema validation/u);
  });

  it.each([
    ['absent actor', '', ['aarusso'], /requires a GitHub actor/u],
    ['empty allowlist', 'aarusso', [], /requires a trusted-actor allowlist/u],
    ['wildcard allowlist', 'aarusso', ['aarusso', 'team-*'], /wildcards are forbidden/u],
  ] as const)('refuses %s even with valid evidence', (_name, actor, trustedActors, diagnostic) => {
    const { root, now, manifestPath } = fixture();
    expect(() =>
      verifyLocalEvidence({
        repoRoot: root,
        mode: 'gate',
        now: now.getTime(),
        trustedActors,
        context: {
          eventName: 'push',
          ref: 'refs/heads/main',
          actor,
          headMessage: `Local-CI-Evidence: ${manifestPath}`,
          changedFiles: [],
        },
      }),
    ).toThrow(diagnostic);
  });

  it('refuses unavailable changed-file evidence', () => {
    const { root, now, manifestPath } = fixture();
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
          changedFiles: null,
        },
      }),
    ).toThrow(/unable to determine changed files/u);
  });

  it.each(['pull_request', 'pull_request_target'])(
    'keeps full CI for %s even with a claim',
    (eventName) => {
      const { root, now, manifestPath } = fixture();
      expect(
        verifyLocalEvidence({
          repoRoot: root,
          mode: 'gate',
          now: now.getTime(),
          context: {
            eventName,
            ref: 'refs/heads/main',
            actor: '',
            headMessage: `Local-CI-Evidence: ${manifestPath}`,
            changedFiles: null,
          },
        }),
      ).toMatchObject({ evidenceMode: false, outcome: 'pr-disabled' });
    },
  );

  it.each([
    ['push', 'refs/heads/feature', true],
    ['workflow_dispatch', 'refs/heads/main', true],
    ['push', 'refs/heads/main', false],
  ] as const)('keeps full CI for event %s ref %s claim %s', (eventName, ref, claim) => {
    const { root, now, manifestPath } = fixture();
    expect(
      verifyLocalEvidence({
        repoRoot: root,
        mode: 'gate',
        now: now.getTime(),
        context: {
          eventName,
          ref,
          actor: '',
          headMessage: claim ? `Local-CI-Evidence: ${manifestPath}` : 'ordinary commit',
          changedFiles: null,
        },
      }),
    ).toMatchObject({ evidenceMode: false, outcome: 'no-claim' });
  });
});

describe('local evidence claim and actor parsing', () => {
  it('normalizes separators and duplicate named actors without empty entries', () => {
    expect(normalizeActorList('  alice,,;\n bob;alice\tcarol  ')).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
    expect(normalizeActorList(' ,;\n ')).toEqual([]);
  });
  it.each(['team-*', '*alice', 'al*ice'])('refuses wildcard actor %s', (actor) => {
    expect(() => normalizeActorList(actor)).toThrow(/wildcards/u);
  });
  it.each([
    'prefix Local-CI-Evidence: proof.json',
    'Local-CI-Evidence: proof.json extra',
    'no evidence',
  ])('does not accept malformed claim %s', (message) => {
    expect(parseTrailerPath(message)).toBe('');
  });
  it('extracts a standalone trailer with surrounding commit text', () => {
    expect(
      parseTrailerPath('subject\n\nLocal-CI-Evidence:   proof.json  \nOther-Trailer: value'),
    ).toBe('proof.json');
  });
});

describe('local evidence required tool identities', () => {
  it.each([{ observed: [] }, { observed: ['9.14.0'] }, { observed: ['9.15.0', '9.14.0'] }])(
    'rejects package-manager observations $observed',
    ({ observed }) => {
      const { root, now, manifestPath } = fixture({
        packageFields: { packageManager: 'pnpm@9.15.0' },
        metadata: 'pnpm=9.15.0\n',
      });
      const manifest = JSON.parse(
        readFileSync(join(root, manifestPath), 'utf8'),
      ) as MutableManifest;
      manifest.tools.pnpm = { observed };
      put(root, manifestPath, manifest);
      expect(() => gate(root, manifestPath, now)).toThrow(/pnpm versions must all equal 9.15.0/u);
    },
  );
  it('accepts exact package-manager and required Docker observations', () => {
    const { root, now, manifestPath } = fixture({
      packageFields: { packageManager: 'pnpm@9.15.0' },
      localPolicy: { require_docker: true },
      metadata: 'pnpm=9.15.0\ndocker=29.5.2\n',
    });
    expect(gate(root, manifestPath, now).outcome).toBe('evidence-valid');
  });
  it('refuses missing Docker identity when required', () => {
    const { root, now, manifestPath } = fixture({
      localPolicy: { require_docker: true },
      metadata: 'docker=29.5.2\n',
    });
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as MutableManifest;
    delete manifest.tools.docker;
    put(root, manifestPath, manifest);
    expect(() => gate(root, manifestPath, now)).toThrow(/must record docker version evidence/u);
  });
});
