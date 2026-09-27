import type { RegistryEntry } from '../define-command.js';
import {
  authorityBindings,
  subjectGroups,
  defined,
  rule,
  actionIds,
  harnessSubject,
  fsSelector,
  machineSubject,
} from './policy-support.js';

/** Human subject list for one role, as the rule builders bind it. */
export type HumanSubjects = (role: string) => { kind: string; roles: string[] }[];

/** Immutable core rules, each bound to the registry actions it governs. */
export function buildCoreAuthorityRules(input: {
  readonly entries: readonly RegistryEntry[];
  readonly human: HumanSubjects;
  readonly groups: ReturnType<typeof subjectGroups>;
  readonly repositoryId: ReturnType<typeof authorityBindings>['repository_id'];
  readonly joint: { kind: string; roles: string[] }[];
}) {
  const { entries, human, groups, repositoryId, joint } = input;
  const coreRules = defined([
    ...[
      {
        kind: 'export-sink',
        capability: 'artifact-sink:write',
        system: 'trusted-export-artifact-sink-v1',
        operation: 'write',
      },
      {
        kind: 'export-signer',
        capability: 'protected-export-signer-v1:sign',
        system: 'protected-export-signer-v1',
        operation: 'sign',
      },
    ].map((adapter) =>
      rule({
        id: `core-protected-release-${adapter.kind}`,
        origin: 'immutable-core',
        precedence: 750,
        actionIds: actionIds(
          entries,
          (entry) =>
            entry.name === 'release export' &&
            entry.authority_contract.capabilities.some(
              (capability) => capability === adapter.capability,
            ),
        ),
        selector: {
          kind: 'remote',
          system_id: adapter.system,
          endpoint_ids: ['host'],
          operation_ids: [adapter.operation],
          publication: false,
        },
        subjects: human('architect'),
        rationale:
          'Dedicated export-only capability; the live broker binds repository, candidate, plan, parent, destination, trust and one bounded export account. No prepare or generic remote authority transfers.',
      }),
    ),
    rule({
      id: 'core-protected-release-artifact-sink',
      origin: 'immutable-core',
      precedence: 750,
      actionIds: actionIds(
        entries,
        (entry) =>
          entry.name === 'release prepare' &&
          entry.authority_contract.capabilities.includes('artifact-sink:write'),
      ),
      selector: {
        kind: 'remote',
        system_id: 'trusted-artifact-sink-v3',
        endpoint_ids: ['host'],
        operation_ids: ['write'],
        publication: false,
      },
      subjects: human('architect'),
      rationale:
        'Pure prepare exposes bytes only through the exact host-bound opaque artifact sink; the final boundary rechecks candidate, plan and live prepare capability.',
    }),
    ...[
      {
        kind: 'provider',
        capability: 'protected-certification-provider-v3:execute',
        system: 'devai-protected-certification-provider-v3',
        operation: 'execute',
        actions: ['release preflight', 'release certify'],
      },
      {
        kind: 'sink',
        capability: 'certification-evidence-sink:write',
        system: 'trusted-certification-evidence-sink-v1',
        operation: 'write',
        actions: ['release certify'],
      },
    ].map((adapter) =>
      rule({
        id: `core-protected-release-${adapter.kind}`,
        origin: 'immutable-core',
        precedence: 750,
        actionIds: actionIds(
          entries,
          (entry) =>
            adapter.actions.includes(entry.name) &&
            entry.authority_contract.capabilities.some(
              (capability) => capability === adapter.capability,
            ),
        ),
        selector: {
          kind: 'remote',
          system_id: adapter.system,
          endpoint_ids: ['host'],
          operation_ids: [adapter.operation],
          publication: false,
        },
        subjects: [harnessSubject(['inspector'])],
        rationale:
          'Frozen protected release adapter; exact host capability, candidate, task policy and stage are reverified by the final boundary.',
      }),
    ),
    rule({
      id: 'core-owner-product-root',
      origin: 'immutable-core',
      precedence: 650,
      actionIds: groups.owner,
      selector: fsSelector(repositoryId, 'product'),
      subjects: human('owner'),
      rationale: 'Article 6 Owner product directory authority.',
    }),
    rule({
      id: 'core-owner-product',
      origin: 'immutable-core',
      precedence: 650,
      actionIds: groups.owner,
      selector: fsSelector(repositoryId, 'product/**'),
      subjects: human('owner'),
      rationale: 'Article 6 Owner product authority.',
    }),
    rule({
      id: 'core-joint-glossary-root',
      origin: 'immutable-core',
      precedence: 800,
      actionIds: [...new Set([...groups.owner, ...groups.architect])].sort(),
      selector: fsSelector(repositoryId, 'law/glossary'),
      subjects: joint,
      rationale: 'Article 6 joint Owner and Architect glossary directory authority.',
    }),
    rule({
      id: 'core-joint-glossary',
      origin: 'immutable-core',
      precedence: 800,
      actionIds: [...new Set([...groups.owner, ...groups.architect])].sort(),
      selector: fsSelector(repositoryId, 'law/glossary/**'),
      subjects: joint,
      rationale: 'Article 6 joint Owner and Architect glossary authority.',
    }),
    rule({
      id: 'core-architect-docs-root',
      origin: 'immutable-core',
      precedence: 650,
      actionIds: groups.architect,
      selector: fsSelector(repositoryId, 'docs'),
      subjects: human('architect'),
      rationale: 'Article 6 Architect reference directory authority.',
    }),
    rule({
      id: 'core-architect-docs',
      origin: 'immutable-core',
      precedence: 650,
      actionIds: groups.architect,
      selector: fsSelector(repositoryId, 'docs/**'),
      subjects: human('architect'),
      rationale: 'Article 6 Architect reference authority.',
    }),
    ...['law', 'law/**'].map((path, index) =>
      rule({
        id: `core-architect-governance-${String(index + 1)}`,
        origin: 'immutable-core',
        precedence: 750,
        actionIds: groups.architect,
        selector: fsSelector(repositoryId, path),
        subjects: human('architect'),
        rationale: 'Article 6 Architect law authority.',
      }),
    ),
    ...['work/rounds', 'work/rounds/**', 'work/audit', 'work/audit/**'].map((path, index) =>
      rule({
        id: `core-architect-work-records-${String(index + 1)}`,
        origin: 'immutable-core',
        precedence: 750,
        actionIds: groups.architect,
        selector: fsSelector(repositoryId, path),
        subjects: human('architect'),
        rationale: 'Article 6 Architect work-record authority.',
      }),
    ),
    rule({
      id: 'core-auditor-observation-root',
      origin: 'immutable-core',
      precedence: 750,
      actionIds: groups.auditor,
      selector: fsSelector(repositoryId, '.devai/local/rounds/*/audit'),
      subjects: human('auditor'),
      rationale: 'Article 6 Auditor observation output directory authority.',
    }),
    rule({
      id: 'core-auditor-observation',
      origin: 'immutable-core',
      precedence: 750,
      actionIds: groups.auditor,
      selector: fsSelector(repositoryId, '.devai/local/rounds/*/audit/**'),
      subjects: human('auditor'),
      rationale: 'Article 6 Auditor observation output authority.',
    }),
    ...['.devai/local', '.devai/local/rounds', '.devai/local/rounds/*'].map((path, index) =>
      rule({
        id: `core-round-workspace-container-${String(index + 1)}`,
        origin: 'immutable-core',
        precedence: 750,
        actionIds: [...new Set([...groups.architect, ...groups.auditor])].sort(),
        selector: fsSelector(repositoryId, path),
        subjects: [...human('architect'), ...human('auditor')],
        rationale: 'Article 6 role-bounded runtime round workspace container authority.',
      }),
    ),
    rule({
      id: 'core-architect-local-rounds-root',
      origin: 'immutable-core',
      precedence: 750,
      actionIds: groups.architect,
      selector: fsSelector(repositoryId, '.devai/local/rounds'),
      subjects: human('architect'),
      rationale: 'Article 6 Architect runtime round workspace authority.',
    }),
    rule({
      id: 'core-architect-local-rounds',
      origin: 'immutable-core',
      precedence: 750,
      actionIds: groups.architect,
      selector: fsSelector(repositoryId, '.devai/local/rounds/**'),
      subjects: human('architect'),
      rationale: 'Article 6 Architect runtime round workspace authority.',
    }),
    rule({
      id: 'core-inspector-tests',
      origin: 'immutable-core',
      precedence: 800,
      actionIds: groups.inspector,
      selector: fsSelector(repositoryId, '**/test/**'),
      subjects: human('inspector'),
      rationale: 'Article 6 Inspector test authority.',
    }),
    rule({
      id: 'core-inspector-tests-plural',
      origin: 'immutable-core',
      precedence: 800,
      actionIds: groups.inspector,
      selector: fsSelector(repositoryId, '**/tests/**'),
      subjects: human('inspector'),
      rationale: 'Article 6 Inspector test authority for conventional plural test directories.',
    }),
    rule({
      id: 'core-harness-state',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: groups.harness,
      selector: fsSelector(repositoryId, '.devai/state/**'),
      subjects: [machineSubject('harness')],
      rationale: 'Article 6 verb-attributed harness state transition.',
    }),
    rule({
      id: 'core-harness-state-root',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: groups.harness,
      selector: fsSelector(repositoryId, '.devai/state'),
      subjects: [machineSubject('harness')],
      rationale: 'Article 6 verb-attributed harness state directory transition.',
    }),
    ...['release prepare', 'release export'].flatMap((action) =>
      ['.devai/state/release-lifecycle', '.devai/state/release-lifecycle/**'].map((path, index) =>
        rule({
          id: `core-architect-${action.replace(' ', '-')}-output-${String(index + 1)}`,
          origin: 'immutable-core',
          precedence: 900,
          actionIds: groups.architect.includes(action) ? [action] : [],
          selector: fsSelector(repositoryId, path),
          subjects: human('architect'),
          rationale: `${action} may append only lifecycle state; artifact bytes cross the dedicated trusted sink boundary.`,
        }),
      ),
    ),
    rule({
      id: 'core-harness-worktrees',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: groups.harness,
      selector: fsSelector(repositoryId, '.devai/worktrees/**'),
      subjects: [machineSubject('harness')],
      rationale: 'Article 6 verb-attributed harness worktree-control transition.',
    }),
    rule({
      id: 'core-harness-worktrees-root',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: groups.harness,
      selector: fsSelector(repositoryId, '.devai/worktrees'),
      subjects: [machineSubject('harness')],
      rationale: 'Article 6 verb-attributed harness worktree-control directory transition.',
    }),
    rule({
      id: 'core-harness-inventory',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: groups.harness,
      selector: fsSelector(repositoryId, 'record/derived/inventory/**'),
      subjects: [machineSubject('harness')],
      rationale: 'Article 6 inventory-machine transition.',
    }),
    rule({
      id: 'core-harness-proofs',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: groups.harness,
      selector: fsSelector(repositoryId, 'record/proofs/**'),
      subjects: [machineSubject('harness')],
      rationale: 'Article 6 verb-attributed machine proof transition.',
    }),
    rule({
      id: 'core-harness-proofs-root',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: groups.harness,
      selector: fsSelector(repositoryId, 'record/proofs'),
      subjects: [machineSubject('harness')],
      rationale: 'Article 6 verb-attributed machine proof directory transition.',
    }),
    rule({
      id: 'core-binding-config',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: groups.binding,
      selector: fsSelector(repositoryId, '.devai/config/**'),
      subjects: [machineSubject('binding')],
      rationale: 'Article 6 derived binding transition for package configuration.',
    }),
    rule({
      id: 'core-architect-post-merge-host-adapter',
      origin: 'immutable-core',
      precedence: 900,
      actionIds: ['init apply architect'],
      selector: fsSelector(repositoryId, '.devai/config/post-merge-host-adapter.json'),
      subjects: human('architect'),
      rationale:
        'Article 34 Architect-authorized installation of the verified post-merge host adapter.',
    }),
    ...['.devai/state', '.devai/state/init-introspection.json'].map((path, index) =>
      rule({
        id: `core-binding-init-introspection-${String(index + 1)}`,
        origin: 'immutable-core',
        precedence: 900,
        actionIds: ['init apply harness'],
        selector: fsSelector(repositoryId, path),
        subjects: [machineSubject('binding')],
        rationale:
          'Article 6 verb-attributed state output for the exact introspecting F5 bootstrap action.',
      }),
    ),
    ...[
      '.devai/state/**',
      'record/proofs',
      'record/proofs/**',
      'record/derived/inventory',
      'record/derived/inventory/**',
      'scratch/worktrees',
      'scratch/worktrees/**',
    ].map((path, index) =>
      rule({
        id: `core-binding-init-harness-projection-${String(index + 1)}`,
        origin: 'immutable-core',
        precedence: 900,
        actionIds: ['init apply harness'],
        selector: fsSelector(repositoryId, path),
        subjects: [machineSubject('binding')],
        rationale:
          'Article 6 derived binding authority for the declared canonical harness projection.',
      }),
    ),
    ...[
      '.devai',
      '.devai/config',
      '.devai/constitution.md',
      '.devai/pin',
      '.devai/pin/constitution.md',
      '.gitignore',
    ].map((path, index) =>
      rule({
        id: `core-binding-bootstrap-${String(index + 1)}`,
        origin: 'immutable-core',
        precedence: 900,
        actionIds: groups.binding,
        selector: fsSelector(repositoryId, path),
        subjects: [machineSubject('binding')],
        rationale: 'Article 6 derived binding transition for the exact bootstrap surface.',
      }),
    ),
  ]);
  return coreRules;
}
