import type { CAC } from 'cac';
import {
  metadataFor,
  registryActionFor,
  type AuthorityActionContract,
  type ActionEffect,
  type ActionLifecycle,
  type ActionStatus,
  type ActionTier,
  type ActionVisibility,
  type AdoptionProfile,
  type ActionOutputContract,
  type ActionErrorContract,
} from './command-manifest.js';
import { ACTION_REGISTRY } from './generated/action-registry.js';

/**
 * Authority owner of a CLI action (Phase 11.G, absorbed from the
 * sibling-exploration draft's ActionAuthority taxonomy, D-39).
 * Used to filter the action catalog by owner.
 */
export type ActionAuthority =
  | 'mesh_controller'
  | 'specifier'
  | 'constructor'
  | 'sensor'
  | 'policy_firewall'
  | 'release_controller'
  | 'agent_runtime'
  | 'host_tooling';

export interface CommandSpec {
  readonly name: string;
  readonly path: readonly string[];
  readonly status: ActionStatus;
  readonly description: string;
  readonly authority: ActionAuthority;
  readonly profiles: readonly AdoptionProfile[];
  readonly effects: ActionEffect;
  readonly authority_contract_version: '1.0.0';
}

/**
 * Full definition for a CLI command. `extended_doc` is only used by the
 * `docs cli` generator to append rich sections to the noun page; it is
 * intentionally excluded from the public action catalog (CommandSpec) so
 * that the catalog schema remains stable.
 */
export interface CommandDefinition extends Omit<
  CommandSpec,
  'path' | 'status' | 'authority' | 'profiles' | 'effects' | 'authority_contract_version'
> {
  readonly authority?: ActionAuthority;
  readonly lifecycle?: ActionLifecycle;
  readonly lifecycle_reason?: string;
  readonly promotion_criteria?: readonly string[];
  /**
   * Optional extended documentation appended to the auto-generated noun page
   * in docs/reference/cli/<noun>.md. May contain Markdown sections for flags, examples,
   * config file descriptions, etc. Preserved verbatim (no wrapping).
   */
  readonly extended_doc?: string;
  register(cli: CAC): void;
}

/** Extended registry entry that carries extended_doc for the docs generator. */
export interface RegistryEntry extends CommandSpec {
  readonly handler: string;
  readonly internal_name: string;
  readonly lifecycle: ActionLifecycle;
  readonly lifecycle_reason: string;
  readonly promotion_criteria: readonly string[];
  readonly visibility: ActionVisibility;
  readonly tier: ActionTier;
  readonly authority_contract: AuthorityActionContract;
  readonly output_contract: ActionOutputContract;
  readonly error_contract: ActionErrorContract;
  runtime_args?: string;
  runtime_options?: readonly { readonly flags: string; readonly description: string }[];
  runtime_supports_human?: boolean;
  readonly extended_doc?: string;
}

const registry: RegistryEntry[] = [];

function publicRegistry(): RegistryEntry[] {
  const definitions = registry;
  const byBinding = new Map<string, RegistryEntry>();
  for (const entry of definitions) {
    if (byBinding.has(entry.handler)) {
      throw new Error(`ACTION_HANDLER_DUPLICATE: ${entry.name}`);
    }
    byBinding.set(entry.handler, entry);
  }
  return ACTION_REGISTRY.flatMap((entry) => {
    const definition = byBinding.get(entry.handler);
    return definition === undefined ? [] : [definition];
  });
}

function publicText(value: string): string {
  return value
    .replaceAll(process.cwd(), '<repo-root>')
    .replaceAll('--execute', '--write')
    .replaceAll('--apply', '--write')
    .replaceAll('--human', '--format human');
}

export function defineCommand(definition: CommandDefinition): CommandDefinition {
  const current = ACTION_REGISTRY.find((entry) => entry.handler === definition.name);
  if (current === undefined) return definition;
  const canonical = registryActionFor(definition.name);
  const metadata = metadataFor(
    definition.name,
    definition.authority,
    definition.lifecycle,
    definition.lifecycle_reason,
    definition.promotion_criteria,
  );
  const entry: RegistryEntry = {
    name: metadata.path.join(' '),
    handler: definition.name,
    internal_name: definition.name.replaceAll(' ', '-'),
    status: canonical.status,
    ...metadata,
    description: publicText(canonical.description),
    authority: canonical.authority ?? definition.authority ?? 'mesh_controller',
    ...(definition.extended_doc !== undefined && {
      extended_doc: publicText(definition.extended_doc),
    }),
  };
  registry.push(entry);
  return definition;
}

