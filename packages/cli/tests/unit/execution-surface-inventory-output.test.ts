// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Execution-surface acceptance: inventory discovery and every current
// action's machine success/refusal boundary remain complete and structured.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVENTORY_SLICES } from '@devai-nyx/sensors';
import { validators } from '@devai-nyx/schemas';
import {
  emitPreDispatchActionResult,
  renderActionFailure,
  renderActionSuccess,
} from '../../src/action-output.js';
import { renderHelp } from '../../src/command-router.js';
import { getFullRegistry, type RegistryEntry } from '../../src/define-command.js';

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT_CODE = process.exitCode;
const ORIGINAL_STDOUT = process.stdout.write;
let current: readonly RegistryEntry[] = [];

const EXPECTED_INVENTORY_SLICES = [
  { name: 'pack', members: ['stack-adapter-pack-resolution'] },
  { name: 'adherence', members: ['inventory-adherence'] },
  { name: 'components', members: ['component-inventory'] },
  { name: 'contracts', members: ['contract-inventory'] },
  { name: 'coverage', members: ['inventory-coverage'] },
  { name: 'dependencies', members: ['dependency-graph'] },
  { name: 'glossary', members: ['glossary-inventory'] },
  { name: 'modules', members: ['module-inventory'] },
  { name: 'routes', members: ['route-inventory'] },
  { name: 'schemas', members: ['schema-inventory'] },
  { name: 'tests', members: ['test-inventory'] },
  {
    name: 'all',
    members: [
      'stack-adapter-pack-resolution',
      'inventory-adherence',
      'component-inventory',
      'contract-inventory',
      'inventory-coverage',
      'dependency-graph',
      'glossary-inventory',
      'module-inventory',
      'route-inventory',
      'schema-inventory',
      'test-inventory',
    ],
  },
] as const;

beforeAll(async () => {
  process.argv = [process.execPath, 'devai', '--help'];
  process.stdout.write = (() => true) as typeof process.stdout.write;
  await import('../../src/bin.js');
  current = getFullRegistry();
  process.stdout.write = ORIGINAL_STDOUT;
  process.argv = [...ORIGINAL_ARGV];
});

afterAll(() => {
  process.argv = [...ORIGINAL_ARGV];
  process.exitCode = ORIGINAL_EXIT_CODE;
  process.stdout.write = ORIGINAL_STDOUT;
});

function parseEnvelope(text: string): Record<string, unknown> {
  const envelope = JSON.parse(text) as unknown;
  expect(validators.actionResult(envelope), JSON.stringify(validators.actionResult.errors)).toBe(
    true,
  );
  return envelope as Record<string, unknown>;
}

function emit(
  entry: RegistryEntry,
  result: Readonly<{ exit: number; stdout: string; stderr: string }>,
): Readonly<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const exitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  try {
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    expect(emitPreDispatchActionResult(entry, result)).toBe(true);
    return {
      stdout,
      stderr,
      exitCode: typeof process.exitCode === 'number' ? process.exitCode : undefined,
    };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.exitCode = exitCode;
  }
}

describe('execution-surface inventory discovery', () => {
  it('exposes every exact slice once and composes all in atomic slice order', () => {
    expect(INVENTORY_SLICES).toEqual(EXPECTED_INVENTORY_SLICES);
    expect(new Set(INVENTORY_SLICES.map((slice) => slice.name)).size).toBe(INVENTORY_SLICES.length);
    const atomicMembers = INVENTORY_SLICES.filter((slice) => slice.name !== 'all').flatMap(
      (slice) => slice.members,
    );
    expect(atomicMembers).toEqual(EXPECTED_INVENTORY_SLICES.at(-1)?.members);
    expect(new Set(atomicMembers).size).toBe(atomicMembers.length);
  });

  it('renders every inventory slice through the registered command help', () => {
    expect(current).toHaveLength(48);
    const help = renderHelp(current, '1.0.0', ['sense', 'inventory']);
    expect(help).toContain('Usage: devai sense inventory');
    expect(help).toContain('--slice <name>');
    for (const slice of INVENTORY_SLICES) expect(help, slice.name).toContain(slice.name);
    expect(help).toContain('without persistence');
  });

  it('labels check task operations as mutually exclusive in help', () => {
    const help = renderHelp(current, '1.2.8', ['check']);
    for (const option of ['--task-plan', '--run', '--status', '--explain']) {
      expect(help).toMatch(new RegExp(`${option}.*Task operation \\(choose one\\)`, 'u'));
    }
  });
});

