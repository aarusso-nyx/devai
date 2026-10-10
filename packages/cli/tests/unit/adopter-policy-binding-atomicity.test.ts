// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
// Inspector acceptance for ADR-CFG-0002: the projection and its receipt are one
// atomic write (IA-003), a bind against an unchanged source writes no byte to any
// target and records no retired key (IA-004), the receipt admits retired_keys as
// JSON pointers at the ownership-matrix rows, and a receipt whose digest no longer
// matches its file is refused until the binding is rematerialized (IA-005, #162).
//
// A process kill is simulated at the filesystem seam: `node:fs` is wrapped so the
// k-th mutation under the fixture repository throws before it takes effect and
// every later mutation anywhere fails as well. The disk is therefore frozen
// exactly as a killed process would leave it, and no in-process rollback can run.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { resolveCanonicalPolicyContent } from '../../../skills/src/bootstrap/index.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { doctor } from '../../src/commands/doctor.js';
import { initBind } from '../../src/commands/init/index.js';
import {
  jsonBytes,
  resolveAdopterPolicyMaterialization,
} from '../../src/services/adopter-policy.js';
import {
  parseAdopterPolicyBinding,
  verifyAdopterPolicyBindingSnapshot,
} from '../../src/services/adopter-policy-binding.js';

interface Mutation {
  readonly op: string;
  readonly paths: readonly string[];
}

const seam = vi.hoisted(() => ({
  roots: [] as string[],
  recording: false,
  log: [] as Mutation[],
  killAt: 0,
  count: 0,
  dead: false,
  writableDescriptors: new Set<number>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const inRoot = (value: unknown): value is string =>
    typeof value === 'string' && seam.roots.some((root) => value.startsWith(root));
  const writeFlags = (flags: unknown): boolean => {
    if (typeof flags === 'string') return /[wa+]/u.test(flags);
    if (typeof flags === 'number') {
      const { O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC } = actual.constants;
      return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_APPEND | O_TRUNC)) !== 0;
    }
    return false;
  };
  function observe(op: string, paths: readonly unknown[]): void {
    if (seam.dead) throw new Error(`TEST_PROCESS_KILLED:${op}`);
    const scoped = paths.filter(inRoot);
    if (scoped.length === 0) return;
    seam.count += 1;
    if (seam.killAt > 0 && seam.count >= seam.killAt) {
      seam.dead = true;
      throw new Error(`TEST_PROCESS_KILLED:${op}`);
    }
    if (seam.recording) seam.log.push({ op, paths: scoped });
  }
  const wrap =
    <A extends unknown[], R>(op: string, fn: (...args: A) => R, select: (args: A) => unknown[]) =>
    (...args: A): R => {
      observe(op, select(args));
      return fn(...args);
    };
  const first = (args: unknown[]) => [args[0]];
  const both = (args: unknown[]) => [args[0], args[1]];
  const second = (args: unknown[]) => [args[1]];
  const openSync = (...args: Parameters<typeof actual.openSync>) => {
    const writing = writeFlags(args[1]);
    if (writing) observe('openSync', [args[0]]);
    else if (seam.dead) throw new Error('TEST_PROCESS_KILLED:openSync');
    const descriptor = actual.openSync(...args);
    if (writing && inRoot(args[0])) seam.writableDescriptors.add(descriptor);
    return descriptor;
  };
  const writeSync = ((descriptor: number, ...rest: unknown[]) => {
    if (seam.dead) throw new Error('TEST_PROCESS_KILLED:writeSync');
    if (seam.writableDescriptors.has(descriptor)) {
      seam.count += 1;
      if (seam.killAt > 0 && seam.count >= seam.killAt) {
        seam.dead = true;
        throw new Error('TEST_PROCESS_KILLED:writeSync');
      }
    }
    return (actual.writeSync as (...args: unknown[]) => number)(descriptor, ...rest);
  }) as typeof actual.writeSync;
  const deadOnly =
    <A extends unknown[], R>(op: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      if (seam.dead) throw new Error(`TEST_PROCESS_KILLED:${op}`);
      return fn(...args);
    };
  const wrapped = {
    ...actual,
    writeFileSync: wrap('writeFileSync', actual.writeFileSync, first),
    appendFileSync: wrap('appendFileSync', actual.appendFileSync, first),
    renameSync: wrap('renameSync', actual.renameSync, both),
    rmSync: wrap('rmSync', actual.rmSync, first),
    unlinkSync: wrap('unlinkSync', actual.unlinkSync, first),
    copyFileSync: wrap('copyFileSync', actual.copyFileSync, second),
    cpSync: wrap('cpSync', actual.cpSync, second),
    symlinkSync: wrap('symlinkSync', actual.symlinkSync, second),
    linkSync: wrap('linkSync', actual.linkSync, second),
    openSync,
    writeSync,
    mkdirSync: deadOnly('mkdirSync', actual.mkdirSync),
    mkdtempSync: deadOnly('mkdtempSync', actual.mkdtempSync),
    chmodSync: deadOnly('chmodSync', actual.chmodSync),
    fsyncSync: deadOnly('fsyncSync', actual.fsyncSync),
  };
  return { ...wrapped, default: wrapped };
});

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

