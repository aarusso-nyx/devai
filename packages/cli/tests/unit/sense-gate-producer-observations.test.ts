// #235 (F5:T4): INV-DEVAI-010 and INV-HARNESS-010 gain gate producers in the pull request
// preflight step, `check --only blueprint` and `sense inventory --slice pack` on committed
// fixtures. Both actions persist nothing, so the harness_invariant_alignment adapter observes
// the same read-only compositions in process at the candidate head, as ADR-SCR-0013 does for
// `audit scorecard`. Each is a scoped producer: only its exact CI invocation and its own
// passing observation, made on fixture bytes that match the head, align its invariant.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { senseHarnessInvariantAlignment, type AlignmentObservation } from '@devai-nyx/sensors';

const scorecard = vi.hoisted(() => ({
  scorecardHead: vi.fn(),
  composeExactHeadScorecard: vi.fn(),
}));
vi.mock('../../src/commands/audit/scorecard.js', () => scorecard);
// The fixture-to-head comparison reads git through the authority broker in production; the
// temporary repositories here are read with the same git verbs directly.
vi.mock('@devai-nyx/authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@devai-nyx/authority')>()),
  execFileSync: (await import('node:child_process')).execFileSync,
}));

import {
  GATE_BLUEPRINT_FIXTURE,
  GATE_PACK_FIXTURE,
  GATE_SCOPED_PRODUCERS,
  observeBlueprintCheck,
  observeGateProducers,
  observePackResolution,
} from '../../src/commands/sense/adapter-readers.js';
import { executeInventorySlice } from '../../src/commands/sense/inventory.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WORKFLOW = '.github/workflows/pull-request-checks.yml';
const BLUEPRINT_COMMAND = `devai check --only blueprint --file ${GATE_BLUEPRINT_FIXTURE}`;
const PACK_COMMAND = `devai sense inventory --slice pack --packs-root ${GATE_PACK_FIXTURE} --adopter-root ${GATE_PACK_FIXTURE}`;
const roots: string[] = [];

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-gate-producers-'));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

