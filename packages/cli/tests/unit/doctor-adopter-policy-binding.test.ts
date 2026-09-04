// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CAC } from 'cac';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { resolveCanonicalPolicyContent } from '../../../skills/src/bootstrap/index.js';
import { doctor } from '../../src/commands/doctor.js';
import { initBind } from '../../src/commands/init/index.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { createRequire } from 'node:module';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const roots: string[] = [];
const SOURCE = 'law/policy/devai-adoption.json';
const BINDING = '.devai/config/adopter-policy-binding.json';
const CONFIG = '.devai/config';
const SELECTED_RELEASE_VERSION = '1.5.0';
const TARGETS = [
  '.devai/config/project.json',
  '.devai/config/domains.json',
  '.devai/config/thresholds.json',
  '.devai/config/scorecard-na.json',
  '.devai/config/glob-guards.json',
] as const;

type JsonObject = Record<string, unknown>;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-doctor-adopter-policy-'));
  roots.push(path);
  return path;
}

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

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-doctor-adopter-policy');
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

async function canonicalRepo(): Promise<string> {
  const repo = root();
  put(repo, `${CONFIG}/project.json`, {
    schemaVersion: '1.0.0',
    project_type: 'runtime-host',
    profile: 'tier1',
    devai_version: SELECTED_RELEASE_VERSION,
  });
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

function defaultPolicy(): JsonObject {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.devai-adoption',
    policy_version: '1.0.0',
    domains: { client: ['COVERAGE', 'ERROR', 'FLOW', 'PRIVACY', 'RBAC'] },
    thresholds: { coverage: { lines: 91 }, mutation: { score_min: 88 } },
    scorecard_na: {
      schemaVersion: '1.0.0',
      cells: [
        {
          cell: 'F4:T5',
          reason: 'Fixture inventory has no idiomaticity surface.',
          constitution_anchor: 'Article 5',
        },
      ],
    },
    glob_guards: {
      schemaVersion: '1.0.0',
      guards: [
        {
          id: 'CLIENT_ROUTES',
          pattern: 'src/**/*.ts',
          min_matches: 2,
          description: 'Client routing files remain covered.',
          source: '.github/workflows/ci.yml',
        },
      ],
    },
    project: { project_type: 'runtime-host', repo: { kind: 'application' } },
  };
}

async function boundRepo(policy: JsonObject = defaultPolicy()): Promise<string> {
  const repo = await canonicalRepo();
  put(repo, SOURCE, policy);
  const result = await invoke(initBind, [
    'init-bind',
    '--target',
    repo,
    '--adopter-policy',
    SOURCE,
    '--write',
  ]);
  expect(result.exit, result.stderr).toBe(0);
  return repo;
}

async function policyCheck(repo: string): Promise<{
  readonly ok: boolean;
  readonly info: JsonObject;
  readonly errors?: readonly string[];
}> {
  const result = await invoke(doctor, ['doctor', '--repo-root', repo, '--skip', 'docs-governance']);
  expect(result.stderr).toBe('');
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ name: string; ok: boolean; info?: JsonObject; errors?: readonly string[] }>;
  };
  const check = report.checks.find(
    (candidate) => candidate.name === 'policy-materialization-current',
  );
  expect(check).toBeDefined();
  return check as { ok: boolean; info: JsonObject; errors?: readonly string[] };
}

function expectReason(check: { info: JsonObject }, reason: string): void {
  expect(check.info).toMatchObject({ reason_ids: expect.arrayContaining([reason]) });
}

