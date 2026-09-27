import type { CAC } from 'cac';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_FAIL, EXIT_PASS } from '../../../utils/src/exit.js';

const controls = vi.hoisted(() => ({
  head: 'a'.repeat(40),
  validateScorecard: Object.assign(vi.fn(), { errors: null as unknown }),
}));

// ADR-SCR-0002: the facade's only loop dependency is the shared input
// resolver, which walks .devai/state/sensor-readings and applies the
// N/A ledger. Mocking that one seam is the whole loop surface.
const mocks = vi.hoisted(() => ({
  resolveScorecardInputs: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('@devai-nyx/authority', () => ({ spawnSync: mocks.spawnSync }));
vi.mock('@devai-nyx/loop', () => ({
  resolveScorecardInputs: mocks.resolveScorecardInputs,
}));
vi.mock('@devai-nyx/schemas', () => ({
  validators: { scorecard: controls.validateScorecard },
}));

import { auditScorecard } from '../../src/commands/audit/scorecard.js';

const AT = 'a'.repeat(40);
const TIMESTAMP = '2026-09-11T12:00:00Z';
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
      : { status: 0, stdout: `${TIMESTAMP}\n`, stderr: '' },
  );
  mocks.resolveScorecardInputs.mockReturnValue({
    scorecard: SCORECARD,
    readings: [],
    source: 'empty',
  });
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

  it('resolves readings through the loop input resolver for the exact head and commit time', () => {
    actionForScorecard()({ repoRoot: '/fixture/repository', at: AT });

    expect(process.exitCode).toBe(EXIT_PASS);
    expect(mocks.resolveScorecardInputs).toHaveBeenCalledOnce();
    // No pre-populated inputs: the resolver falls through to its disk
    // walk of <repoRoot>/.devai/state/sensor-readings, the one store
    // sense record writes. The retired record/proofs/freshness/readings
    // path is never named by the facade.
    expect(mocks.resolveScorecardInputs).toHaveBeenCalledWith({
      repoRoot: '/fixture/repository',
      inputs: undefined,
      timestamp: TIMESTAMP,
      integrationHead: AT,
    });
    expect(stdout).toBe(`${JSON.stringify(SCORECARD)}\n`);
  });

  it('names the readings store only through the resolver, never a second path', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/commands/audit/scorecard.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toContain('record/proofs/freshness/readings');
    expect(source).not.toContain('loadReadingsFromDir');
    expect(source).toContain('resolveScorecardInputs');
  });

  it('does not resolve readings when the head guard or Git fails first', () => {
    controls.head = 'b'.repeat(40);

    actionForScorecard()({ repoRoot: '/fixture/repository', at: AT });

    expect(process.exitCode).toBe(EXIT_FAIL);
    expect(mocks.resolveScorecardInputs).not.toHaveBeenCalled();
  });
});
