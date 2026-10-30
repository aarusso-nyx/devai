import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseConstitutionVersion } from '@devai-nyx/skills';
import type { RegistryEntry } from '../define-command.js';

type JsonRecord = Record<string, unknown>;

export const POLICY_VERSION = '1.0.0';
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

export function actionIds(
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

export function fsSelector(repositoryId: string, glob: string) {
  return {
    kind: 'fs',
    repository_id: repositoryId,
    canonical_relative_path_glob: glob,
    operations: ['create', 'update', 'delete', 'rename'],
  };
}

export function gitSelector(repositoryId: string) {
  return {
    kind: 'git-ref',
    repository_id: repositoryId,
    ref_glob: 'refs/**',
    operations: ['create', 'update', 'delete', 'merge', 'push'],
  };
}

export function dbSelector() {
  return {
    kind: 'db',
    connection_id: 'devai-control',
    database_id_glob: '**',
    object_id_glob: '**',
    operations: ['insert', 'update', 'delete', 'ddl', 'execute'],
  };
}

export function rule(input: {
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

export function defined<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

export function subjectGroups(entries: readonly RegistryEntry[]) {
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

/** The registered write verbs of each adopter path class (ADR-AUT-0004). */
export interface ClassWriteVerbs {
  readonly root: readonly string[];
  readonly test: readonly string[];
  readonly architecture: readonly string[];
}

function classRoleWriteVerbs(entries: readonly RegistryEntry[], role: string): string[] {
  return actionIds(entries, (entry) => {
    const contract = entry.authority_contract;
    if (!(contract.capabilities as readonly string[]).includes('fs:workspace')) return false;
    const subject = contract.subject;
    if (subject.kind === 'human')
      return (subject.allowed_roles as readonly string[]).includes(role);
    if (subject.kind === 'derived-machine' && subject.actor === 'harness') {
      if (subject.initiator === 'none') return false;
      const initiators: readonly string[] = subject.initiator.allowed_roles;
      return initiators.length === 1 && initiators[0] === role;
    }
    return false;
  });
}

/**
 * ADR-AUT-0004: the write verbs each adopter path class carries, derived from the registry.
 * A class role's set is every entry whose effect is not `read`, whose authority contract
 * carries `fs:workspace`, and whose subject is the human subject admitting the role or the
 * harness subject initiated by exactly that role. Root rules take the Engineer set, test
 * rules the Inspector set, and architecture rules the Architect set; each set is sorted.
 */
export function classWriteVerbs(entries: readonly RegistryEntry[]): {
  root: string[];
  test: string[];
  architecture: string[];
} {
  return {
    root: classRoleWriteVerbs(entries, 'engineer'),
    test: classRoleWriteVerbs(entries, 'inspector'),
    architecture: classRoleWriteVerbs(entries, 'architect'),
  };
}

export function machineSubject(actor: 'harness' | 'binding' | 'release') {
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

export function harnessSubject(allowedRoles: readonly string[]) {
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
