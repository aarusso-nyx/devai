// #383: every workflow DEVAI generates for an adopter pins each action at one ref, so
// harness_coherence on an adopter that holds only generated workflows sees no action drift.
// The generators are the attested-RC verifier, the ledger verifier, the GitHub Actions
// main-observation adapter, and the GitHub Issues tracking adapter. The default toolchain
// manifest that init seeds is a subset of this repository's own manifest, and the tracking
// policy pins the same checkout and setup-node digests.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attestedRcVerificationWorkflow,
  ledgerVerificationWorkflow,
} from '../../src/services/ci-scaffold/index.js';
import { buildGithubActionsAdapterPlan } from '../../src/services/github-actions-adapter/index.js';
import { loadTrackingPolicyDefaults } from '../../src/services/github-issues-tracking/config.js';
import { renderTrackingWorkflow } from '../../src/services/github-issues-tracking/workflow.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

interface Toolchain {
  readonly actions: Readonly<Record<string, { readonly ref: string; readonly digest: string }>>;
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
const DEFAULTS = readJson<Toolchain>('law/policy/adopter-defaults/toolchain.json');
const REPOSITORY = readJson<Toolchain>('.devai/config/toolchain.json');

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function observationWorkflow(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-generated-pins-'));
  roots.push(root);
  mkdirSync(join(root, '.git'));
  writeFileSync(
    join(root, '.git/config'),
    '[remote "origin"]\n\turl = https://github.com/example/adopter.git\n',
  );
  return buildGithubActionsAdapterPlan(root, '2.3.1').workflowBytes;
}

function generated(): ReadonlyMap<string, string> {
  return new Map([
    ['attested RC verifier', attestedRcVerificationWorkflow()],
    ['ledger verifier', ledgerVerificationWorkflow()],
    ['main observation', observationWorkflow()],
    ['issues tracking', renderTrackingWorkflow(loadTrackingPolicyDefaults())],
  ]);
}

/** action -> the set of refs it is used at, with the workflows that use each one. */
function refsByAction(workflows: ReadonlyMap<string, string>): Map<string, Map<string, string[]>> {
  const refs = new Map<string, Map<string, string[]>>();
  for (const [name, bytes] of workflows) {
    for (const match of bytes.matchAll(/uses:\s*['"]?([\w.-]+\/[\w./-]+)@([^\s'"#]+)/gu)) {
      const action = match[1] ?? '';
      const ref = match[2] ?? '';
      const byRef = refs.get(action) ?? new Map<string, string[]>();
      byRef.set(ref, [...new Set([...(byRef.get(ref) ?? []), name])]);
      refs.set(action, byRef);
    }
  }
  return refs;
}

describe('#383: generated workflows share one pin per action', () => {
  it('uses exactly one ref per action across every generated workflow', () => {
    const refs = refsByAction(generated());
    expect(refs.size).toBeGreaterThan(0);
    const drift = [...refs]
      .filter(([, byRef]) => byRef.size !== 1)
      .map(([action, byRef]) => ({ action, refs: Object.fromEntries(byRef) }));
    expect(drift).toEqual([]);
    for (const [action, byRef] of refs) {
      expect([...byRef.keys()][0], `${action} is pinned to a full commit`).toMatch(
        /^[0-9a-f]{40}$/u,
      );
    }
  });

  it('pins every adopter-defaults action that a generated workflow uses to its default digest', () => {
    const refs = refsByAction(generated());
    for (const [action, { digest }] of Object.entries(DEFAULTS.actions)) {
      expect([...(refs.get(action)?.keys() ?? [])], action).toEqual([digest]);
    }
  });

  it('seeds a default toolchain manifest that is a subset of the repository manifest', () => {
    expect(Object.keys(DEFAULTS.actions).sort()).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'actions/upload-artifact',
    ]);
    for (const [action, pin] of Object.entries(DEFAULTS.actions)) {
      expect(REPOSITORY.actions[action], action).toMatchObject(pin);
    }
  });

  it('pins the tracking policy actions to the adopter-defaults digests', () => {
    const policy = readJson<{
      defaults: { workflow: { pinned_actions: Record<string, string> } };
    }>('law/policy/github-issues-tracking.json');
    expect(policy.defaults.workflow.pinned_actions).toEqual({
      checkout: DEFAULTS.actions['actions/checkout']?.digest,
      setup_node: DEFAULTS.actions['actions/setup-node']?.digest,
    });
  });
});
