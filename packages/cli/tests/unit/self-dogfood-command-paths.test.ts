import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cac, type CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { buildSensorReading } from '../../../sensors/src/sensor-reading.js';

// ADR-SCR-0001 inspector acceptance, discharged through the command paths
// (cli-runtime, `sense run`, `sense record`, `audit observe`) on a fixture
// repository that carries the framework's self-dogfood policy.

const mocks = vi.hoisted(() => ({
  sensorAdapter: vi.fn(),
  runAuditObservation: vi.fn(),
  appendVerbEvidence: vi.fn(),
  loadChain: vi.fn(),
}));

vi.mock('../../src/commands/sense/adapters.js', () => ({ sensorAdapter: mocks.sensorAdapter }));
vi.mock('@devai-nyx/skills', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAuditObservation: mocks.runAuditObservation,
}));
vi.mock('#runtime-core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appendVerbEvidence: mocks.appendVerbEvidence,
  loadChain: mocks.loadChain,
}));

const { invokeDevaiCli } = await import('../../src/cli-runtime.js');
const { disposeCliInvocationAuthority, rememberResolvedInvocationAuthority } =
  await import('../../src/authority/index.js');
const { declareSelfDogfoodInvocation } = await import('../../src/services/self-dogfood.js');
const { senseRunSetCmd } = await import('../../src/commands/sense/run-set.js');
const { senseRecordCmd } = await import('../../src/commands/sense/record.js');
const { auditObserve } = await import('../../src/commands/audit/observe.js');

type Role = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
const ROLES: readonly Role[] = ['owner', 'architect', 'inspector', 'engineer', 'auditor'];
const NON_INSPECTORS = ROLES.filter((role) => role !== 'inspector');
const FRAMEWORK_POLICY = readFileSync(
  resolve(import.meta.dirname, '../../../../law/policy/self-dogfood.json'),
  'utf8',
);
const PINNED_CONSTITUTION = readFileSync(
  resolve(import.meta.dirname, '../../../../.devai/pin/constitution.md'),
);
const SHA = 'a'.repeat(40);
const READ_KIND = 'decision_record_integrity';
const REMOTE_KIND = 'llm_judge';

