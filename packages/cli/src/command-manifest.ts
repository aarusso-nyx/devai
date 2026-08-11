import type { ActionAuthority } from './define-command.js';
import { ACTION_REGISTRY_BY_HANDLER } from './generated/action-registry.js';

export type ActionStatus = 'stable' | 'preview' | 'internal';
export type ActionLifecycle = 'supported' | 'experimental';
export type ActionTier = 'porcelain' | 'plumbing';
export type ActionVisibility = 'common' | 'standard' | 'advanced' | 'maintainer';
export type ActionEffect = 'read' | 'harness-write' | 'local-write' | 'remote-write';
export type ActionCapability =
  | 'fs:f5-config'
  | 'fs:f5-state'
  | 'fs:f4-inventory'
  | 'fs:proofs'
  | 'fs:worktree-admin'
  | 'fs:workspace'
  | 'fs:unknown-write'
  | 'db:read'
  | 'db:write'
  | 'db:unclassified'
  | 'host-cache:write'
  | `proc:${string}`
  | `net:${string}`;
export type AdoptionProfile = 'tier1' | 'tier2' | 'tier3';

export interface ActionOutputContract {
  readonly schemaVersion: '1.0.0';
  readonly mode: 'action-envelope' | 'router-only';
  readonly envelope_schema: 'law/schemas/action-result.schema.json' | null;
  readonly success_channel: 'stdout' | 'none';
  readonly payload_schema: string | null;
}

export interface ActionErrorContract {
  readonly schemaVersion: '1.0.0';
  readonly mode: 'structured-error-envelope' | 'router-only';
  readonly envelope_schema: 'law/schemas/action-result.schema.json' | null;
  readonly error_schema: 'law/schemas/error.schema.json' | null;
  readonly error_channel: 'stderr' | 'none';
}

export interface CommandMetadata {
  readonly path: readonly string[];
  readonly lifecycle: ActionLifecycle;
  readonly lifecycle_reason: string;
  readonly promotion_criteria: readonly string[];
  readonly visibility: ActionVisibility;
  readonly tier: ActionTier;
  readonly profiles: readonly AdoptionProfile[];
  readonly effects: ActionEffect;
  readonly output_contract: ActionOutputContract;
  readonly error_contract: ActionErrorContract;
  readonly authority_contract_version: '1.0.0';
  readonly authority_contract: AuthorityActionContract;
}

export type HumanRole = 'owner' | 'architect' | 'inspector' | 'engineer' | 'auditor';
export type AuthorityTargetKind = 'fs' | 'git-ref' | 'db' | 'remote';

export interface AuthorityActionContract {
  readonly schemaVersion: '1.0.0';
  readonly action_id: string;
  readonly effect: ActionEffect;
  readonly capabilities: readonly ActionCapability[];
  readonly subject:
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'human'; allowed_roles: readonly HumanRole[] }>
    | Readonly<{
        kind: 'derived-machine';
        actor: 'harness' | 'binding' | 'release';
        transition: 'harness-write' | 'bind' | 'release';
        initiator:
          'none' | Readonly<{ allowed_roles: readonly HumanRole[]; preserve_in_context: true }>;
      }>;
  readonly consent: Readonly<{
    write: boolean;
    allow_publish: boolean;
    experimental: boolean;
  }>;
  readonly planner:
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'exact-plan';
        planner_id: string;
        target_kinds: readonly AuthorityTargetKind[];
        atomicity: 'whole-plan';
      }>
    | Readonly<{
        kind: 'bounded-batches';
        planner_id: string;
        target_kinds: readonly AuthorityTargetKind[];
        bounds: Readonly<{
          max_batches: number;
          max_targets_per_batch: number;
          max_total_targets: number;
        }>;
        recovery: 'preserve-and-report';
      }>;
  readonly boundary:
    | Readonly<{ kind: 'none' }>
    | Readonly<{
        kind: 'mutation-adapters';
        adapter_ids: readonly string[];
        final_reverification: true;
      }>;
  readonly readiness: Readonly<{
    requires_binding: boolean;
    independent_acceptance_required: true;
  }>;
}

