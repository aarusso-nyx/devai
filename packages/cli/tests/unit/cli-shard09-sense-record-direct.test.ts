import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthorityHostTestScope } from '../../../authority/tests/unit/authority-host-test-scope.js';
import { recordSensorReading } from '../../src/commands/sense/record.js';

const authorityCalls = vi.hoisted(() => ({
  mkdir: [] as Array<readonly [string, { readonly recursive: true }]>,
  write: [] as Array<readonly [string, string, { readonly flag: string }]>,
}));

vi.mock('@devai-nyx/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@devai-nyx/authority')>();
  return {
    ...actual,
    mkdirSync: (path: string, options: { readonly recursive: true }) => {
      authorityCalls.mkdir.push([path, options]);
      return actual.mkdirSync(path, options);
    },
    writeFileSync: (path: string, data: string, options: { readonly flag: string }) => {
      authorityCalls.write.push([path, data, options]);
      return actual.writeFileSync(path, data, options);
    },
  };
});

const roots: string[] = [];

beforeEach(() => {
  authorityCalls.mkdir.length = 0;
  authorityCalls.write.length = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-shard09-record-direct-'));
  roots.push(root);
  return root;
}

function canonicalReading() {
  return {
    schemaVersion: '1.0.0' as const,
    id: 'SR-0123456789abcdef',
    sensor: { name: 'inventory:api', kind: 'inventory_api' as const, version: '1.0.0' },
    timestamp: '2026-09-11T09:00:00.000Z',
    status: 'pass' as const,
    deterministic: true,
    command: 'devai sense run inventory_api',
    command_hash: 'a'.repeat(64),
    tier: 'L0' as const,
    findings: [
      {
        severity: 'info' as const,
        code: 'DIRECT_RECORD_TEST',
        message: 'Direct record test fixture.',
      },
    ],
  };
}

function put(root: string, relative: string, body: string): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

describe('sense record direct contract', () => {
  it('rejects malformed and schema-invalid input before persistence', () => {
    const root = makeRoot();
    put(root, 'malformed.json', '{');
    expect(() => recordSensorReading(root, 'malformed.json')).toThrow(SyntaxError);

    const invalid = { ...canonicalReading(), schemaVersion: '2.0.0' };
    put(root, 'invalid.json', JSON.stringify(invalid));
    expect(validators.sensorReading(invalid)).toBe(false);
    const diagnostic = JSON.stringify(validators.sensorReading.errors);
    expect(() => recordSensorReading(root, 'invalid.json')).toThrow(
      `SENSE_RECORD_INVALID_READING:${diagnostic}`,
    );

    expect(authorityCalls.mkdir).toEqual([]);
    expect(authorityCalls.write).toEqual([]);
  });

  it('accepts one registry kind and canonical id before exclusive persistence', async () => {
    const root = makeRoot();
    const reading = canonicalReading();
    put(root, 'reading.json', JSON.stringify(reading));

    const result = await withAuthorityHostTestScope(() =>
      recordSensorReading(root, 'reading.json'),
    );
    const target = join(
      root,
      '.devai/state/sensor-readings/inventory_api/SR-0123456789abcdef.json',
    );
    expect(result).toEqual({ path: target, action: 'created', reading });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('writes exact canonical bytes once with exclusive creation', async () => {
    const root = makeRoot();
    const reading = canonicalReading();
    put(root, 'reading.json', JSON.stringify(reading));

    const result = await withAuthorityHostTestScope(() =>
      recordSensorReading(root, 'reading.json'),
    );
    const directory = join(root, '.devai/state/sensor-readings/inventory_api');
    const target = join(directory, 'SR-0123456789abcdef.json');
    const canonical = `${JSON.stringify(reading, null, 2)}\n`;

    expect(result).toEqual({ path: target, action: 'created', reading });
    expect(Object.isFrozen(result)).toBe(true);
    // ADR-SCR-0008: the reading file is the first write and is written exactly once
    // with exclusive creation; the second write is one appended chain entry.
    const proofs = join(root, 'record/proofs');
    const chainPath = join(proofs, 'chain.json');
    expect(authorityCalls.mkdir).toEqual([
      [directory, { recursive: true }],
      [proofs, { recursive: true }],
    ]);
    expect(authorityCalls.write[0]).toEqual([target, canonical, { flag: 'wx' }]);
    expect(authorityCalls.write.filter(([path]) => path === target)).toHaveLength(1);
    const chainWrites = authorityCalls.write.slice(1);
    expect(chainWrites).toHaveLength(2);
    for (const [path, , options] of chainWrites) {
      expect(path.startsWith(`${chainPath}.tmp.`)).toBe(true);
      expect(options).toEqual({ flag: 'wx' });
    }
    expect(chainWrites[0]?.[1]).toBe(`${JSON.stringify({ head: null, records: [] }, null, 2)}\n`);
    expect(readFileSync(target, 'utf8')).toBe(canonical);

    const chain = JSON.parse(readFileSync(chainPath, 'utf8')) as {
      readonly records: readonly {
        readonly action: string;
        readonly status: string;
        readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
      }[];
    };
    expect(chainWrites[1]?.[1]).toBe(readFileSync(chainPath, 'utf8'));
    expect(chain.records).toHaveLength(1);
    expect(chain.records[0]).toMatchObject({
      action: 'sense.readings.record',
      status: 'completed',
    });
    expect(chain.records[0]?.artifacts).toContainEqual(
      expect.objectContaining({
        path: '.devai/state/sensor-readings/inventory_api/SR-0123456789abcdef.json',
        sha256: createHash('sha256').update(canonical).digest('hex'),
      }),
    );
  });

  it('distinguishes identical invalid and conflicting existing records', async () => {
    const root = makeRoot();
    const reading = canonicalReading();
    put(root, 'reading.json', JSON.stringify(reading));
    const created = await withAuthorityHostTestScope(() =>
      recordSensorReading(root, 'reading.json'),
    );

    authorityCalls.mkdir.length = 0;
    authorityCalls.write.length = 0;
    const repeated = await withAuthorityHostTestScope(() =>
      recordSensorReading(root, 'reading.json'),
    );
    expect(repeated).toEqual({ ...created, action: 'already-recorded' });
    expect(Object.isFrozen(repeated)).toBe(true);
    expect(authorityCalls.mkdir).toEqual([]);
    expect(authorityCalls.write).toEqual([]);

    writeFileSync(created.path, '{');
    try {
      recordSensorReading(root, 'reading.json');
      throw new Error('EXPECTED_EXISTING_INVALID');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`SENSE_RECORD_EXISTING_INVALID:${created.path}`);
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    }

    writeFileSync(created.path, JSON.stringify({ ...reading, status: 'fail' }));
    expect(() => recordSensorReading(root, 'reading.json')).toThrow(
      'SENSE_RECORD_ID_CONFLICT:SR-0123456789abcdef',
    );
  });
});
