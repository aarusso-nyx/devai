// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-018
// Inspector acceptance for ADR-CFG-0002 (owned configuration projection): the
// adopter-policy bind owns exactly the project.json rows of the ownership matrix
// documented in docs/adopters/install.md. An owned key absent from the source is
// retired (the schema-required /project_type keeps its current value instead), an
// owned key the source declares is replaced as a whole, and every key
// the matrix does not name is an adopter declaration that survives every bind.
// The 1.4.5 reproduction from issue #68 is IA-001; declaration survival is IA-002.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { resolveCanonicalPolicyContent } from '../../../skills/src/bootstrap/index.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { doctor } from '../../src/commands/doctor.js';
import { initBind } from '../../src/commands/init/index.js';
import { resolveAdopterPolicyMaterialization } from '../../src/services/adopter-policy.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

type JsonObject = Record<string, unknown>;

const FRAMEWORK_VERSION = '2.3.1';
const SOURCE = 'law/policy/devai-adoption.json';
const BINDING = '.devai/config/adopter-policy-binding.json';
const PROJECT = '.devai/config/project.json';
const CONFIG = '.devai/config';
const BOUND_FILES = [
  PROJECT,
  '.devai/config/domains.json',
  '.devai/config/thresholds.json',
  '.devai/config/scorecard-na.json',
  '.devai/config/glob-guards.json',
  BINDING,
] as const;

const LOCAL_EVIDENCE = {
  manifest_path: '.ci/evidence/local-ci.json',
  max_age_hours: 24,
  required_jobs: ['unit'],
  allowed_platforms: ['linux/amd64'],
} as const;

const ATTESTED_RC = {
  profile: 'rc',
  transport: 'protected-tag-v1',
  tag_prefix: 'devai-local-evidence/',
  binding: 'exact-tree',
  required_check: 'verified-local-rc',
  failure_mode: 'fail-closed',
  local_only_nodes: ['test:mutation'],
} as const;

const DOCS_IA = { collapsed_sections: ['theory'], path_overrides: {} } as const;

/** Adopter declarations: keys the ownership matrix does not name. */
const DECLARATIONS = {
  name: 'Fixture Adopter',
  adopted_at: '2026-01-02T03:04:05Z',
  invariant_filters: { include_tags: ['core'], exclude_tags: ['legacy'] },
  feature_flags: { adopter_owned_toggle: true, other_toggle: false },
} as const;

function policy(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.devai-adoption',
    policy_version: '1.0.0',
    project: { project_type: 'framework' },
    ...overrides,
  };
}

function project(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: '1.0.0',
    project_type: 'framework',
    devai_version: FRAMEWORK_VERSION,
    ...overrides,
  };
}

function projected(input: { policy: JsonObject; currentProject: JsonObject }): JsonObject {
  const resolved = resolveAdopterPolicyMaterialization({
    ...input,
    frameworkVersion: FRAMEWORK_VERSION,
  });
  return JSON.parse(resolved.get(PROJECT) ?? 'null') as JsonObject;
}

// ---------------------------------------------------------------------------
// Pure projection: resolveAdopterPolicyMaterialization under the matrix rows.
// ---------------------------------------------------------------------------

describe('owned projection: absent in the source means absent in project.json', () => {
  it('retires /ci_economy when the source no longer declares ci_economy (issue #68)', () => {
    const result = projected({
      policy: policy(),
      currentProject: project({
        ci_economy: { profile: 'gate-staged', local_evidence: LOCAL_EVIDENCE },
      }),
    });

    expect(result).not.toHaveProperty('ci_economy');
    expect(result).toEqual(project());
  });

  it.each([
    {
      row: '/ci_economy/local_evidence',
      source: { profile: 'full', attested_rc: ATTESTED_RC },
      current: { profile: 'full', local_evidence: LOCAL_EVIDENCE, attested_rc: ATTESTED_RC },
    },
    {
      row: '/ci_economy/attested_rc',
      source: { profile: 'full', local_evidence: LOCAL_EVIDENCE },
      current: { profile: 'full', local_evidence: LOCAL_EVIDENCE, attested_rc: ATTESTED_RC },
    },
  ])('retires the nested block $row on its own', ({ source, current }) => {
    const result = projected({
      policy: policy({ ci_economy: source }),
      currentProject: project({ ci_economy: current }),
    });

    expect(result['ci_economy']).toEqual(source);
  });

  it('retires /repo when the source project block no longer declares repo', () => {
    const result = projected({
      policy: policy({ project: { project_type: 'framework', docs: { builder: 'docusaurus' } } }),
      currentProject: project({ repo: { kind: 'library' }, docs: { builder: 'docusaurus' } }),
    });

    expect(result).not.toHaveProperty('repo');
    expect(result['docs']).toEqual({ builder: 'docusaurus' });
  });

  it('retires /docs when the source project block no longer declares docs', () => {
    const result = projected({
      policy: policy({ project: { project_type: 'framework', repo: { kind: 'library' } } }),
      currentProject: project({
        repo: { kind: 'library' },
        docs: { builder: 'docusaurus', output_dir: 'site/build', ia: DOCS_IA },
      }),
    });

    expect(result).not.toHaveProperty('docs');
    expect(result['repo']).toEqual({ kind: 'library' });
  });

  it('retires /docs/ia on its own when the source docs block no longer declares ia', () => {
    const result = projected({
      policy: policy({ project: { project_type: 'framework', docs: { builder: 'docusaurus' } } }),
      currentProject: project({ docs: { builder: 'docusaurus', ia: DOCS_IA } }),
    });

    expect(result['docs']).toEqual({ builder: 'docusaurus' });
  });
});

