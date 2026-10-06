// #235 (F5:T4): INV-DEVAI-010 and INV-HARNESS-010 gain gate producers in the pull request
// preflight step, `check --only blueprint` and `sense inventory --slice pack` on committed
// fixtures. Both actions persist nothing, so the harness_invariant_alignment adapter observes
// the same read-only compositions in process at the candidate head, as ADR-SCR-0013 does for
// `audit scorecard`, and scopes each observation to the invariant it measures.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { senseHarnessInvariantAlignment } from '@devai-nyx/sensors';

const scorecard = vi.hoisted(() => ({
  scorecardHead: vi.fn(),
  composeExactHeadScorecard: vi.fn(),
}));
vi.mock('../../src/commands/audit/scorecard.js', () => scorecard);

import {
  GATE_BLUEPRINT_FIXTURE,
  GATE_PACK_FIXTURE,
  observeBlueprintCheck,
  observeGateProducers,
  observePackResolution,
} from '../../src/commands/sense/adapter-readers.js';
import { executeInventorySlice } from '../../src/commands/sense/inventory.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const HEAD = 'b'.repeat(40);
const WORKFLOW = '.github/workflows/pull-request-checks.yml';
const roots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-gate-producers-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  scorecard.scorecardHead.mockReset();
  scorecard.composeExactHeadScorecard.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pack resolution against an explicit packs root', () => {
  it('resolves the specific gate pack by signal hits over the higher-priority baseline', async () => {
    const fixture = resolve(ROOT, GATE_PACK_FIXTURE);
    const output = await executeInventorySlice('pack', {
      repoRoot: ROOT,
      packsRoot: fixture,
      adopterRoot: fixture,
    });
    expect(output.status).toBe('pass');
    const value = output.results[0]?.value as {
      matched: { id: string } | null;
      ambiguous: boolean;
      candidates: readonly { pack: { id: string } }[];
    };
    expect(value.matched?.id).toBe('redox-pack-gate-specific');
    expect(value.ambiguous).toBe(false);
    expect(value.candidates.map((candidate) => candidate.pack.id)).toEqual([
      'redox-pack-gate-specific',
      'redox-pack-gate-baseline',
    ]);
  });

  it('keeps the repository root as the pack registry without a packs root', async () => {
    const output = await executeInventorySlice('pack', { repoRoot: temporary() });
    expect(output.status).toBe('review');
    expect(output.results[0]?.value).toEqual({ matched: null, candidates: [], ambiguous: false });
  });
});

describe('fixture-bound gate producer observations', () => {
  it('observes a passing blueprint check and pack resolution bound to the head, scoped to their invariants', async () => {
    expect(observeBlueprintCheck(ROOT, HEAD)).toEqual([
      {
        command: `devai check --only blueprint --file ${GATE_BLUEPRINT_FIXTURE}`,
        status: 'pass',
        candidate_sha: HEAD,
        completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        invariant_ids: ['INV-DEVAI-010'],
      },
    ]);
    expect(await observePackResolution(ROOT, HEAD)).toEqual([
      {
        command: `devai sense inventory --slice pack --packs-root ${GATE_PACK_FIXTURE} --adopter-root ${GATE_PACK_FIXTURE}`,
        status: 'pass',
        candidate_sha: HEAD,
        completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        invariant_ids: ['INV-HARNESS-010'],
      },
    ]);
  });

  it('reads fail when the fixtures are absent or invalid, and observes nothing without a full head', async () => {
    const root = temporary();
    expect(observeBlueprintCheck(root, HEAD)).toMatchObject([{ status: 'fail' }]);
    expect(await observePackResolution(root, HEAD)).toMatchObject([{ status: 'fail' }]);
    mkdirSync(join(root, GATE_BLUEPRINT_FIXTURE, '..'), { recursive: true });
    const blueprint = JSON.parse(readFileSync(resolve(ROOT, GATE_BLUEPRINT_FIXTURE), 'utf8')) as {
      database: { entities: { primaryKey: string[] }[] };
    };
    const entity = blueprint.database.entities[0];
    if (entity === undefined) throw new Error('fixture entity missing');
    entity.primaryKey = [];
    writeFileSync(join(root, GATE_BLUEPRINT_FIXTURE), JSON.stringify(blueprint));
    expect(observeBlueprintCheck(root, HEAD)).toMatchObject([{ status: 'fail' }]);
    expect(observeBlueprintCheck(ROOT, 'HEAD')).toEqual([]);
    expect(await observePackResolution(ROOT, 'HEAD')).toEqual([]);
  });

  it('collects the scorecard and both fixture observations at one head', async () => {
    scorecard.scorecardHead.mockReturnValue(HEAD);
    scorecard.composeExactHeadScorecard.mockReturnValue({ cells: [] });
    const observations = await observeGateProducers(ROOT);
    expect(observations.map((observation) => observation.command)).toEqual([
      `devai audit scorecard --repo-root . --at ${HEAD}`,
      `devai check --only blueprint --file ${GATE_BLUEPRINT_FIXTURE}`,
      `devai sense inventory --slice pack --packs-root ${GATE_PACK_FIXTURE} --adopter-root ${GATE_PACK_FIXTURE}`,
    ]);
    expect(new Set(observations.map((observation) => observation.candidate_sha))).toEqual(
      new Set([HEAD]),
    );
    scorecard.scorecardHead.mockImplementation(() => {
      throw new Error('AUDIT_SCORECARD_HEAD_UNAVAILABLE:not a repository');
    });
    expect(await observeGateProducers(ROOT)).toEqual([]);
  });
});