type JsonObject = Record<string, unknown>;

const FRAMEWORK_VERSION = '1.6.0';
const SOURCE = 'law/policy/devai-adoption.json';
const BINDING = '.devai/config/adopter-policy-binding.json';
const PROJECT = '.devai/config/project.json';
const SCORECARD = '.devai/config/scorecard-na.json';
const CONFIG = '.devai/config';
const TARGETS = [
  PROJECT,
  '.devai/config/domains.json',
  '.devai/config/thresholds.json',
  SCORECARD,
  '.devai/config/glob-guards.json',
] as const;
const PAIR = [...TARGETS, BINDING] as const;
/** The binding lock a killed bind leaves behind; removing it is the documented manual step. */
const LOCK = '.devai/config/upgrade.lock';

const ATTESTED_RC = {
  profile: 'rc',
  transport: 'protected-tag-v1',
  tag_prefix: 'devai-local-evidence/',
  binding: 'exact-tree',
  required_check: 'verified-local-rc',
  failure_mode: 'fail-closed',
  local_only_nodes: ['test:mutation'],
} as const;

const roots: string[] = [];

afterEach(() => {
  disarm();
  seam.roots.splice(0);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Kill the process right before the k-th mutation under the fixture roots. */
function arm(killAt: number): void {
  disarm();
  seam.killAt = killAt;
}

function disarm(): void {
  seam.recording = false;
  seam.log.splice(0);
  seam.killAt = 0;
  seam.count = 0;
  seam.dead = false;
  seam.writableDescriptors.clear();
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  fs.mkdirSync(dirname(absolute), { recursive: true });
  fs.writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function readJson(repo: string, path: string): JsonObject {
  return JSON.parse(fs.readFileSync(join(repo, path), 'utf8')) as JsonObject;
}

function bytesOf(repo: string, paths: readonly string[]): Map<string, string> {
  return new Map(
    paths.map((path) => [
      path,
      fs.existsSync(join(repo, path)) ? fs.readFileSync(join(repo, path), 'utf8') : '<absent>',
    ]),
  );
}

function listFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else out.push(relative(repo, absolute));
    }
  };
  walk(repo);
  return out.sort();
}

function policy(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.devai-adoption',
    policy_version: '1.0.0',
    project: { project_type: 'framework', repo: { kind: 'library' } },
    ...overrides,
  };
}

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-adopter-policy-atomicity');
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