describe('Doctor adopter-policy binding regression', () => {
  it('keeps canonical materialization without an adopter binding green', async () => {
    const repo = await canonicalRepo();
    expect(existsSync(join(repo, BINDING))).toBe(false);
    expect(await policyCheck(repo)).toMatchObject({ ok: true });
  });

  it('accepts a valid binding that adds sorted client domains and remains read-only', async () => {
    const repo = await boundRepo();
    const before = new Map(
      [...TARGETS, BINDING].map((path) => [path, readFileSync(join(repo, path))] as const),
    );
    expect(await policyCheck(repo)).toMatchObject({ ok: true });
    expect(readJson(repo, `${CONFIG}/domains.json`)).toMatchObject({
      client: ['COVERAGE', 'ERROR', 'FLOW', 'PRIVACY', 'RBAC'],
    });
    expect(
      new Map([...TARGETS, BINDING].map((path) => [path, readFileSync(join(repo, path))] as const)),
    ).toEqual(before);
  });

  it('accepts adopter thresholds, scorecard N/A, glob guards, and project policy', async () => {
    const repo = await boundRepo();
    expect(await policyCheck(repo)).toMatchObject({ ok: true });
    expect(readJson(repo, `${CONFIG}/thresholds.json`)).toMatchObject({
      coverage: { lines: 91, branches: 60, functions: 70, statements: 70 },
      mutation: { score_min: 88, survived_max: 50 },
    });
    expect(readJson(repo, `${CONFIG}/scorecard-na.json`)).toMatchObject({
      cells: [{ cell: 'F4:T5' }],
    });
    expect(readJson(repo, `${CONFIG}/glob-guards.json`)).toMatchObject({
      guards: [{ id: 'CLIENT_ROUTES', pattern: 'src/**/*.ts', min_matches: 2 }],
    });
    expect(readJson(repo, `${CONFIG}/project.json`)).toMatchObject({
      project_type: 'runtime-host',
      repo: { kind: 'application' },
      devai_version: SELECTED_RELEASE_VERSION,
    });
  });

  it('fails closed when materialized target bytes drift', async () => {
    const repo = await boundRepo();
    put(repo, `${CONFIG}/domains.json`, {
      ...readJson(repo, `${CONFIG}/domains.json`),
      client: [],
    });
    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'TARGET_BYTES_MISMATCH');

    const symlinkRepo = await boundRepo();
    put(
      symlinkRepo,
      'linked-domains.json',
      readFileSync(join(symlinkRepo, `${CONFIG}/domains.json`)),
    );
    rmSync(join(symlinkRepo, `${CONFIG}/domains.json`));
    symlinkSync('../../linked-domains.json', join(symlinkRepo, `${CONFIG}/domains.json`));
    expectReason(await policyCheck(symlinkRepo), 'TARGET_BYTES_MISMATCH');
  });

  it('fails closed when adopter source bytes drift', async () => {
    const repo = await boundRepo();
    writeFileSync(join(repo, SOURCE), `${readFileSync(join(repo, SOURCE), 'utf8')} \n`);
    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'SOURCE_DIGEST_MISMATCH');

    const missingRepo = await boundRepo();
    rmSync(join(missingRepo, SOURCE));
    expectReason(await policyCheck(missingRepo), 'SOURCE_MISSING');

    const invalidRepo = await boundRepo();
    put(invalidRepo, SOURCE, '{invalid-json\n');
    const invalidReceipt = readJson(invalidRepo, BINDING);
    invalidReceipt['source_digest_sha256'] = sha256(readFileSync(join(invalidRepo, SOURCE)));
    put(invalidRepo, BINDING, invalidReceipt);
    expectReason(await policyCheck(invalidRepo), 'SOURCE_POLICY_INVALID');

    const identityRepo = await boundRepo();
    put(identityRepo, SOURCE, { ...defaultPolicy(), policy_version: '1.0.1' });
    const identityReceipt = readJson(identityRepo, BINDING);
    identityReceipt['source_digest_sha256'] = sha256(readFileSync(join(identityRepo, SOURCE)));
    put(identityRepo, BINDING, identityReceipt);
    expectReason(await policyCheck(identityRepo), 'POLICY_IDENTITY_MISMATCH');
  });

  it('fails closed on a forged or stale receipt hash', async () => {
    const repo = await boundRepo();
    const receipt = readJson(repo, BINDING);
    const materialized = receipt['materialized'] as JsonObject;
    materialized[`${CONFIG}/domains.json`] = '0'.repeat(64);
    put(repo, BINDING, receipt);
    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'RECEIPT_HASH_MISMATCH');
  });

  it('fails closed when a materialized output is missing', async () => {
    const repo = await boundRepo();
    rmSync(join(repo, `${CONFIG}/glob-guards.json`));
    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'TARGET_MISSING');
  });

  it('requires the exact complete five-target receipt set', async () => {
    const incompleteRepo = await boundRepo();
    const incomplete = readJson(incompleteRepo, BINDING);
    incomplete['materialized'] = Object.fromEntries(
      Object.entries(incomplete['materialized'] as JsonObject).filter(
        ([path]) => path !== `${CONFIG}/scorecard-na.json`,
      ),
    );
    put(incompleteRepo, BINDING, incomplete);
    expectReason(await policyCheck(incompleteRepo), 'TARGET_SET_MISMATCH');

    const unexpectedRepo = await boundRepo();
    const unexpected = readJson(unexpectedRepo, BINDING);
    (unexpected['materialized'] as JsonObject)[`${CONFIG}/unexpected.json`] = '0'.repeat(64);
    put(unexpectedRepo, BINDING, unexpected);
    expectReason(await policyCheck(unexpectedRepo), 'TARGET_SET_MISMATCH');
  });

  it('rejects a malformed binding rather than falling back to raw defaults', async () => {
    const repo = await boundRepo();
    put(repo, BINDING, '{not-json\n');
    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'BINDING_MALFORMED');

    const unsupportedRepo = await boundRepo();
    put(unsupportedRepo, BINDING, {
      ...readJson(unsupportedRepo, BINDING),
      schemaVersion: '2.0.0',
    });
    expectReason(await policyCheck(unsupportedRepo), 'BINDING_VERSION_UNSUPPORTED');
  });

  it('treats a dangling binding-path symlink as malformed instead of canonical-unbound', async () => {
    const repo = await boundRepo({
      schemaVersion: '1.0.0',
      policy_id: 'fixture.canonical-only',
      policy_version: '1.0.0',
    });
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
    rmSync(join(repo, BINDING));
    symlinkSync('missing-adopter-policy-binding.json', join(repo, BINDING));

    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'BINDING_MALFORMED');
  });

  it('rejects unknown top-level binding receipt keys as a closed-shape violation', async () => {
    const repo = await boundRepo();
    put(repo, BINDING, { ...readJson(repo, BINDING), unexpected: 'not-authorized' });

    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'BINDING_MALFORMED');
  });

  it('rejects a source path outside law/policy', async () => {
    const repo = await boundRepo();
    put(repo, 'outside-policy.json', defaultPolicy());
    const receipt = readJson(repo, BINDING);
    receipt['source_path'] = 'outside-policy.json';
    receipt['source_digest_sha256'] = sha256(readFileSync(join(repo, 'outside-policy.json')));
    put(repo, BINDING, receipt);
    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'SOURCE_PATH_OUTSIDE_LAW_POLICY');
    expect(JSON.stringify(check.info)).not.toContain('outside-policy.json --as-role');

    const symlinkRepo = await boundRepo();
    put(symlinkRepo, 'outside-policy.json', defaultPolicy());
    symlinkSync('../../outside-policy.json', join(symlinkRepo, 'law/policy/linked-policy.json'));
    const symlinkReceipt = readJson(symlinkRepo, BINDING);
    symlinkReceipt['source_path'] = 'law/policy/linked-policy.json';
    symlinkReceipt['source_digest_sha256'] = sha256(
      readFileSync(join(symlinkRepo, 'outside-policy.json')),
    );
    put(symlinkRepo, BINDING, symlinkReceipt);
    expectReason(await policyCheck(symlinkRepo), 'SOURCE_PATH_OUTSIDE_LAW_POLICY');
  });

  it('rejects a lexically non-canonical source path without interpolating it', async () => {
    const repo = await boundRepo();
    const receipt = readJson(repo, BINDING);
    receipt['source_path'] = 'law/policy/sub/../devai-adoption.json';
    put(repo, BINDING, receipt);

    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'SOURCE_PATH_OUTSIDE_LAW_POLICY');
    expect(JSON.stringify(check.info['remediation_commands'] ?? [])).not.toContain('sub/../');
  });

  it('reports an actionable bound framework-version mismatch', async () => {
    const repo = await boundRepo();
    const projectPath = `${CONFIG}/project.json`;
    put(repo, projectPath, { ...readJson(repo, projectPath), devai_version: '1.2.10' });
    const receipt = readJson(repo, BINDING);
    (receipt['materialized'] as JsonObject)[projectPath] = sha256(
      readFileSync(join(repo, projectPath)),
    );
    put(repo, BINDING, receipt);
    const check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expectReason(check, 'FRAMEWORK_VERSION_MISMATCH');
    expect(check.errors?.join('\n')).toContain('1.2.10');
    expect(check.errors?.join('\n')).toContain(SELECTED_RELEASE_VERSION);
  });

  it('preserves the exact safe adopter-policy source in remediation', async () => {
    const repo = await boundRepo();
    put(repo, `${CONFIG}/thresholds.json`, { schemaVersion: '1.0.0', coverage: { lines: 1 } });
    const check = await policyCheck(repo);
    expect(check.info).toMatchObject({
      remediation_commands: [
        `devai init bind --target . --adopter-policy ${SOURCE} --as-role architect --write`,
      ],
    });
  });

  it('never recommends raw canonical defaults over valid adopter overrides', async () => {
    const repo = await boundRepo();
    const check = await policyCheck(repo);
    expect(check.ok).toBe(true);
    expect(check.info['remediation_commands'] ?? []).not.toEqual(
      expect.arrayContaining([
        'devai init bind --target . --operational-law --as-role architect --write',
      ]),
    );
    expect(readJson(repo, `${CONFIG}/domains.json`)).toMatchObject({
      client: ['COVERAGE', 'ERROR', 'FLOW', 'PRIVACY', 'RBAC'],
    });
  });

  it('continues canonical validation of forbidden-actions and subprocess-effects under a binding', async () => {
    const repo = await boundRepo({
      schemaVersion: '1.0.0',
      policy_id: 'fixture.canonical-only',
      policy_version: '1.0.0',
    });
    expect(await policyCheck(repo)).toMatchObject({ ok: true });

    put(repo, `${CONFIG}/forbidden-actions.json`, '{}\n');
    let check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expect(JSON.stringify(check.info)).toContain('forbidden-actions.json');

    put(
      repo,
      `${CONFIG}/forbidden-actions.json`,
      resolveCanonicalPolicyContent('forbidden-actions.json'),
    );
    put(repo, `${CONFIG}/subprocess-effects.json`, '{}\n');
    check = await policyCheck(repo);
    expect(check.ok).toBe(false);
    expect(JSON.stringify(check.info)).toContain('subprocess-effects.json');
  });
});
