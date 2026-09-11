import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAIL, EXIT_PASS } from '../../../utils/src/exit.js';

const controls = vi.hoisted(() => ({
  head: 'a'.repeat(40),
  validateScorecard: Object.assign(vi.fn(), { errors: null as unknown }),
}));

const mocks = vi.hoisted(() => ({
  computeScorecard: vi.fn(),
  loadReadingsFromDir: vi.fn(),
  loadScorecardFailureMaxAgeMs: vi.fn(),
  loadScorecardNaConfig: vi.fn(),
  resolveScorecardNaPath: vi.fn(),
  scorecardNaCellSet: vi.fn(),
  spawnSync: vi.fn(),
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
  validators: { scorecard: controls.validateScorecard },
}));

import { auditScorecard } from '../../src/commands/audit/scorecard.js';

const AT = 'a'.repeat(40);
const SCORECARD = { overall: { verdict: 'PASS' }, cells: [] };

function actionForScorecard(): (options: {
  repoRoot?: string;
  at?: string;
  human?: boolean;
}) => void {
  let action: ((options: { repoRoot?: string; at?: string; human?: boolean }) => void) | undefined;
  const chain = {
    option: () => chain,
    action: (value: typeof action) => {
      action = value;
      return chain;
    },
  };
  auditScorecard.register({ command: () => chain } as unknown as CAC);
  if (action === undefined) throw new Error('audit scorecard action missing');
  return action;
}

let stdout = '';
let stderr = '';
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  controls.head = AT;
  controls.validateScorecard.mockReturnValue(true);
  controls.validateScorecard.errors = null;
  mocks.spawnSync.mockImplementation((_command, args: readonly string[]) =>
    args[0] === 'rev-parse'
      ? { status: 0, stdout: `${controls.head}\n`, stderr: '' }
      : { status: 0, stdout: '2026-09-11T12:00:00Z\n', stderr: '' },
  );
  mocks.loadReadingsFromDir.mockReturnValue([]);
  mocks.resolveScorecardNaPath.mockReturnValue(
    '/fixture/repository/.devai/config/scorecard-na.json',
  );
  mocks.loadScorecardNaConfig.mockReturnValue({ schemaVersion: '1.0.0', cells: [] });
  mocks.scorecardNaCellSet.mockReturnValue(new Set());
  mocks.loadScorecardFailureMaxAgeMs.mockReturnValue(86_400_000);
  mocks.computeScorecard.mockReturnValue(SCORECARD);
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

describe('CLI shard 09 audit scorecard diagnostics', () => {
  it('reports trimmed Git stderr under the HEAD failure code', () => {
    mocks.spawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: '  fatal: not a git repository\n',
    });

    actionForScorecard()({ repoRoot: '/fixture/repository', at: AT });

    expect(process.exitCode).toBe(EXIT_FAIL);
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'devai audit scorecard: AUDIT_SCORECARD_HEAD_UNAVAILABLE:fatal: not a git repository\n',
    );
  });

  it('falls back to trimmed Git stdout under the timestamp failure code', () => {
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: `${AT}\n`, stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '  usage: git show\n', stderr: '   \n' });

    actionForScorecard()({ repoRoot: '/fixture/repository', at: AT });

    expect(process.exitCode).toBe(EXIT_FAIL);
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'devai audit scorecard: AUDIT_SCORECARD_TIMESTAMP_UNAVAILABLE:usage: git show\n',
    );
  });

  it('refuses a repository HEAD that differs from the requested commit', () => {
    controls.head = 'b'.repeat(40);

    actionForScorecard()({ repoRoot: '/fixture/repository', at: AT });

    expect(process.exitCode).toBe(EXIT_FAIL);
    expect(stdout).toBe('');
    expect(stderr).toBe('devai audit scorecard: AUDIT_SCORECARD_EXACT_HEAD_REQUIRED\n');
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('reports validator errors instead of emitting an invalid scorecard', () => {
    const errors = [{ instancePath: '/overall/verdict', keyword: 'enum' }];
    controls.validateScorecard.mockReturnValue(false);
    controls.validateScorecard.errors = errors;

    actionForScorecard()({ repoRoot: '/fixture/repository', at: AT });

    expect(process.exitCode).toBe(EXIT_FAIL);
    expect(stdout).toBe('');
    expect(stderr).toBe(
      `devai audit scorecard: AUDIT_SCORECARD_INVALID:${JSON.stringify(errors)}\n`,
    );
  });

  it('renders the human summary only when human is true', () => {
    actionForScorecard()({ repoRoot: '/fixture/repository', at: AT, human: true });

    expect(process.exitCode).toBe(EXIT_PASS);
    expect(stderr).toBe('');
    expect(stdout).toBe(`audit scorecard: PASS ${AT}\n`);
  });

  it('loads readings from the canonical repository freshness directory', () => {
    actionForScorecard()({ repoRoot: '/fixture/repository', at: AT });

    expect(process.exitCode).toBe(EXIT_PASS);
    expect(mocks.loadReadingsFromDir).toHaveBeenCalledOnce();
    expect(mocks.loadReadingsFromDir).toHaveBeenCalledWith(
      '/fixture/repository/record/proofs/freshness/readings',
    );
  });
});
