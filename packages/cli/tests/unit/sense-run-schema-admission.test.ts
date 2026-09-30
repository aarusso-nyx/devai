// Invariants: ADR-SCR-0011 IA-005
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SENSOR_REGISTRY, type SensorRegistry } from '@devai-nyx/sensors/registry';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeArgv, type RouteResult } from '../../src/command-router.js';
import { canonicalRegistry } from '../../src/define-command.js';

const mocks = vi.hoisted(() => ({ sensorAdapter: vi.fn() }));

// A refused sensor must never reach its adapter; the spy proves no sensor started.
vi.mock('../../src/commands/sense/adapters.js', () => ({ sensorAdapter: mocks.sensorAdapter }));

const STORE = '.devai/state/sensor-readings';
const ENTRIES = canonicalRegistry();
const VERSION = '1.0.0';

function registryMarking(kind: string | undefined): Pick<SensorRegistry, 'entries'> {
  return {
    entries: SENSOR_REGISTRY.entries.map((entry) => {
      const { schema_admission: _marker, ...unmarked } = entry;
      return entry.kind === kind
        ? { ...unmarked, schema_admission: 'unsupported' as const }
        : unmarked;
    }),
  };
}

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-sense-schema-admission-'));
  roots.push(root);
  return root;
}

function route(args: readonly string[], registry: Pick<SensorRegistry, 'entries'>): RouteResult {
  return routeArgv(['node', '/cli.js', 'sense', 'run', ...args], ENTRIES, VERSION, registry);
}

// The router renders the CLI error object itself: code, exit, and context at the top level.
interface ErrorEnvelope {
  readonly code: string;
  readonly exit: number;
  readonly context: { readonly kinds: readonly string[]; readonly preset?: string };
}

function refusal(result: RouteResult): ErrorEnvelope {
  expect(result.kind).toBe('output');
  if (result.kind !== 'output') throw new Error('expected an output refusal');
  expect(result.exitCode).toBe(2);
  return JSON.parse(result.text) as ErrorEnvelope;
}

function readingsWritten(root: string): string[] {
  const store = join(root, STORE);
  return existsSync(store) ? readdirSync(store, { recursive: true }).map(String) : [];
}

afterEach(() => {
  mocks.sensorAdapter.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ADR-SCR-0011 IA-005: sense run refuses a schema-unsupported kind before it starts', () => {
  const marked = registryMarking('inventory_api');

  it('refuses the marked kind by name with SENSOR_KIND_SCHEMA_UNSUPPORTED and no reading', () => {
    const root = makeRoot();
    const envelope = refusal(
      route(['inventory_api', '--repo-root', root, '--format', 'json'], marked),
    );

    expect(envelope.code).toBe('SENSOR_KIND_SCHEMA_UNSUPPORTED');
    expect(envelope.exit).toBe(2);
    expect(envelope.context).toEqual({ kinds: ['inventory_api'] });
    expect(envelope).not.toHaveProperty('result');
    expect(JSON.stringify(envelope)).not.toMatch(/SR-[a-f0-9]{16}/u);
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();
    expect(readingsWritten(root)).toEqual([]);
  });

  it.each([
    [['--preset', 'sweep', '--round', 'R-0001']],
    [['--preset=sweep', '--round', 'R-0001']],
  ])('refuses the sweep preset %j that selects the marked kind', (selector) => {
    const root = makeRoot();
    const envelope = refusal(route([...selector, '--repo-root', root, '--format', 'json'], marked));

    expect(envelope.code).toBe('SENSOR_KIND_SCHEMA_UNSUPPORTED');
    expect(envelope.exit).toBe(2);
    expect(envelope.context).toEqual({ kinds: ['inventory_api'], preset: 'sweep' });
    expect(envelope).not.toHaveProperty('result');
    expect(JSON.stringify(envelope)).not.toMatch(/SR-[a-f0-9]{16}/u);
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();
    expect(readingsWritten(root)).toEqual([]);
  });

  it('does not refuse an admitted kind in the registry that marks another', () => {
    const result = route(['build', '--repo-root', '/repo', '--format', 'json'], marked);

    expect(result.kind).toBe('dispatch');
    expect(JSON.stringify(result)).not.toContain('SENSOR_KIND_SCHEMA_UNSUPPORTED');
  });

  it('refuses nothing when no registry entry carries the marker', () => {
    const unmarked = registryMarking(undefined);
    for (const args of [['inventory_api'], ['--preset', 'sweep', '--round', 'R-0001']]) {
      const result = route([...args, '--repo-root', '/repo', '--format', 'json'], unmarked);
      expect(result.kind, args.join(' ')).toBe('dispatch');
    }
    // The inline form is not an accepted selection outside the admission check; it may be
    // refused as a selection error, but never for schema admission.
    const inline = route(
      ['--preset=sweep', '--round', 'R-0001', '--repo-root', '/repo', '--format', 'json'],
      unmarked,
    );
    expect(JSON.stringify(inline)).not.toContain('SENSOR_KIND_SCHEMA_UNSUPPORTED');
    expect(route(['inventory_api', '--repo-root', '/repo'], SENSOR_REGISTRY).kind).toBe('dispatch');
    expect(mocks.sensorAdapter).not.toHaveBeenCalled();
  });
});