describe('the pull request preflight step carries both producers', () => {
  // The workflow parser reads workflows only under the repository root it senses, so each
  // case copies the committed workflow and the two invariants into a scratch repository.
  function alignment(transform: (text: string) => string = (text) => text) {
    const root = temporary();
    mkdirSync(join(root, 'law/invariants'), { recursive: true });
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    mkdirSync(join(root, 'evidence'), { recursive: true });
    for (const id of ['INV-DEVAI-010', 'INV-HARNESS-010']) {
      copyFileSync(
        join(ROOT, 'law/invariants', `${id}.json`),
        join(root, 'law/invariants', `${id}.json`),
      );
    }
    writeFileSync(join(root, WORKFLOW), transform(readFileSync(join(ROOT, WORKFLOW), 'utf8')));
    return senseHarnessInvariantAlignment({
      repoRoot: root,
      evidenceDir: 'evidence',
      candidateHead: HEAD,
      now: '2026-10-06T12:00:00.000Z',
      observations: [
        {
          command: `devai check --only blueprint --file ${GATE_BLUEPRINT_FIXTURE}`,
          status: 'pass',
          candidate_sha: HEAD,
          completed_at: '2026-10-06T11:00:00.000Z',
          invariant_ids: ['INV-DEVAI-010'],
        },
        {
          command: `devai sense inventory --slice pack --packs-root ${GATE_PACK_FIXTURE} --adopter-root ${GATE_PACK_FIXTURE}`,
          status: 'pass',
          candidate_sha: HEAD,
          completed_at: '2026-10-06T11:00:00.000Z',
          invariant_ids: ['INV-HARNESS-010'],
        },
      ],
    });
  }

  it('aligns both invariants on the committed workflow', () => {
    const text = readFileSync(join(ROOT, WORKFLOW), 'utf8');
    expect(text).toContain(`check --only blueprint --file ${GATE_BLUEPRINT_FIXTURE}`);
    expect(text).toContain(
      `sense inventory --slice pack --packs-root ${GATE_PACK_FIXTURE} --adopter-root ${GATE_PACK_FIXTURE}`,
    );
    const reading = alignment();
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ gate_invariants: 2, misaligned: 0 });
  });

  it('leaves INV-HARNESS-010 misaligned when the pack producer line is removed', () => {
    const reading = alignment((text) =>
      text
        .split('\n')
        .filter((line) => !line.includes('sense inventory --slice pack'))
        .join('\n'),
    );
    expect(reading.metrics).toMatchObject({ misaligned: 1 });
    expect((reading.findings ?? []).map((finding) => finding.message).join('\n')).toContain(
      'INV-HARNESS-010',
    );
  });
});