interface Result {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

const roots: string[] = [];

function repository(policy: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-self-dogfood-paths-'));
  roots.push(root);
  // The pinned constitution is what a read-effect action needs from a fixture.
  mkdirSync(join(root, '.devai/pin'), { recursive: true });
  writeFileSync(join(root, '.devai/pin/constitution.md'), PINNED_CONSTITUTION);
  if (policy !== undefined) {
    mkdirSync(join(root, 'law/policy'), { recursive: true });
    writeFileSync(join(root, 'law/policy/self-dogfood.json'), policy);
  }
  return root;
}

function framework(): string {
  return repository(FRAMEWORK_POLICY);
}

function adopter(): string {
  return repository(undefined);
}

function readingInput(root: string) {
  const reading = buildSensorReading({
    sensorName: 'build',
    sensorKind: 'build',
    command: ['pnpm', 'build'],
    status: 'pass',
    deterministic: true,
    timestamp: '2026-09-27T08:00:00.000Z',
  });
  const input = join(root, 'reading.json');
  writeFileSync(input, `${JSON.stringify(reading)}\n`);
  return {
    input,
    target: join(root, '.devai/state/sensor-readings/build', `${reading.id}.json`),
  };
}

function refusal(result: Result): { readonly code: string; readonly reasons: readonly string[] } {
  expect(result.stdout).toBe('');
  const parsed = JSON.parse(result.stderr) as {
    readonly code?: string;
    readonly context?: { readonly reasons?: readonly string[] };
    readonly error?: {
      readonly code: string;
      readonly context?: { readonly reasons?: readonly string[] };
    };
  };
  const error = parsed.error ?? parsed;
  return { code: String(error.code), reasons: error.context?.reasons ?? [] };
}

function envelopeValue(result: Result): Record<string, unknown> {
  expect(result.stderr).toBe('');
  return (JSON.parse(result.stdout) as { result: { value: Record<string, unknown> } }).result.value;
}

async function cli(args: readonly string[]): Promise<Result> {
  const result = await invokeDevaiCli([...args, '--format', 'json']);
  return { exit: result.exit_code, stdout: result.stdout, stderr: result.stderr };
}

async function handler(
  register: (cli: CAC) => void,
  argv: readonly string[],
  authority?: Role,
): Promise<Result> {
  const program = cac('devai-self-dogfood-paths');
  register(program);
  const original = {
    argv: process.argv,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    if (authority !== undefined) {
      rememberResolvedInvocationAuthority(authority, 'cli-flag', ['--write']);
    }
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
    program.parse(process.argv, { run: false });
    await withAuthorityHostTestScope(() => program.runMatchedCommand());
    await new Promise<void>((done) => setImmediate(done));
    return { exit: typeof process.exitCode === 'number' ? process.exitCode : 0, stdout, stderr };
  } finally {
    disposeCliInvocationAuthority();
    process.argv = original.argv;
    process.exitCode = original.exitCode;
    process.stdout.write = original.stdout;
    process.stderr.write = original.stderr;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sensorAdapter.mockImplementation(
    (kind: string) => () =>
      Promise.resolve({
        ...buildSensorReading({
          sensorName: kind,
          sensorKind: kind,
          command: ['fixture', kind],
          status: 'pass',
          deterministic: true,
          timestamp: '2026-09-27T08:00:00.000Z',
        }),
      }),
  );
  mocks.runAuditObservation.mockResolvedValue({
    status: 'completed',
    at: SHA,
    readiness_promoting: false,
    observation_root: `.devai/state/audit-observations/${SHA}`,
    artifacts: [{ path: 'scorecard.json', sha256: '1'.repeat(64) }],
  });
  mocks.loadChain.mockReturnValue({ records: [] });
  mocks.appendVerbEvidence.mockReturnValue({ ok: true, id: 'EVIDENCE-1' });
});

afterEach(() => {
  declareSelfDogfoodInvocation(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ADR-SCR-0001 self-dogfood admission through the command paths', () => {
  it('IA-001 admits a read-effect sense run for every declared role', async () => {
    const root = framework();
    for (const role of ROLES) {
      const dry = await cli([
        'sense',
        'run',
        READ_KIND,
        '--repo-root',
        root,
        '--as-role',
        role,
        '--dry-run',
      ]);
      expect(dry.exit).toBe(0);
      expect(envelopeValue(dry).self_dogfood).toEqual({
        applies: true,
        policy: 'law/policy/self-dogfood.json',
        action_id: 'sense run',
        declared_role: role,
        write_consent: false,
        decision: {
          ok: true,
          check_id: 'sense run',
          role,
          effect: 'read',
          produces_readiness_claim: false,
          grants_publication_authority: false,
        },
      });
    }
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();

    const run = await cli(['sense', 'run', READ_KIND, '--repo-root', root, '--as-role', 'auditor']);
    expect(run.exit).toBe(0);
    expect(mocks.sensorAdapter).toHaveBeenCalledWith(READ_KIND);

    // The admission is taken from a declared role: nothing is inferred.
    mocks.sensorAdapter.mockClear();
    const undeclared = await cli(['sense', 'run', READ_KIND, '--repo-root', root]);
    expect(undeclared.exit).toBe(2);
    expect(refusal(undeclared)).toEqual({
      code: 'POLICY_DENY',
      reasons: expect.arrayContaining([
        'inferred-role',
        'absent-human-invocation',
      ]) as unknown as string[],
    });
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();

    // Write consent on sense run is harness-write: the inspector row only.
    const engineer = await cli([
      'sense',
      'run',
      READ_KIND,
      '--repo-root',
      root,
      '--as-role',
      'engineer',
      '--write',
    ]);
    expect(refusal(engineer)).toEqual({
      code: 'POLICY_DENY',
      reasons: ['effect-outside-role-row'],
    });
    const inspector = await cli([
      'sense',
      'run',
      READ_KIND,
      '--repo-root',
      root,
      '--as-role',
      'inspector',
      '--write',
      '--dry-run',
    ]);
    expect(envelopeValue(inspector).self_dogfood).toMatchObject({
      decision: { ok: true, role: 'inspector', effect: 'harness-write' },
    });
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();
  });

  it('IA-002 refuses sense record and audit observe for every role but the inspector with write consent', async () => {
    for (const role of NON_INSPECTORS) {
      const root = framework();
      const { input, target } = readingInput(root);
      const recorded = await handler(
        (program) => senseRecordCmd.register(program),
        ['sense-record', '--repo-root', root, '--input', input],
        role,
      );
      expect(recorded.exit).toBe(2);
      expect(refusal(recorded).reasons).toContain('effect-outside-role-row');
      expect(existsSync(target)).toBe(false);

      const observed = await handler(
        (program) => auditObserve.register(program),
        ['audit-observe', '--repo-root', root, '--at', SHA],
        role,
      );
      expect(observed.exit).toBe(2);
      expect(refusal(observed).reasons).toContain('effect-outside-role-row');
    }
    expect(mocks.runAuditObservation).not.toHaveBeenCalled();
    expect(mocks.appendVerbEvidence).not.toHaveBeenCalled();

    const root = framework();
    const { input, target } = readingInput(root);
    const recorded = await handler(
      (program) => senseRecordCmd.register(program),
      ['sense-record', '--repo-root', root, '--input', input],
      'inspector',
    );
    expect(recorded.exit).toBe(0);
    expect(recorded.stderr).toBe('');
    expect(JSON.parse(recorded.stdout)).toMatchObject({
      action: 'created',
      attribution: { declaring_role: 'inspector', human_invocation: 'cli-flag' },
    });
    expect(existsSync(target)).toBe(true);

    const observed = await handler(
      (program) => auditObserve.register(program),
      ['audit-observe', '--repo-root', root, '--at', SHA],
      'inspector',
    );
    expect(observed.exit).toBe(0);
    expect(mocks.runAuditObservation).toHaveBeenCalledTimes(1);

    // The inspector without explicit write consent is refused before any write.
    declareSelfDogfoodInvocation({
      role: 'inspector',
      human_invoked: true,
      declaration_source: 'cli-flag',
      write_consent: false,
      publish: false,
    });
    const other = readingInput(framework());
    const unconsented = await handler(
      (program) => senseRecordCmd.register(program),
      ['sense-record', '--repo-root', dirname(other.input), '--input', other.input],
    );
    expect(refusal(unconsented).reasons).toEqual(['write-consent-absent']);
    expect(existsSync(other.target)).toBe(false);
  });

  it('IA-003 refuses --publish on every sense action before the policy is parsed', async () => {
    const root = framework();
    const unparsable = repository('{ not json');
    for (const repoRoot of [root, unparsable]) {
      for (const role of ROLES) {
        const run = await cli([
          'sense',
          'run',
          READ_KIND,
          '--repo-root',
          repoRoot,
          '--as-role',
          role,
          '--write',
          '--publish',
        ]);
        expect(run.exit).toBe(2);
        expect(refusal(run)).toEqual({ code: 'POLICY_DENY', reasons: ['publication-attempted'] });
      }
      const dry = await cli([
        'sense',
        'run',
        READ_KIND,
        '--repo-root',
        repoRoot,
        '--publish',
        '--dry-run',
      ]);
      expect(refusal(dry).reasons).toEqual(['publication-attempted']);
      const recorded = await cli([
        'sense',
        'record',
        '--repo-root',
        repoRoot,
        '--rebuild',
        '--as-role',
        'inspector',
        '--write',
        '--publish',
      ]);
      expect(refusal(recorded).reasons).toEqual(['publication-attempted']);
      const observed = await cli([
        'audit',
        'observe',
        '--repo-root',
        repoRoot,
        '--at',
        SHA,
        '--as-role',
        'inspector',
        '--write',
        '--publish',
      ]);
      expect(refusal(observed).reasons).toEqual(['publication-attempted']);
    }
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();
    expect(mocks.runAuditObservation).not.toHaveBeenCalled();
  });

  it('IA-004 refuses a population with a remote-write member even for the inspector with write consent', async () => {
    const root = framework();
    const run = await handler(
      (program) => senseRunSetCmd.register(program),
      ['sense-run', REMOTE_KIND, '--repo-root', root],
      'inspector',
    );
    expect(run.exit).toBe(2);
    expect(refusal(run).reasons).toEqual(
      expect.arrayContaining(['remote-effect-attempted', 'remote-write-population-member']),
    );
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();

    const dry = await handler(
      (program) => senseRunSetCmd.register(program),
      ['sense-run', REMOTE_KIND, '--repo-root', root, '--dry-run'],
      'inspector',
    );
    expect(dry.exit).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      aggregate_effect: 'remote-write',
      self_dogfood: {
        declared_role: 'inspector',
        write_consent: true,
        decision: { ok: false },
      },
    });
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();
  });

  it('IA-005 rejects a reading without the declaring role and the human invocation', async () => {
    const root = framework();
    const { input, target } = readingInput(root);
    declareSelfDogfoodInvocation({
      role: 'inspector',
      human_invoked: false,
      declaration_source: undefined,
      write_consent: true,
      publish: false,
    });
    const unattributed = await handler(
      (program) => senseRecordCmd.register(program),
      ['sense-record', '--repo-root', root, '--input', input],
    );
    expect(unattributed.exit).toBe(2);
    expect(refusal(unattributed).reasons).toEqual(
      expect.arrayContaining(['absent-human-invocation', 'unattributed-reading']),
    );
    declareSelfDogfoodInvocation(undefined);
    const anonymous = await handler(
      (program) => senseRecordCmd.register(program),
      ['sense-record', '--repo-root', root, '--rebuild'],
    );
    expect(refusal(anonymous).reasons).toEqual(
      expect.arrayContaining(['inferred-role', 'unattributed-reading']),
    );
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(root, '.devai/state/sensor-readings'))).toBe(false);
  });

  it('leaves an adopter repository without the policy unaffected', async () => {
    const root = adopter();
    const dry = await cli(['sense', 'run', READ_KIND, '--repo-root', root, '--dry-run']);
    expect(dry.exit).toBe(0);
    expect(envelopeValue(dry)).not.toHaveProperty('self_dogfood');
    const run = await cli(['sense', 'run', READ_KIND, '--repo-root', root]);
    expect(run.exit).toBe(0);
    expect(mocks.sensorAdapter).toHaveBeenCalledWith(READ_KIND);
    const published = await cli(['sense', 'run', READ_KIND, '--repo-root', root, '--publish']);
    expect(refusal(published).code).toBe('AUTHORITY_DECLARATION_NOT_APPLICABLE');

    const { input, target } = readingInput(root);
    const recorded = await handler(
      (program) => senseRecordCmd.register(program),
      ['sense-record', '--repo-root', root, '--input', input],
    );
    expect(recorded.exit).toBe(0);
    expect(JSON.parse(recorded.stdout)).not.toHaveProperty('attribution');
    expect(existsSync(target)).toBe(true);
    const observed = await handler(
      (program) => auditObserve.register(program),
      ['audit-observe', '--repo-root', root, '--at', SHA],
    );
    expect(observed.exit).toBe(0);
    expect(mocks.runAuditObservation).toHaveBeenCalledTimes(1);
  });
});