describe('owned projection: /project_type is schema-required and keeps its current value', () => {
  it('keeps the current /project_type when the source project block does not declare it', () => {
    const result = projected({
      policy: {
        schemaVersion: '1.0.0',
        policy_id: 'fixture.devai-adoption',
        policy_version: '1.0.0',
        project: { repo: { kind: 'library' } },
      },
      currentProject: project({ project_type: 'runtime-host' }),
    });

    expect(result['project_type']).toBe('runtime-host');
    expect(result['repo']).toEqual({ kind: 'library' });
  });

  it('keeps the current /project_type when the source carries no project block at all', () => {
    const result = projected({
      policy: {
        schemaVersion: '1.0.0',
        policy_id: 'fixture.devai-adoption',
        policy_version: '1.0.0',
      },
      currentProject: project({ project_type: 'docs-archive' }),
    });

    expect(result['project_type']).toBe('docs-archive');
  });
});

describe('owned projection: a declared owned key is replaced as a whole', () => {
  it('replaces /docs with the source value and drops scalar members the source omits', () => {
    const result = projected({
      policy: policy({
        project: {
          project_type: 'framework',
          docs: { builder: 'docusaurus', publish_target: 'gh-pages', gh_pages_branch: 'gh-pages' },
        },
      }),
      currentProject: project({
        docs: { builder: 'jekyll', output_dir: 'site/build', custom_domain: 'docs.example' },
      }),
    });

    expect(result['docs']).toEqual({
      builder: 'docusaurus',
      publish_target: 'gh-pages',
      gh_pages_branch: 'gh-pages',
    });
  });

  it('replaces /ci_economy/local_evidence members instead of merging them', () => {
    const result = projected({
      policy: policy({ ci_economy: { local_evidence: { required_jobs: ['lint'] } } }),
      currentProject: project({
        ci_economy: { profile: 'full', local_evidence: LOCAL_EVIDENCE },
      }),
    });

    expect(result['ci_economy']).toEqual({ local_evidence: { required_jobs: ['lint'] } });
  });

  it('replaces /project_type and /repo/kind with the declared source values', () => {
    const result = projected({
      policy: policy({ project: { project_type: 'runtime-host', repo: { kind: 'application' } } }),
      currentProject: project({ repo: { kind: 'library' } }),
    });

    expect(result).toMatchObject({ project_type: 'runtime-host', repo: { kind: 'application' } });
  });

  it('stamps /devai_version on every bind regardless of the current value', () => {
    const result = projected({
      policy: policy(),
      currentProject: project({ devai_version: '1.2.10' }),
    });

    expect(result['devai_version']).toBe(FRAMEWORK_VERSION);
  });
});

describe('owned projection: keys outside the matrix are adopter declarations', () => {
  it('carries every adopter declaration through a projection that retires owned keys', () => {
    const declarations = {
      ...DECLARATIONS,
      profile: 'tier2',
      constitution: { version: '1.0.1', sha256: 'c'.repeat(64) },
      authority_enforcement: { mode: 'cli-only' },
      governance_tracking: {
        adapter: 'github-issues',
        config: '.devai/config/github-issues-tracking.json',
      },
    };
    const current = project({
      ...declarations,
      repo: { kind: 'library' },
      ci_economy: { profile: 'full', attested_rc: ATTESTED_RC },
    });

    const result = projected({ policy: policy(), currentProject: current });

    for (const [key, value] of Object.entries(declarations)) {
      expect(JSON.stringify(result[key]), key).toBe(JSON.stringify(value));
    }
  });
});

// ---------------------------------------------------------------------------
// Command level: init bind --adopter-policy in a temporary adopter repository.
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function readJson(repo: string, path: string): JsonObject {
  return JSON.parse(readFileSync(join(repo, path), 'utf8')) as JsonObject;
}

