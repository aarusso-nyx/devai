// Invariants: INV-DEVAI-001, INV-DEVAI-002
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENSOR_DESCRIPTORS } from '../../packages/sensors/src/index.js';
import { describe, expect, it } from 'vitest';
import { subprocessCoverageEnvironment } from '../helpers/subprocess-coverage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(
  HERE,
  '..',
  '..',
  'packages',
  'cli',
  'tests',
  'fixtures',
  'authorized-cli-test-driver.mjs',
);
const skipIfNotBuilt = existsSync(BIN) ? it : it.skip;

describe('R29 sensor descriptor CLI parity', () => {
  skipIfNotBuilt('binds all 59 descriptors through the one live `sense run <kind>` action', () => {
    const result = spawnSync('node', [BIN, 'catalog', 'actions'], {
      encoding: 'utf8',
      env: subprocessCoverageEnvironment(),
    });
    expect(result.status, result.stderr).toBe(0);
    const actions = new Set(
      (JSON.parse(result.stdout) as Array<{ name: string }>).map((action) => action.name),
    );
    const commands = SENSOR_DESCRIPTORS.flatMap((descriptor) =>
      descriptor.command === null ? [] : [descriptor.command],
    );
    expect(SENSOR_DESCRIPTORS).toHaveLength(59);
    expect(new Set(commands).size).toBe(commands.length);
    expect(actions.has('sense run')).toBe(true);
    for (const command of commands) expect(command).toMatch(/^sense run [a-z0-9_]+$/);
  });
});
