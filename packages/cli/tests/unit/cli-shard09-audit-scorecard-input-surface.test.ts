import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  computeScorecard: vi.fn(),
  loadReadingsFromDir: vi.fn(),
  loadScorecardFailureMaxAgeMs: vi.fn(),
  loadScorecardNaConfig: vi.fn(),
  resolveScorecardNaPath: vi.fn(),
  scorecardNaCellSet: vi.fn(),
  spawnSync: vi.fn(),
  validateScorecard: vi.fn(),
}));

vi.mock('@devai-nyx/authority', () => ({ spawnSync: mocks.spawnSync }));
vi.mock('@devai-nyx/loop', () => ({
  computeScorecard: mocks.computeScorecard,
  loadReadingsFromDir: mocks.loadReadingsFromDir,
  loadScorecardFailureMaxAgeMs: mocks.loadScorecardFailureMaxAgeMs,
  loadScorecardNaConfig: mocks.loadScorecardNaConfig,
  resolveScorecardNaPath: mocks.resolveScorecardNaPath,
  scorecardNaCellSet: mocks.scorecardNaCellSet,
}));
vi.mock('@devai-nyx/schemas', () => ({
  validators: {
    scorecard: Object.assign(mocks.validateScorecard, { errors: [] }),
  },
}));

import { auditScorecard } from '../../src/commands/audit/scorecard.js';
import { EXIT_USAGE } from '../../../utils/src/exit.js';

interface CapturedRegistration {
  readonly action: (options: { repoRoot?: string; at?: string; human?: boolean }) => void;
  readonly command: readonly unknown[];
  readonly options: readonly (readonly unknown[])[];
}

function captureRegistration(): CapturedRegistration {
  let action: CapturedRegistration['action'] | undefined;
  const options: unknown[][] = [];
  const chain = {
    option: (...args: unknown[]) => {
      options.push(args);
      return chain;
    },
    action: (value: CapturedRegistration['action']) => {
      action = value;
      return chain;
    },
  };
  const command = vi.fn(() => chain);
  auditScorecard.register({ command } as unknown as CAC);
  expect(action).toBeTypeOf('function');
  if (action === undefined) throw new Error('audit scorecard action missing');
  return { action, command: command.mock.calls[0] ?? [], options };
}

let stdout = '';
let stderr = '';
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe('CLI shard 09 audit scorecard input surface', () => {
  it('documents the command and every registered option with a non-empty description', () => {
    const registration = captureRegistration();

    expect(auditScorecard.description.trim()).not.toBe('');
    expect(registration.command).toHaveLength(2);
    expect(registration.command[0]).toBe('audit-scorecard');
    expect(String(registration.command[1]).trim()).not.toBe('');
    expect(registration.options.map(([flags]) => flags)).toEqual([
      '--repo-root <path>',
      '--at <full-sha>',
      '--human',
    ]);
    expect(registration.options.every(([, description]) => String(description).trim() !== '')).toBe(
      true,
    );
  });

  it('refuses malformed exact commit input before invoking Git', () => {
    for (const at of [`x${'a'.repeat(40)}`, `${'a'.repeat(40)}x`, 'A'.repeat(40)]) {
      const { action } = captureRegistration();
      process.exitCode = undefined;
      stdout = '';
      stderr = '';
      mocks.spawnSync.mockClear();

      action({ repoRoot: '/fixture/repository', at });

      expect(process.exitCode).toBe(EXIT_USAGE);
      expect(stdout).toBe('');
      expect(stderr).toBe('devai audit scorecard: --at requires a full 40-character SHA\n');
      expect(mocks.spawnSync).not.toHaveBeenCalled();
    }
  });
});
