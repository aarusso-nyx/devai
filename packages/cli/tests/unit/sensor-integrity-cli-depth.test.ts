import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_PASS, EXIT_REVIEW } from '@devai-nyx/utils';
import {
  checkSensorIntegrity,
  checkSensorIntegrityCmd,
} from '../../src/commands/check/sensor-integrity.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-sensor-integrity-cli-depth-'));
  roots.push(value);
  return value;
}

function put(rootPath: string, relativePath: string, value: unknown): void {
  const path = join(rootPath, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

function reading(id: string, kind: string, commandHash?: string): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    id,
    sensor: { name: `sensor-${kind}`, kind },
    timestamp: '2026-09-09T00:00:00.000Z',
    status: 'pass',
    deterministic: true,
    command: 'pnpm run governed-check',
    ...(commandHash === undefined ? {} : { command_hash: commandHash }),
  };
}

type CommandOptions = {
  readonly repoRoot?: string;
  readonly readingsDir?: string;
  readonly human?: boolean;
};
type Command = {
  option: () => Command;
  action: (callback: (options: CommandOptions) => void) => Command;
};

function captureAction(): { readonly invoke: (options: CommandOptions) => void } {
  let callback: ((options: CommandOptions) => void) | undefined;
  const command: Command = {
    option: () => command,
    action: (value) => {
      callback = value;
      return command;
    },
  };
  checkSensorIntegrityCmd.register({ command: () => command } as unknown as CAC);
  return {
    invoke: (options) => {
      if (callback === undefined) throw new Error('sensor-integrity command callback missing');
      callback(options);
    },
  };
}

describe('sensor-integrity CLI boundaries', () => {
  it('uses the default repository-relative readings directory and reports a relabel group', () => {
    const repo = root();
    const hash = 'a'.repeat(64);
    put(repo, '.devai/state/sensor-readings/a.json', reading('a', 'lint', hash));
    put(repo, '.devai/state/sensor-readings/b.json', reading('b', 'typecheck', hash));

    expect(checkSensorIntegrity({ repoRoot: repo })).toEqual({
      verdict: 'review',
      readings_scanned: 2,
      groups: [{ command_hash: hash, kinds: ['lint', 'typecheck'], reading_ids: ['a', 'b'] }],
    });
  });

  it('uses an explicit readings directory instead of the repository default', () => {
    const repo = root();
    const override = join(repo, 'captured-readings');
    const hash = 'b'.repeat(64);
    put(override, 'one.json', reading('one', 'inventory_api', hash));
    put(override, 'two.json', reading('two', 'inventory_routes', hash));

    expect(checkSensorIntegrity({ repoRoot: repo })).toEqual({
      verdict: 'pass',
      readings_scanned: 0,
      groups: [],
    });
    expect(checkSensorIntegrity({ repoRoot: repo, readingsDir: override })).toMatchObject({
      verdict: 'review',
      readings_scanned: 2,
      groups: [{ command_hash: hash, kinds: ['inventory_api', 'inventory_routes'] }],
    });
  });

  it('emits JSON and advisory exit codes for pass and review command invocations', () => {
    const repo = root();
    const override = join(repo, 'readings');
    put(override, 'pass.json', reading('pass', 'legacy-independent'));
    const command = captureAction();
    const originalWrite = process.stdout.write;
    const originalExitCode = process.exitCode;
    let output = '';
    try {
      process.stdout.write = ((chunk: string | Uint8Array) => {
        output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      }) as typeof process.stdout.write;
      process.exitCode = undefined;
      command.invoke({ repoRoot: repo, readingsDir: override });
      expect(JSON.parse(output)).toEqual({ verdict: 'pass', readings_scanned: 1, groups: [] });
      expect(process.exitCode).toBe(EXIT_PASS);

      output = '';
      const hash = 'c'.repeat(64);
      put(override, 'review-a.json', reading('review-a', 'lint', hash));
      put(override, 'review-b.json', reading('review-b', 'typecheck', hash));
      command.invoke({ repoRoot: repo, readingsDir: override, human: true });
      expect(output).toContain(
        'check sensor-integrity: REVIEW (3 reading(s) scanned, 1 relabeled group(s))',
      );
      expect(output).toContain(
        `command_hash ${hash.slice(0, 12)}… shared by kinds: lint, typecheck`,
      );
      expect(output).toContain('readings: review-a, review-b');
      expect(process.exitCode).toBe(EXIT_REVIEW);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
  });
});
