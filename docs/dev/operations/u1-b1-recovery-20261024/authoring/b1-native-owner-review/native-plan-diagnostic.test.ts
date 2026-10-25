import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import { readReconciliationPlan } from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/docs/dev/operations/u1-b1-recovery-20261024/authoring/b1-native-owner-review/reconciliation-plan.diagnostic.ts';
import {
  createReconciliationHostInvocation,
  disposeReconciliationHostInvocation,
} from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-host-operation.js';
import { runWithAuthorityHostEffects } from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/host-scope.js';
import { createIssuer, runtimeApi } from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/tests/unit/authority-runtime-testkit.js';

// This fixture uses real historical Git objects and a real local bare publication.
// Its deterministic B5 provider is synthetic and proves no installed package origin.
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'native-plan-fixture.json'), 'utf8')) as {
  fixture_root: string;
  selected_parent: string;
  published_ref: string;
};
const bindings = {
  package_sha256: 'a'.repeat(64),
  module_sha256: 'b'.repeat(64),
  registry_sha256: 'c'.repeat(64),
  constitution_sha256: 'd'.repeat(64),
  policy_sha256: 'e'.repeat(64),
};

it('reads an actual historical DETRAN staged merge and real publication as readonly data', async () => {
  const issuer = createIssuer(await runtimeApi());
  const originalArgv = process.argv;
  process.argv = [process.execPath, 'devai-fixture', 'evidence', 'reconcile', 'plan',
    '--repo-root', fixture.fixture_root, '--selected-parent', fixture.selected_parent,
    '--published-ref', fixture.published_ref, '--as-role', 'architect', '--format', 'json'];
  const argvHash = createHash('sha256').update(canonicalJson(process.argv)).digest('hex');
  const invocation = createReconciliationHostInvocation({
    invocation_id: 'invocation-1',
    action_id: 'evidence reconcile plan',
    receipt_store: issuer,
    repository_root: fixture.fixture_root,
    repository_id: 'detran-historical-inspector',
    original_argv_sha256: argvHash,
    initiator: 'architect',
    operation: 'plan',
    phases: [],
    write: false,
    require_tty: false,
    selected_parent: fixture.selected_parent,
    published_ref: fixture.published_ref,
    readCurrentBindings: () => bindings,
    verifyActual: () => {
      if (createHash('sha256').update(canonicalJson(process.argv)).digest('hex') !== argvHash)
        throw new Error('fixture original argv changed');
    },
  });
  let effects = 0;
  try {
    runWithAuthorityHostEffects({
      action_id: 'evidence reconcile plan', invocation_id: 'invocation-1',
      receipt_store: issuer, reconciliation_invocation: invocation, effect: 'read',
      apply_effect: () => { effects++; },
    }, () => {
      const plan = readReconciliationPlan(fixture.fixture_root);
      expect(plan.grants_authority).toBe(false);
      expect(plan.selection.parent).toBe(fixture.selected_parent);
      expect(plan.selection.published_tip).toBe(fixture.selected_parent);
      expect(plan.selection.published_ref).toBe(fixture.published_ref);
      expect(plan.source_manifest_sha256).toBe(createHash('sha256')
        .update(canonicalJson(plan.source_manifest)).digest('hex'));
      expect(plan.source_manifest.staged_files).toHaveLength(plan.source_manifest.index.entries.length);
      expect(plan.source_manifest.files.some(file => file.kind === 'ancestry')).toBe(true);
      expect(Object.isFrozen(plan.source_manifest.recovery_obligations)).toBe(true);
      expect(effects).toBe(0);
    });
  } finally {
    process.argv = originalArgv;
    disposeReconciliationHostInvocation(invocation);
    issuer.dispose();
  }
}, 120000);
