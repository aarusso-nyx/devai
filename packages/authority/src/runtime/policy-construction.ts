import { createHash } from 'node:crypto';

export interface PolicyRegistryEntry {
  readonly name: string;
  readonly effects: string;
  readonly authority_contract: {
    readonly capabilities: readonly string[];
    readonly subject:
      | { readonly kind: 'none' }
      | { readonly kind: 'human'; readonly allowed_roles: readonly string[] }
      | {
          readonly kind: 'derived-machine';
          readonly actor: string;
          readonly initiator: 'none' | { readonly allowed_roles: readonly string[] };
        };
  };
}

export interface PolicyBindings {
  readonly repository_id: string;
  readonly package_binding: { readonly name: string; readonly version: string };
  readonly constitution_binding: { readonly version: string; readonly digest_sha256: string };
}

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
  entries: readonly PolicyRegistryEntry[],
  predicate: (entry: PolicyRegistryEntry) => boolean,
): string[] {
  return entries
    .filter((entry) => entry.effects !== 'read' && predicate(entry))
    .map((entry) => entry.name)
    .sort();
}

function humanActions(entries: readonly PolicyRegistryEntry[], role: string): string[] {
  return actionIds(entries, (entry) => {
    const subject = entry.authority_contract.subject;
    return subject.kind === 'human' && subject.allowed_roles.includes(role);
  });
}

function machineActions(entries: readonly PolicyRegistryEntry[], actor: string): string[] {
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

export function subjectGroups(entries: readonly PolicyRegistryEntry[]) {
  return {
    owner: humanActions(entries, 'owner'),
    architect: humanActions(entries, 'architect'),
    // The source verb has explicit Article 6 core selectors. Including it in the legacy
    // wildcard group would shadow declared adopter test classes and deny existing check calls.
    inspector: humanActions(entries, 'inspector').filter((id) => id !== 'source apply inspector'),
    engineer: ['round run', 'source apply engineer', 'task finish', 'task start'].filter(
      (actionId) => entries.some((entry) => entry.name === actionId),
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

function classRoleWriteVerbs(entries: readonly PolicyRegistryEntry[], role: string): string[] {
  return actionIds(entries, (entry) => {
    const contract = entry.authority_contract;
    if (!contract.capabilities.includes('fs:workspace')) return false;
    const subject = contract.subject;
    if (subject.kind === 'human') return subject.allowed_roles.includes(role);
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
export function classWriteVerbs(entries: readonly PolicyRegistryEntry[]): {
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
