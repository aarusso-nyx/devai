// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Inspector acceptance for the Doctor deliverable of ADR-AUT-0003 (campaign CMP-0005, TASK-0532):
// the reference source is bound through `init bind --adopter-policy` in a fixture repository
// pinned at constitution 1.0.2, and `doctor --format json` is read after each drift state the
// adopter page "Doctor findings" table names. Every finding is a real Doctor run over the bound
// fixture: a drift is a `review` (exit 1) naming its reason ids and the rebind command, never a
// pass and never a transport failure. Reason ids are compared as sets; the table fixes no order.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURES = resolve(import.meta.dirname, '../fixtures/adopter-path-authority');
const SOURCE = 'law/policy/devai-adoption.json';
const BINDING = '.devai/config/adopter-policy-binding.json';
const POLICY = '.devai/config/authority-policy.json';
const EXTENSION_ID = 'detran.path-authority';
const REBIND = `devai init bind --target . --adopter-policy ${SOURCE} --as-role architect --write`;

type JsonObject = Record<string, unknown>;
type Check = { name: string; ok: boolean; info?: JsonObject; errors?: string[] };
type DoctorRun = { exit: number; envelope: JsonObject; checks: Check[] };

let repo = '';

async function runCli(args: readonly string[]) {
  vi.resetModules();
  const previous = {
    argv: process.argv,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...args, '--format', 'json'];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    await import('../../src/bin.js');
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

async function expectCliPass(args: readonly string[]) {
  const result = await runCli(args);
  expect(result.exit, `${args.join(' ')}\n${result.stderr}`).toBe(0);
  return result;
}

function put(path: string, content: string): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function readJson(path: string): JsonObject {
  return JSON.parse(readFileSync(join(repo, path), 'utf8')) as JsonObject;
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

async function bindSource(content: string): Promise<void> {
  put(SOURCE, content);
  await expectCliPass([
    'init',
    'bind',
    '--adopter-policy',
    SOURCE,
    '--target',
    repo,
    '--as-role',
    'architect',
    '--write',
  ]);
}

async function runDoctor(): Promise<DoctorRun> {
  const result = await runCli(['doctor', '--repo-root', repo]);
  let envelope: JsonObject;
  try {
    envelope = JSON.parse(result.stdout) as JsonObject;
  } catch {
    throw new Error(`doctor wrote no JSON envelope (exit ${result.exit})\n${result.stderr}`);
  }
  const value = (envelope['result'] as { value?: { checks?: Check[] } } | undefined)?.value;
  return { exit: result.exit, envelope, checks: value?.checks ?? [] };
}

function check(run: DoctorRun, name: string): Check {
  const found = run.checks.find((candidate) => candidate.name === name);
  expect(found, `doctor must report ${name}`).toBeDefined();
  return found as Check;
}

function reasonIds(run: DoctorRun): Set<string> {
  const ids = check(run, 'policy-materialization-current').info?.['reason_ids'];
  expect(Array.isArray(ids), 'policy-materialization-current must list info.reason_ids').toBe(true);
  return new Set(ids as string[]);
}

function receiptExtension(): {
  extension_id: string;
  extension_version: string;
  digest_sha256: string;
} {
  const extension = readJson(BINDING)['authority_extension'] as
    { extension_id: string; extension_version: string; digest_sha256: string } | undefined;
  expect(extension, 'the receipt must carry authority_extension after the bind').toBeDefined();
  return extension as { extension_id: string; extension_version: string; digest_sha256: string };
}

/** A drift reads as a review: exit 1, a parseable envelope, and both checks failing by finding. */
function expectReview(run: DoctorRun): void {
  expect(run.exit, 'a drift is a review verdict, never a pass or a transport failure').toBe(1);
  expect(run.envelope['action_id']).toBe('doctor');
  const materialization = check(run, 'policy-materialization-current');
  expect(materialization.ok).toBe(false);
  expect(materialization.info?.['remediation_commands']).toContain(REBIND);
}

/** authority-enforcement names a mismatch as a finding with info, never as a thrown error. */
function expectEnforcementMismatch(run: DoctorRun): Check {
  const enforcement = check(run, 'authority-enforcement');
  expect(enforcement.ok).toBe(false);
  expect(
    enforcement.info,
    `authority-enforcement must report info: ${JSON.stringify(enforcement)}`,
  ).toBeDefined();
  expect(enforcement.info?.['policy_binding']).toBe('mismatch');
  return enforcement;
}

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'devai-doctor-authority-drift-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await expectCliPass([
    'init',
    'bind',
    '--full',
    '--tier',
    'tier1',
    '--target',
    repo,
    '--as-role',
    'architect',
    '--write',
  ]);
}, 120_000);

afterAll(() => {
  if (repo !== '') rmSync(repo, { recursive: true, force: true });
});

