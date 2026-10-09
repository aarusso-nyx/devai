// #376: every input of the reviewed-workflow-step registry is an input of test:sensors, so
// `check --affected` plans the registry test whenever a change could break it. Each repository
// file an entry pins by digest is matched by a test:sensors selector, every workflow file and
// local action is covered by a prefix selector on .github/, and a change that touches only a
// pinned file, such as a documentation-site dependency bump or a version roll, plans
// test:sensors.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  createAuthorityDecisionIssuer,
  runWithAuthorityHostEffects,
  type AuthorityHostEffectScope,
} from '@devai-nyx/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEWED_WORKFLOW_STEPS } from '../../../sensors/src/harness/reviewed-workflow-steps.js';
import { buildTaskPlan, parseTaskDescriptor } from '../../src/services/check-runner/policy.js';
import { anySelectorMatches } from '../../src/services/check-runner/policy-descriptor.js';

/** A descriptor input selector as the planner's own matcher takes it. */
type PolicyInputSelector = Parameters<typeof anySelectorMatches>[0][number];

const ROOT = resolve(import.meta.dirname, '../../../..');
const NODE = 'test:sensors';
const TAXONOMY_FILES = [
  'law/policy/change-taxonomy.json',
  'law/policy/adopter-defaults/change-taxonomy-binding.json',
  '.devai/config/change-taxonomy.json',
  '.devai/config/change-taxonomy-binding.json',
] as const;

interface RawTask {
  readonly nodeId: string;
  readonly inputSelectors: readonly PolicyInputSelector[];
}
const rawDescriptor = JSON.parse(readFileSync(join(ROOT, 'test-tasks.json'), 'utf8')) as {
  readonly tasks: readonly RawTask[];
};
const sensorsSelectors = (): readonly PolicyInputSelector[] => {
  const task = rawDescriptor.tasks.find((candidate) => candidate.nodeId === NODE);
  if (task === undefined) throw new Error(`test-tasks.json declares no ${NODE}`);
  return task.inputSelectors;
};

/** Every repository path any registry entry pins by digest, sorted and unique. */
const PINNED_PATHS = [
  ...new Set(REVIEWED_WORKFLOW_STEPS.flatMap((entry) => entry.files.map((file) => file.path))),
].sort();

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('test:sensors declares every reviewed-step registry input (#376)', () => {
  it('pins a non-empty population the guard can check', () => {
    expect(PINNED_PATHS.length).toBeGreaterThan(0);
    expect(PINNED_PATHS).toContain('docs/site/package.json');
    expect(PINNED_PATHS).toContain('package.json');
  });

  it('matches every pinned path with a test:sensors selector, naming any that is not', () => {
    const selectors = sensorsSelectors();
    const uncovered = PINNED_PATHS.filter(
      (path) => !anySelectorMatches(selectors, path, undefined),
    );
    expect(uncovered, `paths the registry pins that ${NODE} does not select`).toEqual([]);
  });

  it('covers every workflow file and local action through a prefix selector on .github/', () => {
    expect(sensorsSelectors()).toContainEqual({ kind: 'prefix', pattern: '.github/' });
    for (const path of [
      '.github/workflows/pull-request-checks.yml',
      '.github/workflows/update-pull-request-branches.yml',
      '.github/actions/setup-node-toolchain/action.yml',
    ]) {
      expect(anySelectorMatches(sensorsSelectors(), path, undefined), path).toBe(true);
    }
  });
});

describe('check --affected plans test:sensors for a change to a pinned file alone (#376)', () => {
  function git(root: string, args: readonly string[]): string {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  }

  function put(root: string, path: string, content: string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, 'utf8');
  }

  let ordinal = 0;
  function inScope<T>(callback: () => T): T {
    ordinal += 1;
    const id = `test-sensors-registry-inputs-${String(ordinal)}`;
    let receipt = 0;
    const issuer = createAuthorityDecisionIssuer({
      issuer_id: 'test-sensors-registry-inputs',
      issuer_version: '1.0.0',
      invocation_id: id,
      canonicalSha256: () => 'c'.repeat(64),
      randomId: () => `${id}-${String(++receipt)}`,
      now: () => '2026-10-09T00:00:00.000Z',
      receipt_ttl_ms: 30_000,
    });
    const scope: AuthorityHostEffectScope = {
      action_id: 'check',
      invocation_id: id,
      effect: 'local-write',
      receipt_store: issuer,
      apply_effect: (_request, apply) => apply(),
    };
    try {
      return runWithAuthorityHostEffects(scope, callback);
    } finally {
      issuer.dispose();
    }
  }

  /** Plans the committed descriptor for a candidate that changes only `path`. */
  function plannedFor(path: string): readonly string[] {
    const root = mkdtempSync(join(tmpdir(), 'devai-registry-inputs-'));
    roots.push(root);
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Fixture']);
    git(root, ['config', 'user.email', 'fixture@example.invalid']);
    for (const file of TAXONOMY_FILES) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(ROOT, file), join(root, file));
    }
    put(root, '.gitignore', '.devai/state/\n');
    put(root, path, readFileSync(join(ROOT, path), 'utf8'));
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'base']);
    const base = git(root, ['rev-parse', 'HEAD']);
    put(root, path, `${readFileSync(join(root, path), 'utf8')}\n`);
    git(root, ['commit', '-qam', 'candidate']);

    const descriptor = parseTaskDescriptor(structuredClone(rawDescriptor));
    const toolchain = Object.fromEntries(
      [...new Set(descriptor.tasks.flatMap((task) => task.toolchainKeys))].map((key) => [
        key,
        'v-test',
      ]),
    );
    const plan = inScope(() =>
      buildTaskPlan({
        repoRoot: root,
        descriptor,
        target: 'affected',
        baseCommit: base,
        toolchain,
        environment: {},
        resolveExecutable: () => ({ path: process.execPath, sha256: 'a'.repeat(64) }),
        cacheState: () => ({ cacheState: 'execute' as const, reason: 'fixture' }),
      }),
    );
    expect(plan.changedPaths).toEqual([path]);
    return plan.tasks.map((task) => task.nodeId);
  }

  it.each(['docs/site/package.json', 'package.json'])(
    'plans test:sensors when only %s changes',
    (path) => {
      expect(plannedFor(path)).toContain(NODE);
    },
  );
});