export function getActionsList(opts: { authority?: ActionAuthority } = {}): readonly CommandSpec[] {
  const all =
    opts.authority === undefined
      ? ACTION_REGISTRY
      : ACTION_REGISTRY.filter((entry) => entry.authority === opts.authority);
  return all.map((entry) => ({
    name: entry.action_id,
    path: entry.path,
    status: entry.status,
    profiles: entry.profiles,
    effects: entry.effect,
    authority: entry.authority ?? 'mesh_controller',
    description: publicText(entry.description),
    authority_contract_version: entry.authority_contract_version,
  }));
}

/**
 * Internal accessor used by `docs cli` to obtain the full registry including
 * extended_doc fields for doc generation. Not exported as part of the public
 * action catalog.
 */
export function getFullRegistry(): readonly RegistryEntry[] {
  return publicRegistry();
}

/** Mechanical W05.e surface guard over the post-collapse public catalog. */
export function validateActionSurface(entries: readonly RegistryEntry[]): void {
  const canonical = ACTION_REGISTRY;
  if (entries.length !== canonical.length) {
    throw new Error(
      `ACTION_COUNT_GUARD: expected ${String(canonical.length)} canonical handlers, received ${String(entries.length)}`,
    );
  }
  const paths = entries.map((entry) => entry.path.join(' '));
  if (new Set(paths).size !== paths.length) {
    throw new Error('ACTION_PATH_DUPLICATE');
  }
  if (entries.some((entry) => entry.tier !== 'porcelain' && entry.tier !== 'plumbing')) {
    throw new Error('ACTION_TIER_MISSING');
  }
  const mismatch = canonical.findIndex(
    (expected, index) =>
      entries[index]?.name !== expected.action_id ||
      entries[index]?.handler !== expected.handler ||
      entries[index]?.internal_name !== expected.handler.replaceAll(' ', '-') ||
      entries[index]?.path.join('\0') !== expected.path.join('\0'),
  );
  if (mismatch >= 0) {
    throw new Error(
      `ACTION_HANDLER_ORDER_DRIFT: expected ${canonical[mismatch]?.action_id ?? '<none>'}, received ${entries[mismatch]?.name ?? '<none>'}`,
    );
  }
}

export function attachRuntimeContracts(
  commands: readonly {
    readonly name: string;
    readonly rawName: string;
    readonly options: readonly { readonly rawName: string; readonly description: string }[];
  }[],
): void {
  const expectedHandlers = publicRegistry().map((entry) => entry.internal_name);
  const registeredHandlers = commands.map((command) => command.name);
  if (JSON.stringify(registeredHandlers) !== JSON.stringify(expectedHandlers)) {
    const mismatch = registeredHandlers.findIndex(
      (handler, index) => handler !== expectedHandlers[index],
    );
    throw new Error(
      `ACTION_REGISTRATION_ORDER_DRIFT: expected ${expectedHandlers[mismatch] ?? '<none>'}, received ${registeredHandlers[mismatch] ?? '<none>'}`,
    );
  }
  for (const entry of registry) {
    const command = commands.find((candidate) => candidate.name === entry.internal_name);
    if (command === undefined) throw new Error(`ACTION_HANDLER_MISSING: ${entry.name}`);
    entry.runtime_args = command.rawName.slice(command.name.length).trim();
    entry.runtime_supports_human = command.options.some((option) => option.rawName === '--human');
    const options = command.options
      .filter((option) => !['--human', '--execute', '--apply', '--write'].includes(option.rawName))
      .map((option) => ({
        flags: option.rawName,
        description: publicText(option.description),
      }));
    if (entry.effects !== 'read' && entry.name !== 'govern auditor post-merge') {
      options.push({
        flags: '--as-role <role>',
        description: 'Declare the initiating human role for this invocation.',
      });
      options.push({
        flags: '--authority-session <id>',
        description: 'Use a live repository-bound authority session instead of --as-role.',
      });
      options.push({ flags: '--write', description: 'Authorize local mutation.' });
    }
    if (entry.effects === 'remote-write') {
      options.push({
        flags: '--publish',
        description: 'Authorize remote publication in addition to --write.',
      });
    }
    options.push({
      flags: '--format <format>',
      description: 'Output format when supported: json or human.',
    });
    entry.runtime_options = options;
  }
}