describe('Doctor after a bind of the reference source', () => {
  beforeEach(async () => {
    await bindSource(fixture('reference.json'));
  }, 60_000);

  it('reads policy-materialization-current and authority-enforcement current', async () => {
    const run = await runDoctor();
    const materialization = check(run, 'policy-materialization-current');
    expect(materialization.ok, JSON.stringify(materialization)).toBe(true);
    expect(reasonIds(run)).toEqual(new Set());
    const enforcement = check(run, 'authority-enforcement');
    expect(enforcement.ok, JSON.stringify(enforcement)).toBe(true);
    expect(enforcement.info?.['policy_binding']).toBe('current');
  }, 60_000);

  it('names the adopter extension id, version, and digest under authority-enforcement', async () => {
    const extension = receiptExtension();
    const policy = readJson(POLICY)['additive_extensions'] as Array<Record<string, unknown>>;
    expect(policy.map((entry) => entry['extension_id'])).toEqual([
      'devai-adopter-authority',
      EXTENSION_ID,
    ]);
    const run = await runDoctor();
    const info = JSON.stringify(check(run, 'authority-enforcement').info ?? {});
    expect(info).toContain(extension.extension_id);
    expect(info).toContain(extension.extension_version);
    expect(info).toContain(extension.digest_sha256);
  }, 60_000);

  it('reports an edited block as AUTHORITY_EXTENSION_DRIFT with the rebind command', async () => {
    const edited = JSON.parse(fixture('reference.json')) as {
      authority: { classes: { architecture: { selectors: string[] } } };
    };
    edited.authority.classes.architecture.selectors = ['**/ddl/**/*.sql'];
    put(SOURCE, `${JSON.stringify(edited, null, 2)}\n`);
    const run = await runDoctor();
    expectReview(run);
    expect
      .soft(reasonIds(run))
      .toEqual(new Set(['SOURCE_DIGEST_MISMATCH', 'AUTHORITY_EXTENSION_DRIFT']));
    const info = JSON.stringify(expectEnforcementMismatch(run).info);
    expect(info).toContain(EXTENSION_ID);
  }, 60_000);

  it('reports a removed block as AUTHORITY_EXTENSION_UNBOUND with the rebind command', async () => {
    put(SOURCE, fixture('without-authority.json'));
    const run = await runDoctor();
    expectReview(run);
    expect
      .soft(reasonIds(run))
      .toEqual(new Set(['SOURCE_DIGEST_MISMATCH', 'AUTHORITY_EXTENSION_UNBOUND']));
    const info = JSON.stringify(expectEnforcementMismatch(run).info);
    expect(info).toContain(EXTENSION_ID);
  }, 60_000);

  it('reports a deleted source as AUTHORITY_EXTENSION_SOURCE_MISSING with the rebind command', async () => {
    unlinkSync(join(repo, SOURCE));
    const run = await runDoctor();
    expectReview(run);
    expect
      .soft(reasonIds(run))
      .toEqual(new Set(['SOURCE_MISSING', 'AUTHORITY_EXTENSION_SOURCE_MISSING']));
    const info = JSON.stringify(expectEnforcementMismatch(run).info);
    expect(info).toContain(EXTENSION_ID);
  }, 60_000);

  it('reads current again after the rebind the finding names', async () => {
    put(SOURCE, fixture('without-authority.json'));
    expectReview(await runDoctor());
    await bindSource(fixture('reference.json'));
    const run = await runDoctor();
    expect(check(run, 'policy-materialization-current').ok).toBe(true);
    expect(check(run, 'authority-enforcement').info?.['policy_binding']).toBe('current');
  }, 120_000);
});

describe('Doctor after a bind of a source without the block', () => {
  beforeEach(async () => {
    await bindSource(fixture('without-authority.json'));
  }, 60_000);

  it('reads current with no extension in the receipt', async () => {
    expect(readJson(BINDING)['authority_extension']).toBeUndefined();
    const run = await runDoctor();
    expect(check(run, 'policy-materialization-current').ok).toBe(true);
    expect(reasonIds(run)).toEqual(new Set());
    expect(check(run, 'authority-enforcement').info?.['policy_binding']).toBe('current');
  }, 60_000);

  it('reports a block added without a rebind as AUTHORITY_EXTENSION_UNBOUND', async () => {
    put(SOURCE, fixture('reference.json'));
    const run = await runDoctor();
    expectReview(run);
    expect
      .soft(reasonIds(run))
      .toEqual(new Set(['SOURCE_DIGEST_MISMATCH', 'AUTHORITY_EXTENSION_UNBOUND']));
    // The receipt carries no extension, so the authority sources rebuilt from it carry none
    // either; the table names this state under policy-materialization-current only.
    expect(check(run, 'authority-enforcement').info?.['policy_binding']).toBeDefined();
  }, 60_000);
});