/** A repository whose only commit holds both committed fixtures; returns its root and head. */
function fixtureRepository(): { root: string; head: string } {
  const root = temporary();
  git(root, 'init', '-q');
  mkdirSync(dirname(join(root, GATE_BLUEPRINT_FIXTURE)), { recursive: true });
  copyFileSync(join(ROOT, GATE_BLUEPRINT_FIXTURE), join(root, GATE_BLUEPRINT_FIXTURE));
  cpSync(join(ROOT, GATE_PACK_FIXTURE), join(root, GATE_PACK_FIXTURE), { recursive: true });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixtures');
  return { root, head: git(root, 'rev-parse', 'HEAD') };
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
    const { root, head } = fixtureRepository();
    expect(observeBlueprintCheck(root, head)).toEqual([
      {
        command: BLUEPRINT_COMMAND,
        status: 'pass',
        candidate_sha: head,
        completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        invariant_ids: ['INV-DEVAI-010'],
      },
    ]);
    expect(await observePackResolution(root, head)).toEqual([
      {
        command: PACK_COMMAND,
        status: 'pass',
        candidate_sha: head,
        completed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        invariant_ids: ['INV-HARNESS-010'],
      },
    ]);
  });

  // Codex review MAJOR 3: the worktree bytes may differ from the head the reading names.
  // #235 re-review: git tracks a link as its target text, so a clean status proves nothing
  // about the bytes read through a committed link.
  it('reads fail for a committed symbolic link anywhere in the fixture paths', async () => {
    const outside = temporary();
    writeFileSync(
      join(outside, 'stack-adapter.json'),
      readFileSync(
        join(ROOT, GATE_PACK_FIXTURE, 'examples/redox-pack-gate-specific/stack-adapter.json'),
      ),
    );
    const manifest = fixtureRepository();
    const linked = join(
      manifest.root,
      GATE_PACK_FIXTURE,
      'examples/redox-pack-gate-specific/stack-adapter.json',
    );
    rmSync(linked);
    symlinkSync(join(outside, 'stack-adapter.json'), linked);
    git(manifest.root, 'add', '-A');
    git(manifest.root, 'commit', '-q', '-m', 'link the manifest');
    const manifestHead = git(manifest.root, 'rev-parse', 'HEAD');
    expect(git(manifest.root, 'status', '--porcelain')).toBe('');
    expect(await observePackResolution(manifest.root, manifestHead)).toMatchObject([
      { status: 'fail' },
    ]);

    const component = fixtureRepository();
    const real = join(component.root, 'real-fixtures');
    cpSync(join(component.root, dirname(GATE_BLUEPRINT_FIXTURE)), real, { recursive: true });
    rmSync(join(component.root, dirname(GATE_BLUEPRINT_FIXTURE)), { recursive: true });
    symlinkSync(real, join(component.root, dirname(GATE_BLUEPRINT_FIXTURE)));
    git(component.root, 'add', '-A');
    git(component.root, 'commit', '-q', '-m', 'link the fixture directory');
    const componentHead = git(component.root, 'rev-parse', 'HEAD');
    expect(git(component.root, 'status', '--porcelain')).toBe('');
    expect(observeBlueprintCheck(component.root, componentHead)).toMatchObject([
      { status: 'fail' },
    ]);
  });

  it('reads fail when the fixture bytes differ from the head the observation would name', async () => {
    const edited = fixtureRepository();
    writeFileSync(
      join(edited.root, GATE_BLUEPRINT_FIXTURE),
      `${readFileSync(join(edited.root, GATE_BLUEPRINT_FIXTURE), 'utf8')}\n`,
    );
    expect(observeBlueprintCheck(edited.root, edited.head)).toMatchObject([{ status: 'fail' }]);

    const extra = fixtureRepository();
    cpSync(
      join(extra.root, GATE_PACK_FIXTURE, 'examples/redox-pack-gate-baseline'),
      join(extra.root, GATE_PACK_FIXTURE, 'examples/redox-pack-gate-untracked'),
      { recursive: true },
    );
    expect(await observePackResolution(extra.root, extra.head)).toMatchObject([{ status: 'fail' }]);

    const other = fixtureRepository();
    expect(observeBlueprintCheck(other.root, 'c'.repeat(40))).toMatchObject([{ status: 'fail' }]);
    expect(await observePackResolution(other.root, 'c'.repeat(40))).toMatchObject([
      { status: 'fail' },
    ]);
  });

  it('reads fail for an absent or invalid committed fixture, and observes nothing without a full head', async () => {
    const empty = temporary();
    git(empty, 'init', '-q');
    git(empty, 'commit', '-q', '--allow-empty', '-m', 'empty');
    const emptyHead = git(empty, 'rev-parse', 'HEAD');
    expect(observeBlueprintCheck(empty, emptyHead)).toMatchObject([{ status: 'fail' }]);
    expect(await observePackResolution(empty, emptyHead)).toMatchObject([{ status: 'fail' }]);

    const invalid = fixtureRepository();
    const blueprint = JSON.parse(
      readFileSync(join(invalid.root, GATE_BLUEPRINT_FIXTURE), 'utf8'),
    ) as { database: { entities: { primaryKey: string[] }[] } };
    const entity = blueprint.database.entities[0];
    if (entity === undefined) throw new Error('fixture entity missing');
    entity.primaryKey = [];
    writeFileSync(join(invalid.root, GATE_BLUEPRINT_FIXTURE), JSON.stringify(blueprint));
    git(invalid.root, 'commit', '-q', '-am', 'invalid blueprint');
    const invalidHead = git(invalid.root, 'rev-parse', 'HEAD');
    expect(observeBlueprintCheck(invalid.root, invalidHead)).toMatchObject([{ status: 'fail' }]);

    expect(observeBlueprintCheck(invalid.root, 'HEAD')).toEqual([]);
    expect(await observePackResolution(invalid.root, 'HEAD')).toEqual([]);
  });

  it('collects the scorecard and both fixture observations at one head', async () => {
    const { root, head } = fixtureRepository();
    scorecard.scorecardHead.mockReturnValue(head);
    scorecard.composeExactHeadScorecard.mockReturnValue({ cells: [] });
    const observations = await observeGateProducers(root);
    expect(observations.map((observation) => [observation.command, observation.status])).toEqual([
      [`devai audit scorecard --repo-root . --at ${head}`, 'pass'],
      [BLUEPRINT_COMMAND, 'pass'],
      [PACK_COMMAND, 'pass'],
    ]);
    scorecard.scorecardHead.mockImplementation(() => {
      throw new Error('AUDIT_SCORECARD_HEAD_UNAVAILABLE:not a repository');
    });
    expect(await observeGateProducers(root)).toEqual([]);
  });
});

