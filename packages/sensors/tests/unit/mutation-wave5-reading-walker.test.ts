import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkFiles } from '../../src/inventory-walker.js';
import { buildSensorReading } from '../../src/sensor-reading.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-wave5-reading-walker-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relativePath: string): string {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, 'export const value = 1;\n');
  return absolute;
}

describe('wave5 sensor reading and inventory walker boundaries', () => {
  it('preserves supplied lifecycle and false killed fields', () => {
    const reading = buildSensorReading({
      sensorName: 'demo',
      sensorKind: 'lint',
      command: ['devai', 'lint'],
      status: 'pass',
      deterministic: true,
      timestamp: '2026-09-08T00:00:00.000Z',
      lifecycle: 'experimental',
      killed: false,
    });

    expect(reading).toMatchObject({
      lifecycle: 'experimental',
      killed: false,
    });
    expect('lifecycle' in reading).toBe(true);
    expect('killed' in reading).toBe(true);
  });

  it('defaults omitted skipDeclarations to true', () => {
    const keep = write('src/keep.ts');
    write('src/types.d.ts');

    const files = walkFiles(root, { extensions: ['ts'] });
    expect(files.map((file) => basename(file)).sort()).toStrictEqual(['keep.ts']);
    expect(files).toContain(keep);
  });

  it.skipIf(process.platform === 'win32')(
    'skips entries that are neither directories nor regular files',
    () => {
      write('src/keep.ts');
      const fifo = join(root, 'src/pipe.ts');
      mkdirSync(join(fifo, '..'), { recursive: true });
      execFileSync('mkfifo', [fifo]);

      const files = walkFiles(root, { extensions: ['ts'] });
      expect(files.map((file) => basename(file)).sort()).toStrictEqual(['keep.ts']);
    },
  );
});