export interface RegistryActionRecord {
  readonly action_id: string;
  readonly handler: string;
  readonly path: readonly string[];
  readonly status: ActionStatus;
  readonly profiles: readonly AdoptionProfile[];
  readonly effect: ActionEffect;
  readonly authority: ActionAuthority | null;
  readonly description: string;
  readonly output_contract: ActionOutputContract;
  readonly error_contract: ActionErrorContract;
  readonly authority_contract_version: '1.0.0';
  readonly authority_contract: AuthorityActionContract;
}
export function deriveActionEffectFromCapabilities(
  capabilities: readonly ActionCapability[],
): ActionEffect {
  if (capabilities.some((capability) => capability.startsWith('net:'))) {
    return 'remote-write';
  }
  // Subprocess capabilities are evidence annotations. The registry effect is
  // checked independently and bound at the runtime seam.
  if (
    capabilities.some((capability) =>
      [
        'fs:f5-config',
        'fs:workspace',
        'fs:unknown-write',
        'db:write',
        'db:unclassified',
        'host-cache:write',
      ].includes(capability),
    )
  ) {
    return 'local-write';
  }
  if (
    capabilities.some((capability) =>
      ['fs:f5-state', 'fs:f4-inventory', 'fs:proofs', 'fs:worktree-admin'].includes(capability),
    )
  ) {
    return 'harness-write';
  }
  return 'read';
}

export function validateDeclaredCapabilityConsistency(
  entries: readonly Readonly<{
    name: string;
    effects: ActionEffect;
    authority_contract: Readonly<{
      action_id: string;
      capabilities?: readonly ActionCapability[];
    }>;
  }>[],
): void {
  for (const entry of entries) {
    const capabilities = entry.authority_contract.capabilities;
    if (capabilities === undefined) {
      throw new Error(`${entry.name}: EFFECT_CAPABILITIES_MISSING`);
    }
    const derived = deriveActionEffectFromCapabilities(capabilities);
    if (entry.authority_contract.action_id !== entry.name || derived !== entry.effects) {
      throw new Error(`${entry.name}: EFFECT_CAPABILITIES_CATALOG_MISMATCH`);
    }
  }
}

export function registryActionFor(name: string): RegistryActionRecord {
  const entry = ACTION_REGISTRY_BY_HANDLER.get(name);
  if (entry === undefined) {
    throw new Error("action '" + name + "' is absent from law/policy/action-registry.json");
  }
  return entry;
}

export function metadataFor(
  name: string,
  authority: ActionAuthority | undefined,
  declaredLifecycle?: ActionLifecycle,
  _declaredReason?: string,
  _declaredPromotion?: readonly string[],
): CommandMetadata {
  const entry = registryActionFor(name);
  if (entry.authority !== authority) {
    throw new Error("action '" + name + "' authority differs from the canonical registry");
  }
  const lifecycle = entry.status === 'preview' ? 'experimental' : 'supported';
  if (declaredLifecycle !== undefined && lifecycle !== declaredLifecycle) {
    throw new Error("action '" + name + "' status differs from the canonical registry");
  }
  return {
    path: entry.path,
    lifecycle,
    lifecycle_reason:
      entry.status === 'preview'
        ? 'Preview action; contract may change before v1.0.'
        : 'Stable action.',
    promotion_criteria: [],
    visibility: entry.status === 'internal' ? 'maintainer' : 'standard',
    tier: entry.status === 'internal' ? 'plumbing' : 'porcelain',
    profiles: entry.profiles,
    effects: entry.effect,
    output_contract: entry.output_contract,
    error_contract: entry.error_contract,
    authority_contract_version: entry.authority_contract_version,
    authority_contract: entry.authority_contract,
  };
}