describe('execution-surface action output totality', () => {
  it('emits one schema-valid empty success and one schema-valid refusal for every current action', () => {
    expect(current).toHaveLength(48);
    for (const entry of current) {
      const success = emit(entry, { exit: 0, stdout: '', stderr: '' });
      expect(success.stderr, entry.name).toBe('');
      expect(success.exitCode, entry.name).toBe(0);
      expect(parseEnvelope(success.stdout), entry.name).toMatchObject({
        schemaVersion: '1.0.0',
        action_id: entry.name,
        ok: true,
        result: { media_type: 'none', value: null },
      });

      const refusal = emit(entry, {
        exit: 2,
        stdout: '',
        stderr: `devai ${entry.path.join(' ')}: bounded refusal\n`,
      });
      expect(refusal.stdout, entry.name).toBe('');
      expect(refusal.exitCode, entry.name).toBe(2);
      expect(parseEnvelope(refusal.stderr), entry.name).toMatchObject({
        schemaVersion: '1.0.0',
        action_id: entry.name,
        ok: false,
        error: { class: 'routing-authority', exit: 2 },
      });
    }
  });

  it('maps every governed failure exit to a total structured error for every current action', () => {
    const expected = {
      2: { class: 'routing-authority', code: 'ACTION_INVOCATION_REFUSED' },
      3: { class: 'gate-fail', code: 'ACTION_GATE_FAILED' },
      4: { class: 'invalid-input', code: 'ACTION_INVOCATION_REFUSED' },
      5: { class: 'precondition', code: 'ACTION_PRECONDITION_UNSATISFIED' },
      6: { class: 'infrastructure', code: 'ACTION_INVOCATION_REFUSED' },
      7: { class: 'contract-violation', code: 'ACTION_OUTPUT_CONTRACT_VIOLATION' },
    } as const;

    for (const entry of current) {
      expect(parseEnvelope(renderActionSuccess(entry, '')), entry.name).toMatchObject({
        action_id: entry.name,
        ok: true,
      });
      for (const [rawExit, expectedError] of Object.entries(expected)) {
        const exit = Number(rawExit);
        expect(
          parseEnvelope(renderActionFailure(entry, 'bounded failure', exit)),
          entry.name,
        ).toMatchObject({
          action_id: entry.name,
          ok: false,
          error: { ...expectedError, exit },
        });
      }
    }
  });

  it('keeps parsed domain payloads in error context instead of stringifying them', () => {
    const entry = current[0];
    if (entry === undefined) throw new Error('action registry is empty');
    const payload = { status: 'fail', findings: [{ code: 'BUILD_SCRIPT_MISSING' }] };
    const envelope = parseEnvelope(renderActionFailure(entry, JSON.stringify(payload), 3)) as {
      error: { message: string; context: { payload: unknown } };
    };
    expect(envelope.error.context.payload).toEqual(payload);
    expect(() => JSON.parse(envelope.error.message)).toThrow();
  });

  it('transports REVIEW as a typed result at exit 1 for every current action', () => {
    for (const entry of current) {
      const review = emit(entry, {
        exit: 1,
        stdout: '',
        stderr: '',
      });
      expect(review.stderr, entry.name).toBe('');
      expect(review.exitCode, entry.name).toBe(1);
      expect(parseEnvelope(review.stdout), entry.name).toMatchObject({
        action_id: entry.name,
        ok: true,
        result: {
          verdict: 'review',
          media_type: 'none',
          value: null,
        },
      });
    }

    const doctor = current.find((entry) => entry.name === 'doctor');
    if (doctor === undefined) throw new Error('doctor action missing');
    const typed = emit(doctor, {
      exit: 1,
      stdout: '{"ok":false,"checks":[]}',
      stderr: '',
    });
    expect(parseEnvelope(typed.stdout)).toMatchObject({
      ok: true,
      result: {
        verdict: 'review',
        media_type: 'application/json',
        value: { ok: false, checks: [] },
      },
    });
  });
});