function snapshot(repo: string): Map<string, string> {
  return new Map(BOUND_FILES.map((path) => [path, readFileSync(join(repo, path), 'utf8')]));
}

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-adopter-policy-retirement');
  definition.register(cli);
  const previous = {
    argv: process.argv,
    exit: process.exit,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() =>
        runWithAuthorityPolicyMaterialization(
          () => ({
            path: '.devai/config/authority-policy.json',
            operation: 'unchanged',
            digest_sha256: 'a'.repeat(64),
          }),
          () => cli.runMatchedCommand(),
        ),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exit = previous.exit;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

function adopterRepo(currentProject: JsonObject = project()): string {
  const repo = mkdtempSync(join(tmpdir(), 'devai-adopter-retirement-'));
  roots.push(repo);
  put(repo, PROJECT, currentProject);
  for (const file of [
    'domains.json',
    'forbidden-actions.json',
    'glob-guards.json',
    'scorecard-na.json',
    'subprocess-effects.json',
    'thresholds.json',
  ] as const) {
    put(repo, `${CONFIG}/${file}`, resolveCanonicalPolicyContent(file));
  }
  return repo;
}

async function bind(repo: string, source: JsonObject) {
  put(repo, SOURCE, source);
  const result = await invoke(initBind, [
    'init-bind',
    '--target',
    repo,
    '--adopter-policy',
    SOURCE,
    '--write',
  ]);
  return {
    ...result,
    output: result.exit === 0 ? (JSON.parse(result.stdout) as JsonObject) : undefined,
  };
}

async function expectBound(repo: string, source: JsonObject) {
  const result = await bind(repo, source);
  expect(result.exit, result.stderr).toBe(0);
  return result;
}

async function doctorChecks(
  repo: string,
): Promise<Map<string, { ok: boolean; info?: JsonObject; errors?: string[] }>> {
  const result = await invoke(doctor, ['doctor', '--repo-root', repo, '--skip', 'docs-governance']);
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ name: string; ok: boolean; info?: JsonObject; errors?: string[] }>;
  };
  return new Map(report.checks.map((check) => [check.name, check]));
}

function retiredKeys(repo: string): unknown {
  return readJson(repo, BINDING)['retired_keys'];
}

describe('IA-001: the 1.4.5 reproduction retires ci_economy and clears doctor', () => {
  it('binds, retires ci_economy, rebinds, and leaves no block, a receipt entry, and a green doctor', async () => {
    const repo = adopterRepo(project({ profile: 'tier1' }));
    const declared = policy({
      ci_economy: {
        profile: 'gate-staged',
        local_evidence: LOCAL_EVIDENCE,
        attested_rc: ATTESTED_RC,
      },
    });
    await expectBound(repo, declared);
    expect(readJson(repo, PROJECT)).toHaveProperty('ci_economy.attested_rc');
    const before = await doctorChecks(repo);
    expect(before.get('trusted-local-rc-boundary')?.ok).toBe(false);

    const retiredSource = policy({ policy_version: '1.1.0' });
    const retirement = await expectBound(repo, retiredSource);

    expect(readJson(repo, PROJECT)).not.toHaveProperty('ci_economy');
    expect(retiredKeys(repo)).toEqual(['/ci_economy']);
    expect(retirement.output?.['receipt']).toMatchObject({ retired_keys: ['/ci_economy'] });
    const after = await doctorChecks(repo);
    expect(after.get('trusted-local-rc-boundary')).toMatchObject({
      ok: true,
      info: { configured: false },
    });
    expect(after.get('policy-materialization-current')?.ok).toBe(true);

    const settled = snapshot(repo);
    const second = await expectBound(repo, retiredSource);
    expect(snapshot(repo)).toEqual(settled);
    expect(second.output?.['receipt']).toMatchObject({ retired_keys: [] });
  });

  it('retires a hand-carried ci_economy block the source never declared', async () => {
    const repo = adopterRepo(
      project({ ci_economy: { profile: 'full', attested_rc: ATTESTED_RC } }),
    );

    await expectBound(repo, policy());

    expect(readJson(repo, PROJECT)).not.toHaveProperty('ci_economy');
    expect(retiredKeys(repo)).toEqual(['/ci_economy']);
  });
});

