import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseConstitutionVersion } from '@devai-nyx/skills';
import type { RegistryEntry } from '../define-command.js';

type JsonRecord = Record<string, unknown>;

const POLICY_VERSION = '1.0.0';
const CONSENT = Object.freeze({ write: true, allow_publish: false, experimental: false });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonical(value));
}

export function canonicalSha256(value: unknown): string {
  return sha256Bytes(canonicalBytes(value));
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function actionIds(
  entries: readonly RegistryEntry[],
  predicate: (entry: RegistryEntry) => boolean,
): string[] {
  return entries
    .filter((entry) => entry.effects !== 'read' && predicate(entry))
    .map((entry) => entry.name)
    .sort();
}

function humanActions(entries: readonly RegistryEntry[], role: string): string[] {
  return actionIds(entries, (entry) => {
    const subject = entry.authority_contract.subject;
    return subject.kind === 'human' && subject.allowed_roles.includes(role as never);
  });
}

function machineActions(entries: readonly RegistryEntry[], actor: string): string[] {
  return actionIds(
    entries,
    (entry) =>
      entry.authority_contract.subject.kind === 'derived-machine' &&
      entry.authority_contract.subject.actor === actor,
  );
}

function fsSelector(repositoryId: string, glob: string) {
  return {
    kind: 'fs',
    repository_id: repositoryId,
    canonical_relative_path_glob: glob,
    operations: ['create', 'update', 'delete', 'rename'],
  };
}

function gitSelector(repositoryId: string) {
  return {
    kind: 'git-ref',
    repository_id: repositoryId,
    ref_glob: 'refs/**',
    operations: ['create', 'update', 'delete', 'merge', 'push'],
  };
}

function dbSelector() {
  return {
    kind: 'db',
    connection_id: 'devai-control',
    database_id_glob: '**',
    object_id_glob: '**',
    operations: ['insert', 'update', 'delete', 'ddl', 'execute'],
  };
}

function rule(input: {
  id: string;
  origin: 'immutable-core' | 'additive-extension';
  precedence: 500 | 650 | 700 | 750 | 800 | 900;
  actionIds: readonly string[];
  selector: JsonRecord;
  subjects: readonly JsonRecord[];
  consent?: JsonRecord;
  rationale: string;
}) {
  if (input.actionIds.length === 0) return undefined;
  return {
    rule_id: input.id,
    origin: input.origin,
    precedence: input.precedence,
    action_ids: [...input.actionIds],
    selector: input.selector,
    effect: 'allow',
    subjects: [...input.subjects],
    required_consent: input.consent ?? CONSENT,
    constitutional_anchors: [6, 7, 8, 9, 10],
    rationale: input.rationale,
  };
}

function defined<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

function subjectGroups(entries: readonly RegistryEntry[]) {
  return {
    owner: humanActions(entries, 'owner'),
    architect: humanActions(entries, 'architect'),
    inspector: humanActions(entries, 'inspector'),
    engineer: ['round run', 'task finish', 'task start'].filter((actionId) =>
      entries.some((entry) => entry.name === actionId),
    ),
    auditor: humanActions(entries, 'auditor'),
    harness: machineActions(entries, 'harness'),
    binding: machineActions(entries, 'binding'),
    release: machineActions(entries, 'release'),
  };
}

function machineSubject(actor: 'harness' | 'binding' | 'release') {
  return {
    kind: 'derived-machine',
    actor,
    transition: actor === 'harness' ? 'harness-write' : actor === 'binding' ? 'bind' : actor,
    initiator: {
      allowed_roles:
        actor === 'harness'
          ? ['owner', 'architect', 'inspector', 'engineer', 'auditor']
          : ['architect'],
      preserve_in_context: true,
    },
  };
}

function harnessSubject(allowedRoles: readonly string[]) {
  return {
    kind: 'derived-machine',
    actor: 'harness',
    transition: 'harness-write',
    initiator: { allowed_roles: [...allowedRoles], preserve_in_context: true },
  };
}

function normalizedRepositoryId(value: string): string | undefined {
  const normalized = value.trim().replaceAll(/[^A-Za-z0-9._-]/gu, '-');
  return normalized === '' ? undefined : normalized;
}

export function repositoryIdFor(root: string): string {
  const absolute = resolve(root);
  const projectConfigPath = join(absolute, '.devai/config/project.json');
  if (existsSync(projectConfigPath)) {
    try {
      const projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8')) as JsonRecord;
      if (typeof projectConfig.name === 'string') {
        const declaredRepositoryId = normalizedRepositoryId(projectConfig.name);
        if (declaredRepositoryId !== undefined) return declaredRepositoryId;
      }
    } catch {
      // Project-config validation reports malformed adopter configuration separately.
    }
  }
  let repositoryRoot = absolute;
  try {
    const commonGitDirectory = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: absolute,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (commonGitDirectory !== '') repositoryRoot = dirname(commonGitDirectory);
  } catch {
    // Fresh adopters may bind before Git exists; retain the established directory fallback.
  }
  return normalizedRepositoryId(basename(repositoryRoot)) ?? 'adopter-repository';
}

export function authorityBindings(
  root: string,
  packageVersion: string,
  installedConstitutionText?: string,
) {
  const pinnedConstitution = join(resolve(root), '.devai/pin/constitution.md');
  const constitutionText = existsSync(pinnedConstitution)
    ? readFileSync(pinnedConstitution, 'utf8')
    : installedConstitutionText;
  if (constitutionText === undefined) {
    throw new Error(`authority policy: bound Constitution not found at ${pinnedConstitution}`);
  }
  const constitutionVersion = parseConstitutionVersion(constitutionText);
  if (constitutionVersion === null) {
    throw new Error(
      `authority policy: Constitution version marker is missing in ${pinnedConstitution}`,
    );
  }
  return {
    repository_id: repositoryIdFor(root),
    package_binding: { name: '@aarusso-nyx/devai', version: packageVersion },
    constitution_binding: {
      version: constitutionVersion,
      digest_sha256: createHash('sha256').update(constitutionText).digest('hex'),
    },
  };
}

export function buildTrustedAuthoritySources(
  entries: readonly RegistryEntry[],
  root: string,
  packageVersion: string,
  installedConstitutionText?: string,
) {
  const bindings = authorityBindings(root, packageVersion, installedConstitutionText);
  const repositoryId = bindings.repository_id;
  const groups = subjectGroups(entries);
  const human = (role: string) => [{ kind: 'human', roles: [role] }];
  const joint = [{ kind: 'human', roles: ['owner', 'architect'] }];
  const coreRules = defined([
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
    ...['.devai/state/release-lifecycle', '.devai/state/release-lifecycle/**'].map((path, index) =>
      rule({
        id: `core-architect-release-prepare-output-${String(index + 1)}`,
        origin: 'immutable-core',
        precedence: 900,
        actionIds: groups.architect.includes('release prepare') ? ['release prepare'] : [],
        selector: fsSelector(repositoryId, path),
        subjects: human('architect'),
        rationale:
          'Release prepare may append only lifecycle state; artifact bytes cross the trusted sink boundary.',
      }),
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

  const rootEngineerPaths = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig*.json',
    'vitest*.ts',
    'eslint.config.*',
    '.prettier*',
  ];
  const rootArchitectPaths = [
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
    'SECURITY.md',
    'CHANGELOG.md',
    '.changeset/**',
  ];
  const additiveRules = defined([
    rule({
      id: 'adopter-git-ref-work-task-spawn-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['round run', 'task start'],
      selector: gitSelector(repositoryId),
      subjects: [harnessSubject(['engineer'])],
      rationale: 'Adopter typed git-ref authority for work task spawn.',
    }),
    rule({
      id: 'adopter-git-ref-work-task-complete-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['task finish'],
      selector: gitSelector(repositoryId),
      subjects: [harnessSubject(['engineer'])],
      rationale: 'Adopter typed git-ref authority for work task complete.',
    }),
    rule({
      id: 'adopter-git-ref-verify-translation-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['check'],
      selector: gitSelector(repositoryId),
      subjects: [harnessSubject(['inspector'])],
      rationale: 'Adopter typed git-ref authority for verify translation.',
    }),
    rule({
      id: 'adopter-db-work-task-spawn-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['task start'],
      selector: dbSelector(),
      subjects: [harnessSubject(['engineer'])],
      rationale: 'Adopter typed db authority for work task spawn.',
    }),
    rule({
      id: 'adopter-db-verify-translation-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['check'],
      selector: dbSelector(),
      subjects: [harnessSubject(['inspector'])],
      rationale: 'Adopter typed db authority for verify translation.',
    }),
    rule({
      id: 'adopter-engineer-packages',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: groups.engineer,
      selector: fsSelector(repositoryId, 'packages/**'),
      subjects: [...human('engineer'), machineSubject('harness')],
      rationale: 'Adopter Engineer implementation authority.',
    }),
    rule({
      id: 'adopter-engineer-scripts',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: groups.engineer,
      selector: fsSelector(repositoryId, 'scripts/**'),
      subjects: [...human('engineer'), machineSubject('harness')],
      rationale: 'Adopter Engineer tooling authority.',
    }),
    rule({
      id: 'adopter-engineer-workflows',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: groups.engineer,
      selector: fsSelector(repositoryId, '.github/**'),
      subjects: [...human('engineer'), machineSubject('harness')],
      rationale: 'Adopter Engineer workflow implementation authority.',
    }),
    rule({
      id: 'adopter-binding-init-harness-ci-root',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['init apply harness', 'init bind'],
      selector: fsSelector(repositoryId, '.github'),
      subjects: [machineSubject('binding')],
      rationale: 'Derived binding authority for the canonical init harness CI scaffold root.',
    }),
    rule({
      id: 'adopter-binding-init-harness-ci',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['init apply harness', 'init bind'],
      selector: fsSelector(repositoryId, '.github/**'),
      subjects: [machineSubject('binding')],
      rationale: 'Derived binding authority for canonical init harness CI scaffold outputs.',
    }),
    ...[
      '.agents',
      '.agents/skills',
      '.agents/skills/**',
      '.claude',
      '.claude/skills',
      '.claude/skills/**',
    ].map((path, index) =>
      rule({
        id: `adopter-binding-init-harness-skills-${String(index + 1)}`,
        origin: 'additive-extension',
        precedence: 500,
        actionIds: ['init apply harness'],
        selector: fsSelector(repositoryId, path),
        subjects: [machineSubject('binding')],
        rationale:
          'Derived binding authority for the canonical Codex and Claude recipe adapter roots.',
      }),
    ),
    ...[
      '.git/hooks',
      '.git/hooks/**',
      '.git/devai',
      '.git/devai/**',
      '.husky',
      '.husky/**',
      '.devai/config',
      '.devai/config/post-merge-host-adapter.json',
    ].map((path, index) =>
      rule({
        id: `adopter-architect-hooks-${String(index + 1)}`,
        origin: 'additive-extension',
        precedence: 500,
        actionIds: ['init apply architect', 'init bind'],
        selector: fsSelector(repositoryId, path),
        subjects: [...human('architect'), machineSubject('binding')],
        rationale:
          'Adopter Architect authority for the exact local hook and host-adapter installation action.',
      }),
    ),
    ...rootEngineerPaths.map((path, index) =>
      rule({
        id: `adopter-engineer-root-${String(index + 1)}`,
        origin: 'additive-extension',
        precedence: 500,
        actionIds: groups.engineer,
        selector: fsSelector(repositoryId, path),
        subjects: [...human('engineer'), machineSubject('harness')],
        rationale: 'Adopter Engineer root tooling authority.',
      }),
    ),
    ...rootArchitectPaths.map((path, index) =>
      rule({
        id: `adopter-architect-root-${String(index + 1)}`,
        origin: 'additive-extension',
        precedence: 650,
        actionIds: groups.architect,
        selector: fsSelector(repositoryId, path),
        subjects: human('architect'),
        rationale: 'Adopter source Architect authority.',
      }),
    ),
    rule({
      id: 'adopter-db-sense-migrate-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['sense migrate'],
      selector: dbSelector(),
      subjects: human('engineer'),
      rationale: 'Typed database authority for sense migrate.',
    }),
    rule({
      id: 'adopter-remote-sense-run-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['sense run'],
      selector: {
        kind: 'remote',
        system_id: 'sensor-runtime',
        endpoint_ids: ['selected-kind'],
        operation_ids: ['invoke'],
        publication: true,
      },
      subjects: [machineSubject('harness')],
      consent: { write: true, allow_publish: true, experimental: false },
      rationale: 'Typed remote authority for sense run.',
    }),
    rule({
      id: 'adopter-remote-round-run-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['round run'],
      selector: {
        kind: 'remote',
        system_id: 'local-command',
        endpoint_ids: ['routine-executor'],
        operation_ids: ['invoke'],
        publication: false,
      },
      subjects: [machineSubject('harness')],
      rationale: 'Typed remote authority for the exact task routine selected by the round runner.',
    }),
    rule({
      id: 'adopter-remote-evidence-record-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['evidence record'],
      selector: {
        kind: 'remote',
        system_id: 'local-command',
        endpoint_ids: ['test-runner'],
        operation_ids: ['invoke'],
        publication: false,
      },
      subjects: [machineSubject('harness')],
      rationale: 'Typed remote authority for the exact test command declared by evidence record.',
    }),
    rule({
      id: 'adopter-db-task-finish-1',
      origin: 'additive-extension',
      precedence: 500,
      actionIds: ['task finish'],
      selector: dbSelector(),
      subjects: [harnessSubject(['engineer'])],
      rationale: 'Typed database authority for task finish.',
    }),
  ]);

  const sourceDocument = {
    policy_id: 'devai-core-authority',
    policy_version: POLICY_VERSION,
    rules: coreRules,
  };
  const extensionDocument = {
    extension_id: 'devai-adopter-authority',
    extension_version: POLICY_VERSION,
    rules: additiveRules,
  };
  const immutableCore = {
    policy_id: 'devai-core-authority',
    policy_version: POLICY_VERSION,
    source_document: sourceDocument,
    canonical_source_bytes: canonicalBytes(sourceDocument),
    rules: coreRules,
  };
  const additiveExtensions = [
    {
      extension_id: 'devai-adopter-authority',
      extension_version: POLICY_VERSION,
      source_document: extensionDocument,
      canonical_source_bytes: canonicalBytes(extensionDocument),
      rules: additiveRules,
    },
  ];
  const rules = [...coreRules, ...additiveRules];
  const provenance = {
    policy_id: 'devai-authority',
    policy_version: packageVersion,
    repository_id: repositoryId,
    framework_package: bindings.package_binding,
    constitution: bindings.constitution_binding,
    source_policy: {
      policy_id: 'devai-core-authority',
      policy_version: POLICY_VERSION,
      digest_sha256: sha256Bytes(canonicalBytes(sourceDocument)),
    },
    additive_extensions: [
      {
        extension_id: 'devai-adopter-authority',
        extension_version: POLICY_VERSION,
        digest_sha256: sha256Bytes(canonicalBytes(extensionDocument)),
      },
    ],
    resolved_digest_sha256: canonicalSha256(rules),
    materialized_from: { kind: 'project-config', path: '.devai/config/authority-policy.json' },
  };
  return {
    ...bindings,
    immutableCore,
    additiveExtensions,
    rules,
    provenance,
    virtualPolicy: {
      document: { raw: { rules }, canonical_bytes: canonicalBytes({ rules }), view: { rules } },
      provenance,
      resolved_rule_bytes: canonicalBytes(rules),
    },
  };
}
