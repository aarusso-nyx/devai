import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { canonicalJson } from '@devai-nyx/utils';
import { getValidator } from '@devai-nyx/schemas';
import { readReconciliationPlan } from '/Volumes/Development/projects/stech/devai/.devai/worktrees/u1-b1-approval-plan-20261024/packages/authority/src/boundaries/reconciliation-plan.js';
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
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]): Buffer => execFileSync('/usr/bin/git', ['--no-optional-locks', ...args], {
  cwd: fixture.fixture_root, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  maxBuffer: 32 * 1024 * 1024,
});
function sourceSnapshot(): { index: string; files: string; entries: number } {
  const paths = [...new Set(git('ls-files', '-z').toString('utf8').split('\0').filter(Boolean))].sort();
  const state = paths.map(path => {
    const absolute = resolve(fixture.fixture_root, path);
    const stat = lstatSync(absolute, { bigint: true });
    return { path, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
      size: String(stat.size), mtime_ns: String(stat.mtimeNs), ctime_ns: String(stat.ctimeNs),
      sha256: digest(stat.isSymbolicLink() ? readlinkSync(absolute, {encoding: 'buffer'}) : readFileSync(absolute)) };
  });
  const indexPath = git('rev-parse', '--git-path', 'index').toString('utf8').trimEnd();
  return { index: digest(readFileSync(resolve(fixture.fixture_root, indexPath))), files: digest(canonicalJson(state)), entries: paths.length };
}
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
  const before = sourceSnapshot();
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
      const obligations = plan.source_manifest.recovery_obligations;
      expect(obligations).toHaveLength(2);
      expect(obligations[0]).toEqual({
        proof_path: 'record/proofs/work/generic/R-0025.jsonl', proof_sequence: 7,
        proof_sha256: '28de325bb2b82c31ce6103c4036ef70f3de284108f37810534cf5d12faea547d',
        source_commit: '16af3d8fe31ae74de6bae8bf55f840c6cdc9bd64',
        source_chain_sha256: '46b1459576b3e51fbaf6ea1e8f3492d91c3171239fadf38bd8af78917cb36f73',
        source_entry_manifest_hash: '528006c1defb85d01b55d0a57a64d049c2ffbd77151a831deb47e72cbbf72708', mode: 'divergent',
      });
      expect(obligations[1]).toEqual({
        proof_path: 'record/proofs/work/generic/R-0025.jsonl', proof_sequence: 8,
        proof_sha256: '958931109f3d1c6c061698c7343c4b1788820d5b6095b7de64d7540dd7c491cf',
        source_commit: null, source_chain_sha256: null, source_entry_manifest_hash: null, mode: 'newest',
      });
      const source = plan.source_manifest.files;
      expect(source.find(file => file.commit === fixture.selected_parent && file.path === 'record/proofs/chain.json')?.sha256)
        .toBe('04234742be13562cdd26b98a535b36947b60212fb42eb02a9512c94d506b3252');
      expect(source.find(file => file.commit === obligations[0]?.source_commit && file.path === 'record/proofs/chain.json')?.sha256)
        .toBe(obligations[0]?.source_chain_sha256);
      expect(source.some(file => file.commit === obligations[0]?.source_commit && file.kind === 'epoch')).toBe(true);
      expect(plan.source_manifest.index.entries).toHaveLength(15804);
      const validate = getValidator('evidence-reconciliation-plan.schema.json');
      expect(validate(plan), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({...plan, grants_authority: true})).toBe(false);
      expect(validate({...plan, unexpected: true})).toBe(false);
      expect(validate({...plan, selection: {...plan.selection, unexpected: true}})).toBe(false);
      expect(validate({...plan, source_manifest: {...plan.source_manifest, unexpected: true}})).toBe(false);
      const after = sourceSnapshot();
      expect(after).toEqual(before);
      writeFileSync(resolve(import.meta.dirname, 'native-plan-independent-exact-observation.json'), JSON.stringify({
        qualification: 'Native source harness; real historical Git and bare remote; synthetic B5; no installed package claim',
        selected_parent: plan.selection.parent, head: plan.identity.head, merge_heads: plan.identity.merge_heads,
        index: plan.source_manifest.index.raw_sha256, semantic_index: plan.source_manifest.index.semantic_sha256,
        plan_sha256: digest(canonicalJson(plan) + '\n'), source_manifest_sha256: plan.source_manifest_sha256,
        obligations, before, after, effect_calls: effects, closed_schema: true,
      }, null, 2) + '\n');
    });
  } finally {
    process.argv = originalArgv;
    disposeReconciliationHostInvocation(invocation);
    issuer.dispose();
  }
}, 120000);