describe('retired_keys: JSON pointers at the matrix rows', () => {
  it.each([
    {
      label: 'a whole key is reported by its key, not by its nested rows',
      current: {
        ci_economy: { profile: 'full', local_evidence: LOCAL_EVIDENCE, attested_rc: ATTESTED_RC },
      },
      source: {},
      retired: ['/ci_economy'],
    },
    {
      label: 'a nested block retired on its own is reported by its row',
      current: {
        ci_economy: { profile: 'full', local_evidence: LOCAL_EVIDENCE, attested_rc: ATTESTED_RC },
      },
      source: { ci_economy: { profile: 'full', local_evidence: LOCAL_EVIDENCE } },
      retired: ['/ci_economy/attested_rc'],
    },
    {
      label: 'a retired /docs/ia block is reported by its row',
      current: { docs: { builder: 'docusaurus', ia: DOCS_IA } },
      source: { project: { project_type: 'framework', docs: { builder: 'docusaurus' } } },
      retired: ['/docs/ia'],
    },
    {
      label: 'several retired keys are each reported once',
      current: { repo: { kind: 'library' }, docs: { builder: 'docusaurus', ia: DOCS_IA } },
      source: {},
      retired: ['/docs', '/repo'],
    },
    {
      label: 'a scalar member dropped by whole replacement is not reported individually',
      current: { docs: { builder: 'docusaurus', output_dir: 'site/build' } },
      source: { project: { project_type: 'framework', docs: { builder: 'docusaurus' } } },
      retired: [],
    },
    {
      label: 'a first bind that retires nothing records an empty list',
      current: {},
      source: { ci_economy: { profile: 'full' } },
      retired: [],
    },
  ])('$label', async ({ current, source, retired }) => {
    const repo = adopterRepo(project(current));

    const result = await expectBound(repo, policy(source));

    const receipt = readJson(repo, BINDING);
    expect(Array.isArray(receipt['retired_keys'])).toBe(true);
    expect([...(receipt['retired_keys'] as string[])].sort()).toEqual(retired);
    expect(result.output?.['receipt']).toEqual(receipt);
  });

  it('drops the scalar member from project.json even though it is not reported', async () => {
    const repo = adopterRepo(
      project({ docs: { builder: 'docusaurus', output_dir: 'site/build' } }),
    );

    await expectBound(
      repo,
      policy({ project: { project_type: 'framework', docs: { builder: 'docusaurus' } } }),
    );

    expect(readJson(repo, PROJECT)['docs']).toEqual({ builder: 'docusaurus' });
  });
});

describe('IA-002: adopter declarations outside the matrix survive every bind', () => {
  it('keeps every declaration byte-for-byte across two binds, including a retiring one', async () => {
    const repo = adopterRepo(
      project({ ...DECLARATIONS, profile: 'tier2', repo: { kind: 'library' } }),
    );
    const original = readJson(repo, PROJECT);

    await expectBound(repo, policy({ policy_version: '1.0.0' }));
    const first = readJson(repo, PROJECT);
    await expectBound(repo, policy({ policy_version: '1.0.1', ci_economy: { profile: 'full' } }));
    const second = readJson(repo, PROJECT);

    for (const key of [...Object.keys(DECLARATIONS), 'profile', 'schemaVersion']) {
      expect(JSON.stringify(first[key]), key).toBe(JSON.stringify(original[key]));
      expect(JSON.stringify(second[key]), key).toBe(JSON.stringify(original[key]));
    }
  });

  it('keeps an adopter declaration when the bind replaces every owned key around it', async () => {
    const repo = adopterRepo(
      project({ ...DECLARATIONS, docs: { builder: 'jekyll' }, ci_economy: { profile: 'full' } }),
    );

    await expectBound(
      repo,
      policy({
        project: { project_type: 'runtime-host', docs: { builder: 'docusaurus' } },
        ci_economy: { profile: 'gate-staged' },
      }),
    );

    expect(readJson(repo, PROJECT)).toEqual({
      ...project({ ...DECLARATIONS }),
      project_type: 'runtime-host',
      docs: { builder: 'docusaurus' },
      ci_economy: { profile: 'gate-staged' },
    });
  });
});

describe('/project_type is schema-required: a source without it keeps the current value', () => {
  it('binds, keeps /project_type in place, and never reports it as retired', async () => {
    const repo = adopterRepo(project({ project_type: 'runtime-host', repo: { kind: 'library' } }));
    await expectBound(
      repo,
      policy({ project: { project_type: 'runtime-host', repo: { kind: 'library' } } }),
    );

    const kept = await expectBound(repo, {
      schemaVersion: '1.0.0',
      policy_id: 'fixture.devai-adoption',
      policy_version: '1.0.1',
      project: { repo: { kind: 'library' } },
    });

    expect(readJson(repo, PROJECT)).toEqual(
      project({ project_type: 'runtime-host', repo: { kind: 'library' } }),
    );
    expect(retiredKeys(repo)).toEqual([]);
    expect(kept.output?.['receipt']).toMatchObject({ retired_keys: [] });
  });
});