function adopterRepo(currentProject: JsonObject): string {
  const created = fs.mkdtempSync(join(tmpdir(), 'devai-adopter-atomicity-'));
  roots.push(created);
  const repo = fs.realpathSync(created);
  seam.roots.push(created, repo);
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

function baseProject(overrides: JsonObject = {}): JsonObject {
  return {
    schemaVersion: '1.0.0',
    project_type: 'framework',
    profile: 'tier1',
    devai_version: FRAMEWORK_VERSION,
    ...overrides,
  };
}

async function bind(repo: string, source?: JsonObject) {
  if (source !== undefined) put(repo, SOURCE, source);
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

async function expectBound(repo: string, source?: JsonObject) {
  const result = await bind(repo, source);
  expect(result.exit, result.stderr).toBe(0);
  return result;
}

/** Every digest the on-disk receipt carries matches the file it names. */
function pairIsComplete(repo: string): boolean {
  const receipt = readJson(repo, BINDING);
  const materialized = receipt['materialized'] as Record<string, string>;
  return Object.entries(materialized).every(
    ([path, digest]) =>
      fs.existsSync(join(repo, path)) && sha256(fs.readFileSync(join(repo, path))) === digest,
  );
}

function retired(receipt: JsonObject): string[] {
  const value = receipt['retired_keys'];
  return Array.isArray(value) ? value.map(String) : [];
}

async function doctorCheck(repo: string, name: string) {
  const result = await invoke(doctor, ['doctor', '--repo-root', repo, '--skip', 'docs-governance']);
  const report = JSON.parse(result.stdout) as {
    checks: Array<{ name: string; ok: boolean; info?: JsonObject; errors?: string[] }>;
  };
  const check = report.checks.find((candidate) => candidate.name === name);
  expect(check, name).toBeDefined();
  return check as { name: string; ok: boolean; info?: JsonObject; errors?: string[] };
}

/** A repository bound with ci_economy declared, and the source that retires it. */
async function retiringFixture() {
  const repo = adopterRepo(baseProject());
  await expectBound(repo, policy({ ci_economy: { profile: 'full', attested_rc: ATTESTED_RC } }));
  const previous = bytesOf(repo, PAIR);
  // The retiring source also moves a second target, so a torn write that lands
  // only part of the new projection is visible even before retirement exists.
  put(repo, SOURCE, policy({ policy_version: '1.1.0', thresholds: { coverage: { lines: 91 } } }));
  return { repo, previous };
}

// ---------------------------------------------------------------------------
// Receipt shape: retired_keys is admitted, closed, and pointer-valued.
// ---------------------------------------------------------------------------

const DIGEST = 'a'.repeat(64);

function receiptFixture(extra: JsonObject = {}): JsonObject {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.devai-adoption',
    policy_version: '1.1.0',
    source_path: SOURCE,
    source_digest_sha256: DIGEST,
    materialized: Object.fromEntries(TARGETS.map((path) => [path, DIGEST])),
    ...extra,
  };
}

describe('receipt: retired_keys under the closed v1 keyset', () => {
  it.each([[[]], [['/ci_economy']], [['/ci_economy/attested_rc', '/docs/ia', '/repo']]])(
    'admits retired_keys %j beside the digests',
    (retiredKeys) => {
      const receipt = receiptFixture({ retired_keys: retiredKeys });

      expect(parseAdopterPolicyBinding(JSON.stringify(receipt))).toEqual({ binding: receipt });
    },
  );

  it.each([
    ['a string instead of a list', 'ci_economy'],
    ['a key name without a pointer slash', ['ci_economy']],
    ['an empty pointer', ['']],
    ['a non-string member', [1]],
    ['a pointer at a key the matrix does not name', ['/feature_flags']],
    ['a pointer at the machine-stamped version', ['/devai_version']],
  ])('refuses retired_keys holding %s', (_label, value) => {
    expect(
      parseAdopterPolicyBinding(JSON.stringify(receiptFixture({ retired_keys: value }))),
    ).toEqual({
      reason: 'BINDING_MALFORMED',
    });
  });
});

describe('receipt verification: digests stay authoritative with retired_keys present', () => {
  const releaseVerification = {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.release-profile',
    policy_version: '1.0.0',
    release_unit: '@fixture/package',
    version_source: 'package.json',
    default_support: 'current',
    capability_tasks: { lint: ['lint'] },
    risk_capabilities: {},
    mutation_roster: [],
  } as const;

  function verifiable(tamper?: (binding: JsonObject) => void) {
    const source = policy({ release_verification: releaseVerification });
    const sourceBytes = Buffer.from(jsonBytes(source), 'utf8');
    const materialized = resolveAdopterPolicyMaterialization({
      policy: source,
      currentProject: baseProject({ ci_economy: { profile: 'full' } }),
      frameworkVersion: FRAMEWORK_VERSION,
    });
    const files = new Map<string, Uint8Array>([
      [SOURCE, sourceBytes],
      ...[...materialized].map(([path, bytes]) => [path, Buffer.from(bytes, 'utf8')] as const),
    ]);
    const binding: JsonObject = {
      schemaVersion: '1.0.0',
      policy_id: source['policy_id'],
      policy_version: source['policy_version'],
      source_path: SOURCE,
      source_digest_sha256: sha256(sourceBytes),
      materialized: Object.fromEntries(
        [...materialized].map(([path, bytes]) => [path, sha256(Buffer.from(bytes, 'utf8'))]),
      ),
      retired_keys: ['/ci_economy'],
    };
    tamper?.(binding);
    files.set(BINDING, Buffer.from(jsonBytes(binding), 'utf8'));
    return () =>
      verifyAdopterPolicyBindingSnapshot({
        files,
        frameworkVersion: FRAMEWORK_VERSION,
        validatePolicy: (document) => getValidator('adopter-policy.schema.json')(document) === true,
        validateProject: (document) =>
          getValidator('project-config.schema.json')(document) === true,
        materialize: resolveAdopterPolicyMaterialization,
      });
  }

  it('verifies a receipt that reports a retirement when every digest matches', () => {
    const run = verifiable();

    expect(run).not.toThrow();
    expect(run()).toMatchObject({ binding_receipt: { path: BINDING } });
  });

  it('refuses a receipt that reports a retirement but whose digest no longer matches the file', () => {
    const run = verifiable((binding) => {
      (binding['materialized'] as JsonObject)[SCORECARD] = '0'.repeat(64);
    });

    expect(run).toThrow('rpl-adopter-binding-mismatch');
  });
});

// ---------------------------------------------------------------------------
// IA-004: an unchanged rebind is a no-op on every target.
// ---------------------------------------------------------------------------

describe('IA-004: idempotent binding', () => {
  it('writes no byte to any target on an unchanged rebind and records no retired key', async () => {
    const repo = adopterRepo(baseProject({ name: 'Fixture Adopter' }));
    const source = policy({ ci_economy: { profile: 'gate-staged' } });
    await expectBound(repo, source);
    const settled = bytesOf(repo, PAIR);

    seam.recording = true;
    const second = await expectBound(repo);
    const mutations = [...seam.log];
    disarm();

    // Only the targets are forbidden a write; the receipt may be rewritten as long as
    // its bytes are unchanged, which bytesOf(PAIR) below pins.
    const targetPaths = new Set(TARGETS.map((path) => join(repo, path)));
    expect(
      mutations.filter((mutation) => mutation.paths.some((path) => targetPaths.has(path))),
    ).toEqual([]);
    expect(bytesOf(repo, PAIR)).toEqual(settled);
    expect(second.output?.['receipt']).toMatchObject({ retired_keys: [] });
    expect(readJson(repo, BINDING)['retired_keys']).toEqual([]);
  });

  it('keeps an unchanged rebind a no-op after a retirement has settled', async () => {
    const { repo } = await retiringFixture();
    await expectBound(repo);
    const settled = bytesOf(repo, PAIR);

    const third = await expectBound(repo);

    expect(bytesOf(repo, PAIR)).toEqual(settled);
    expect(third.output?.['receipt']).toMatchObject({ retired_keys: [] });
  });
});

// ---------------------------------------------------------------------------
// IA-003: projection and receipt land together or not at all.
// ---------------------------------------------------------------------------

describe('IA-003: atomic projection and receipt', () => {
  it('recovers an interrupted sensor-input target replacement with its matching receipt digest', async () => {
    const target = '.devai/config/sensor-inputs.json';
    const original = {
      schemaVersion: '1.0.0',
      inputs: { inventory_routes: { framework: 'react' } },
    };
    const next = {
      schemaVersion: '1.0.0',
      inputs: { inventory_routes: { framework: 'angular', scanDirs: ['apps/web/src'] } },
    };
    async function changing() {
      const repo = adopterRepo(baseProject());
      await expectBound(repo, policy({ sensor_inputs: original }));
      const previous = bytesOf(repo, [...PAIR, target]);
      put(repo, SOURCE, policy({ policy_version: '1.1.0', sensor_inputs: next }));
      return { repo, previous };
    }
    const probe = await changing();
    seam.recording = true;
    await expectBound(probe.repo);
    const index = seam.log.findIndex(
      (mutation) => mutation.op === 'renameSync' && mutation.paths[1] === join(probe.repo, target),
    );
    disarm();
    expect(index).toBeGreaterThanOrEqual(0);

    const { repo, previous } = await changing();
    arm(index + 1);
    try {
      await bind(repo);
    } catch {
      /* Frozen process cannot roll back. */
    }
    disarm();
    expect(bytesOf(repo, [...PAIR, target])).toEqual(previous);
    const blocked = await bind(repo);
    expect(blocked.stderr).toContain('INIT_UPGRADE_LOCKED');
    fs.rmSync(join(repo, LOCK));
    await expectBound(repo);
    expect(readJson(repo, target)).toEqual(next);
    expect(pairIsComplete(repo)).toBe(true);
    expect((readJson(repo, BINDING)['materialized'] as JsonObject)[target]).toBe(
      sha256(fs.readFileSync(join(repo, target))),
    );
    expect(await doctorCheck(repo, 'policy-materialization-current')).toMatchObject({ ok: true });
  });

  it('stages every target and the receipt, then renames them into place', async () => {
    const { repo } = await retiringFixture();

    seam.recording = true;
    await expectBound(repo);
    const mutations = [...seam.log];
    disarm();

    const finals = new Set(PAIR.map((path) => join(repo, path)));
    const inPlaceWrites = mutations.filter(
      (mutation) => mutation.op !== 'renameSync' && mutation.paths.some((path) => finals.has(path)),
    );
    expect(inPlaceWrites).toEqual([]);
    const renamedInto = new Set(
      mutations
        .filter((mutation) => mutation.op === 'renameSync')
        .map((mutation) => mutation.paths[1]),
    );
    for (const path of PAIR) expect(renamedInto.has(join(repo, path)), path).toBe(true);
    const firstRename = mutations.findIndex((mutation) => mutation.op === 'renameSync');
    const lastStagedWrite = mutations.findLastIndex(
      (mutation) =>
        mutation.op !== 'renameSync' && mutation.op !== 'rmSync' && mutation.op !== 'unlinkSync',
    );
    expect(lastStagedWrite).toBeLessThan(firstRename);
  });

  it('leaves the previous complete pair when killed between the staged write and the rename', async () => {
    // Record the uninterrupted order of mutations to find the first rename that
    // lands a staged file on the projection or the receipt.
    const probe = await retiringFixture();
    seam.recording = true;
    await expectBound(probe.repo);
    const order = [...seam.log];
    disarm();
    const finals = new Set(PAIR.map((path) => join(probe.repo, path)));
    const firstRename = order.findIndex(
      (mutation) => mutation.op === 'renameSync' && finals.has(mutation.paths[1] ?? ''),
    );
    expect(firstRename, 'the bind renames staged files into place').toBeGreaterThanOrEqual(0);

    const { repo, previous } = await retiringFixture();
    arm(firstRename + 1);
    try {
      await bind(repo);
    } catch {
      // A killed process reports nothing; the disk is what remains.
    }
    disarm();

    expect(bytesOf(repo, PAIR)).toEqual(previous);
    expect(pairIsComplete(repo)).toBe(true);

    // The killed bind left its lock (#264): no run takes it over, so the rerun refuses until
    // a human removes it, and only then recovers the journal.
    expect(fs.existsSync(join(repo, LOCK))).toBe(true);
    const blocked = await bind(repo);
    expect(blocked.exit).not.toBe(0);
    expect(blocked.stderr).toContain('INIT_UPGRADE_LOCKED');
    expect(bytesOf(repo, PAIR)).toEqual(previous);
    fs.rmSync(join(repo, LOCK));

    const rerun = await expectBound(repo);
    expect(pairIsComplete(repo)).toBe(true);
    expect(readJson(repo, PROJECT)).not.toHaveProperty('ci_economy');
    expect(rerun.output?.['receipt']).toMatchObject({ retired_keys: ['/ci_economy'] });
  });

  it('never loses a retirement at any kill point: the rerun observes a complete pair', async () => {
    const probe = await retiringFixture();
    seam.recording = true;
    const reference = await expectBound(probe.repo);
    const steps = seam.log.length;
    disarm();
    expect(steps).toBeGreaterThan(0);
    expect(reference.output?.['receipt']).toMatchObject({ retired_keys: ['/ci_economy'] });
    const settledFiles = listFiles(probe.repo);

    for (let killAt = 1; killAt <= steps; killAt += 1) {
      const { repo, previous } = await retiringFixture();
      const previousReceipt = previous.get(BINDING);
      arm(killAt);
      try {
        await bind(repo);
      } catch {
        // The killed run's own outcome is not observable.
      }
      disarm();
      const leftReceipt = fs.readFileSync(join(repo, BINDING), 'utf8');
      const leftRetired =
        leftReceipt === previousReceipt ? [] : retired(JSON.parse(leftReceipt) as JsonObject);
      if (fs.existsSync(join(repo, LOCK))) {
        // A lock the killed run left blocks every rerun until it is removed by hand.
        const blocked = await bind(repo);
        expect(blocked.stderr, `kill point ${String(killAt)}`).toContain('INIT_UPGRADE_LOCKED');
        fs.rmSync(join(repo, LOCK));
      }

      const rerun = await bind(repo);
      expect(rerun.exit, `kill point ${String(killAt)}: ${rerun.stderr}`).toBe(0);
      const finalReceipt = readJson(repo, BINDING);

      expect(pairIsComplete(repo), `kill point ${String(killAt)}`).toBe(true);
      expect(readJson(repo, PROJECT), `kill point ${String(killAt)}`).not.toHaveProperty(
        'ci_economy',
      );
      expect(
        [...leftRetired, ...retired(finalReceipt)],
        `kill point ${String(killAt)}: the retirement must reach a receipt`,
      ).toContain('/ci_economy');
      expect(listFiles(repo), `kill point ${String(killAt)}: staging left behind`).toEqual(
        settledFiles,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// IA-005: a stale scorecard-na.json digest is a doctor failure until rebind.
// ---------------------------------------------------------------------------

describe('IA-005: stale scorecard-na.json digest', () => {
  it('reports the digest mismatch until the binding is rematerialized', async () => {
    const repo = adopterRepo(baseProject());
    const source = policy();
    await expectBound(repo, source);
    const receipt = readJson(repo, BINDING);
    const stale = sha256(`${fs.readFileSync(join(repo, SCORECARD), 'utf8')} `);
    (receipt['materialized'] as JsonObject)[SCORECARD] = stale;
    put(repo, BINDING, receipt);

    const failing = await doctorCheck(repo, 'policy-materialization-current');
    expect(failing.ok).toBe(false);
    expect(failing.info).toMatchObject({
      reason_ids: expect.arrayContaining(['RECEIPT_HASH_MISMATCH']),
    });

    await expectBound(repo);

    expect(readJson(repo, BINDING)['materialized']).toMatchObject({
      [SCORECARD]: sha256(fs.readFileSync(join(repo, SCORECARD))),
    });
    expect((await doctorCheck(repo, 'policy-materialization-current')).ok).toBe(true);
  });

  it('a rebind of the framework checkout changes only the project.json version stamp and the receipt', () => {
    // The adoption source declares scorecard_na and glob_guards equal to the law
    // mirrors, so projecting it over the committed project.json reproduces every
    // committed target except the devai_version stamp; the receipt is the other change.
    const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const receipt = JSON.parse(fs.readFileSync(join(checkout, BINDING), 'utf8')) as JsonObject;
    const source = JSON.parse(
      fs.readFileSync(join(checkout, String(receipt['source_path'])), 'utf8'),
    ) as JsonObject;
    const committedProject = JSON.parse(
      fs.readFileSync(join(checkout, PROJECT), 'utf8'),
    ) as JsonObject;
    const installed = String(
      (
        JSON.parse(
          fs.readFileSync(join(checkout, 'packages/cli/package.json'), 'utf8'),
        ) as JsonObject
      )['version'],
    );

    const rebound = resolveAdopterPolicyMaterialization({
      policy: source,
      currentProject: committedProject,
      frameworkVersion: installed,
    });

    expect([...rebound.keys()].sort()).toEqual(
      Object.keys(receipt['materialized'] as JsonObject).sort(),
    );
    for (const [path, bytes] of rebound) {
      if (path === PROJECT) {
        expect(JSON.parse(bytes), path).toEqual({ ...committedProject, devai_version: installed });
      } else {
        expect(bytes, path).toBe(fs.readFileSync(join(checkout, path), 'utf8'));
      }
    }
  });

  it('the framework checkout carries a binding whose digests match the committed files (#162 item 4)', () => {
    const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const receipt = JSON.parse(fs.readFileSync(join(checkout, BINDING), 'utf8')) as JsonObject;
    const sourcePath = String(receipt['source_path']);
    const sourceBytes = fs.readFileSync(join(checkout, sourcePath));
    const source = JSON.parse(sourceBytes.toString('utf8')) as JsonObject;

    const actual = Object.fromEntries(
      Object.keys(receipt['materialized'] as JsonObject).map((path) => [
        path,
        sha256(fs.readFileSync(join(checkout, path))),
      ]),
    );

    expect(receipt['materialized']).toEqual(actual);
    expect(receipt['source_digest_sha256']).toBe(sha256(sourceBytes));
    expect(receipt['policy_version']).toBe(source['policy_version']);
    expect(Array.isArray(receipt['retired_keys'])).toBe(true);
  });
});
