// ADR-SEC-0001, Inspector Adversarial Acceptance IA-002: a credential probe
// reports one of present, absent, scope-insufficient, or expired, and its
// output contains no substring of the credential value. Doctor also gains a
// `credential-requirements` check backed by the same probe that lists entry
// ids and statuses, never a value.
//
// Red today, for two independent reasons:
//  - packages/cli/src/services/credential-probe.ts does not exist. Each test
//    below that needs it performs its own dynamic import (rather than one at
//    module scope) precisely so this failure is scoped to that test alone,
//    with its own ERR_MODULE_NOT_FOUND-rooted assertion failure, instead of
//    crashing collection of the whole file.
//  - doctor's CHECK_SPECS (packages/cli/src/commands/doctor.ts) has no
//    `credential-requirements` entry yet, so the doctor-level assertion at
//    the bottom of this file is red on its own, independent of the probe
//    module's existence.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CAC } from 'cac';
import { afterEach, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { resolveCanonicalPolicyContent } from '../../../skills/src/bootstrap/index.js';
import { doctor } from '../../src/commands/doctor.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { createRequire } from 'node:module';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const ROOT = resolve(import.meta.dirname, '../../../..');
const CREDENTIAL_MANIFEST_PATH = resolve(ROOT, 'law/policy/credential-requirements.json');

interface CredentialManifest {
  readonly entries: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
}

const credentialManifest = JSON.parse(
  readFileSync(CREDENTIAL_MANIFEST_PATH, 'utf8'),
) as CredentialManifest;

type SubprocessRun = (argv: readonly string[]) => {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

interface ProbeCredentialOptions {
  readonly repoRoot: string;
  readonly id: string;
  readonly run: SubprocessRun;
}

type CredentialStatus = 'present' | 'absent' | 'scope-insufficient' | 'expired';

interface ProbeCredentialResult {
  readonly id: string;
  readonly status: CredentialStatus;
}

const CREDENTIAL_STATUSES: readonly CredentialStatus[] = [
  'present',
  'absent',
  'scope-insufficient',
  'expired',
];

/** Dynamic, per-test import so a missing module fails only the test that
 * needs it, with a clear ERR_MODULE_NOT_FOUND-rooted message, rather than
 * crashing collection of the whole file. */
async function loadProbeCredential(): Promise<
  (options: ProbeCredentialOptions) => Promise<ProbeCredentialResult> | ProbeCredentialResult
> {
  const module = (await import(
    pathToFileURL(resolve(ROOT, 'packages/cli/src/services/credential-probe.ts')).href
  )) as {
    probeCredential: (
      options: ProbeCredentialOptions,
    ) => Promise<ProbeCredentialResult> | ProbeCredentialResult;
  };
  return module.probeCredential;
}

const GH_AUTH_ENTRY_ID = 'GH_TOKEN';
const ENVIRONMENT_ENTRY_ID = 'NODE_AUTH_TOKEN';

it('manifest fixture assumptions: GH_TOKEN is gh-auth and NODE_AUTH_TOKEN is environment', () => {
  const ghAuth = credentialManifest.entries.find((entry) => entry.id === GH_AUTH_ENTRY_ID);
  const environment = credentialManifest.entries.find((entry) => entry.id === ENVIRONMENT_ENTRY_ID);
  expect(ghAuth?.kind).toBe('gh-auth');
  expect(environment?.kind).toBe('environment');
});

it('never leaks a marker embedded in the stubbed subprocess output', async () => {
  const probeCredential = await loadProbeCredential();
  const fakeToken = ['ghp', 'x'.repeat(20)].join('_');
  const marker = 'SECRET-MARKER-9c1e';
  const run: SubprocessRun = () => ({
    status: 0,
    stdout: `Logged in to github.com account marker-bot\nToken: ${fakeToken}\n${marker}\n`,
    stderr: '',
  });

  const result = await probeCredential({ repoRoot: ROOT, id: GH_AUTH_ENTRY_ID, run });

  expect(CREDENTIAL_STATUSES).toContain(result.status);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(fakeToken);
  expect(serialized).not.toContain(marker);
  for (const value of Object.values(result)) {
    expect(String(value)).not.toContain(fakeToken);
    expect(String(value)).not.toContain(marker);
  }
});

it('reports absent for an environment-kind credential whose variable is unset', async () => {
  const probeCredential = await loadProbeCredential();
  const previous = process.env.NODE_AUTH_TOKEN;
  delete process.env.NODE_AUTH_TOKEN;
  try {
    const run: SubprocessRun = () => {
      throw new Error('an environment-kind probe must not spawn a subprocess');
    };
    const result = await probeCredential({ repoRoot: ROOT, id: ENVIRONMENT_ENTRY_ID, run });
    expect(result.status).toBe('absent');
  } finally {
    if (previous === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = previous;
  }
});

// --- doctor-level check -----------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devai-doctor-credential-probe-'));
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

async function canonicalRepo(): Promise<string> {
  const repo = root();
  const CONFIG = '.devai/config';
  put(repo, `${CONFIG}/project.json`, {
    schemaVersion: '1.0.0',
    project_type: 'runtime-host',
    profile: 'tier1',
    devai_version: '1.5.7',
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

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-doctor-credential-probe');
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

const SECRET_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{16,}/u,
  /github_pat_/u,
  /AKIA[0-9A-Z]{16}/u,
  /sk-[A-Za-z0-9_-]{20,}/u,
];

it('exposes a doctor check named credential-requirements listing entry ids and statuses, never a value', async () => {
  const repo = await canonicalRepo();
  expect(existsSync(join(repo, '.devai/config/project.json'))).toBe(true);
  const result = await invoke(doctor, ['doctor', '--repo-root', repo, '--skip', 'docs-governance']);
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ name: string; info?: Record<string, unknown> }>;
  };
  const check = report.checks.find((candidate) => candidate.name === 'credential-requirements');
  expect(check, JSON.stringify(report.checks.map((c) => c.name))).toBeDefined();

  const serializedInfo = JSON.stringify(check?.info ?? {});
  for (const pattern of SECRET_SHAPES) {
    expect(pattern.test(serializedInfo)).toBe(false);
  }
  for (const entry of credentialManifest.entries) {
    expect(serializedInfo).toContain(entry.id);
  }
  expect(serializedInfo).toMatch(new RegExp(`\\b(?:${CREDENTIAL_STATUSES.join('|')})\\b`, 'u'));
});