describe('the pull request preflight step carries both scoped producers', () => {
  const HEAD = 'b'.repeat(40);
  const NOW = '2026-10-06T12:00:00.000Z';
  const RECENT = '2026-10-06T11:00:00.000Z';
  function observation(
    command: string,
    invariant: string,
    status: AlignmentObservation['status'] = 'pass',
  ): AlignmentObservation {
    return {
      command,
      status,
      candidate_sha: HEAD,
      completed_at: RECENT,
      invariant_ids: [invariant],
    };
  }
  const PASSING = [
    observation(BLUEPRINT_COMMAND, 'INV-DEVAI-010'),
    observation(PACK_COMMAND, 'INV-HARNESS-010'),
  ];

  // The workflow parser reads workflows only under the repository root it senses, so each
  // case copies the committed workflow and the two invariants into a scratch repository.
  function alignment(
    options: {
      readonly transform?: (text: string) => string;
      readonly observations?: readonly AlignmentObservation[];
      readonly evidence?: unknown;
    } = {},
  ) {
    const root = temporary();
    for (const path of ['law/invariants', '.github/workflows', 'evidence']) {
      mkdirSync(join(root, path), { recursive: true });
    }
    for (const id of ['INV-DEVAI-010', 'INV-HARNESS-010']) {
      copyFileSync(
        join(ROOT, 'law/invariants', `${id}.json`),
        join(root, 'law/invariants', `${id}.json`),
      );
    }
    const text = readFileSync(join(ROOT, WORKFLOW), 'utf8');
    writeFileSync(join(root, WORKFLOW), options.transform?.(text) ?? text);
    if (options.evidence !== undefined) {
      writeFileSync(join(root, 'evidence/result.json'), JSON.stringify(options.evidence));
    }
    return senseHarnessInvariantAlignment({
      repoRoot: root,
      evidenceDir: 'evidence',
      candidateHead: HEAD,
      now: NOW,
      scopedProducers: GATE_SCOPED_PRODUCERS,
      observations: options.observations ?? PASSING,
    });
  }
  const messages = (reading: ReturnType<typeof alignment>): string =>
    (reading.findings ?? []).map((finding) => finding.message).join('\n');
  const without = (needle: string) => (text: string) =>
    text
      .split('\n')
      .filter((line) => !line.includes(needle))
      .join('\n');

  it('aligns both invariants on the committed workflow', () => {
    const text = readFileSync(join(ROOT, WORKFLOW), 'utf8');
    expect(text).toContain(`check --only blueprint --file ${GATE_BLUEPRINT_FIXTURE}`);
    expect(text).toContain(PACK_COMMAND.slice('devai '.length));
    const reading = alignment();
    expect(reading.status).toBe('pass');
    expect(reading.metrics).toMatchObject({ gate_invariants: 2, misaligned: 0 });
  });

  // Codex review MAJOR 1: `check --preflight --run` stays in the step and must not stand in.
  it('leaves INV-DEVAI-010 misaligned when only the blueprint producer line is removed', () => {
    const reading = alignment({ transform: without('check --only blueprint') });
    expect(readFileSync(join(ROOT, WORKFLOW), 'utf8')).toContain('check --preflight --run');
    expect(reading.metrics).toMatchObject({ misaligned: 1 });
    expect(messages(reading)).toContain('INV-DEVAI-010');
  });

  it('leaves INV-DEVAI-010 misaligned when the producer names another subject', () => {
    const reading = alignment({
      transform: (text) => text.replace(`--file ${GATE_BLUEPRINT_FIXTURE}`, '--file other.json'),
    });
    expect(messages(reading)).toContain('INV-DEVAI-010');
  });

  it('leaves INV-HARNESS-010 misaligned when the pack producer line is removed', () => {
    const reading = alignment({ transform: without('sense inventory --slice pack') });
    expect(reading.metrics).toMatchObject({ misaligned: 1 });
    expect(messages(reading)).toContain('INV-HARNESS-010');
  });

  // Codex review MAJOR 2: passing evidence for another `check` never masks a failed fixture.
  it('keeps INV-DEVAI-010 misaligned when the scoped observation fails, whatever generic evidence passes', () => {
    const reading = alignment({
      observations: [
        observation(BLUEPRINT_COMMAND, 'INV-DEVAI-010', 'fail'),
        observation('devai check --only schema', 'INV-DEVAI-010'),
        observation(PACK_COMMAND, 'INV-HARNESS-010'),
      ],
      evidence: {
        command: 'devai check --only schema',
        status: 'pass',
        lifecycle: 'supported',
        candidate_sha: HEAD,
        completed_at: RECENT,
      },
    });
    expect(reading.metrics).toMatchObject({ misaligned: 1 });
    expect(messages(reading)).toContain('INV-DEVAI-010');
  });

  it('refuses an observation of the producer scoped to another invariant', () => {
    const reading = alignment({
      observations: [
        observation(BLUEPRINT_COMMAND, 'INV-HARNESS-010'),
        observation(PACK_COMMAND, 'INV-HARNESS-010'),
      ],
    });
    expect(messages(reading)).toContain('INV-DEVAI-010');
  });
});
