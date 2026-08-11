import { resolve } from 'node:path';
import { deriveActionEffectFromCapabilities, type ActionCapability } from '../command-manifest.js';
import type { RegistryEntry } from '../define-command.js';
import { resolveCheckPlan } from '../commands/check/contracts.js';
import {
  resolveSenseSelection,
  type ResolvedSenseSelection,
  type SenseSelection,
} from '../commands/sense/facade.js';

export interface ResolvedSenseInvocation {
  readonly entry: RegistryEntry;
  readonly selection: ResolvedSenseSelection;
}

const FIXED_CAPABILITIES = new Set<ActionCapability>([
  'fs:f5-config',
  'fs:f5-state',
  'fs:f4-inventory',
  'fs:proofs',
  'fs:worktree-admin',
  'fs:workspace',
  'fs:unknown-write',
  'db:read',
  'db:write',
  'db:unclassified',
  'host-cache:write',
]);

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function actionCapability(value: string): ActionCapability {
  if (
    FIXED_CAPABILITIES.has(value as ActionCapability) ||
    value.startsWith('proc:') ||
    value.startsWith('net:')
  ) {
    return value as ActionCapability;
  }
  throw new Error(`SENSE_CAPABILITY_UNKNOWN:${value}`);
}

function resolvedCapabilities(selection: ResolvedSenseSelection): readonly ActionCapability[] {
  const capabilities: ActionCapability[] = [];
  const seen = new Set<ActionCapability>();
  for (const member of selection.members) {
    for (const value of member.capabilities) {
      const capability = actionCapability(value);
      if (seen.has(capability)) continue;
      seen.add(capability);
      capabilities.push(capability);
    }
  }
  return Object.freeze(capabilities);
}

function targetsFor(capabilities: readonly ActionCapability[]) {
  const targets: Array<'fs' | 'db' | 'remote'> = [];
  if (capabilities.some((capability) => capability.startsWith('fs:'))) targets.push('fs');
  if (capabilities.some((capability) => capability.startsWith('db:'))) targets.push('db');
  if (capabilities.some((capability) => capability.startsWith('net:'))) targets.push('remote');
  return Object.freeze(targets);
}

function capabilitiesForEffect(
  capabilities: readonly ActionCapability[],
  effect: RegistryEntry['effects'],
): readonly ActionCapability[] {
  if (effect === 'local-write' || effect === 'remote-write') return capabilities;
  return Object.freeze(
    capabilities.filter((capability) => {
      const capabilityEffect = deriveActionEffectFromCapabilities([capability]);
      return (
        capabilityEffect === 'read' ||
        (effect === 'harness-write' && capabilityEffect === 'harness-write')
      );
    }),
  );
}

function resolveCheckEntry(entry: RegistryEntry, argv: readonly string[]): RegistryEntry {
  const repoRoot = resolve(flagValue(argv, '--repo-root') ?? '.');
  const plan = resolveCheckPlan(repoRoot, {
    ...(flagValue(argv, '--suite') !== undefined && { suite: flagValue(argv, '--suite') }),
    ...(flagValue(argv, '--only') !== undefined && { only: flagValue(argv, '--only') }),
  });
  const effect = plan.maximum_effect;
  if (effect === entry.effects) return entry;

  const generic = entry.authority_contract;
  const capabilities = capabilitiesForEffect(generic.capabilities, effect);
  if (deriveActionEffectFromCapabilities(capabilities) !== effect) {
    throw new Error(`CHECK_EFFECT_CAPABILITY_DIVERGENCE:${plan.selection.kind}`);
  }
  if (effect === 'read') {
    return Object.freeze({
      ...entry,
      effects: effect,
      authority_contract: Object.freeze({
        ...generic,
        effect,
        capabilities,
        subject: Object.freeze({ kind: 'none' as const }),
        consent: Object.freeze({ write: false, allow_publish: false, experimental: false }),
        planner: Object.freeze({ kind: 'none' as const }),
        boundary: Object.freeze({ kind: 'none' as const }),
        readiness: Object.freeze({
          requires_binding: false,
          independent_acceptance_required: true as const,
        }),
      }),
    });
  }

  const targets = targetsFor(capabilities);
  if (targets.length === 0) throw new Error(`CHECK_MUTATION_BOUNDARY_UNRESOLVED:${effect}`);
  if (generic.planner.kind !== 'bounded-batches' || generic.boundary.kind !== 'mutation-adapters') {
    throw new Error('CHECK_GENERIC_AUTHORITY_CONTRACT_INVALID');
  }
  return Object.freeze({
    ...entry,
    effects: effect,
    authority_contract: Object.freeze({
      ...generic,
      effect,
      capabilities,
      planner: Object.freeze({ ...generic.planner, target_kinds: targets }),
      boundary: Object.freeze({
        ...generic.boundary,
        adapter_ids: Object.freeze(
          targets.map((target) => `${target}-authority-boundary` as const),
        ),
      }),
    }),
  });
}

function resolvedEntry(entry: RegistryEntry, selection: ResolvedSenseSelection): RegistryEntry {
  const capabilities = resolvedCapabilities(selection);
  const effect = selection.aggregate_effect;
  if (deriveActionEffectFromCapabilities(capabilities) !== effect) {
    throw new Error(`SENSE_EFFECT_CAPABILITY_DIVERGENCE:${selection.selection.value}`);
  }

  const targets = targetsFor(capabilities);
  if (effect !== 'read' && targets.length === 0) {
    throw new Error(`SENSE_MUTATION_BOUNDARY_UNRESOLVED:${selection.selection.value}`);
  }
  const generic = entry.authority_contract;
  if (
    effect !== 'read' &&
    (generic.planner.kind !== 'bounded-batches' || generic.boundary.kind !== 'mutation-adapters')
  ) {
    throw new Error('SENSE_GENERIC_AUTHORITY_CONTRACT_INVALID');
  }
  const adapterIds = targets.map((target) => `${target}-authority-boundary` as const);

  return Object.freeze({
    ...entry,
    effects: effect,
    authority_contract: Object.freeze({
      ...generic,
      effect,
      capabilities,
      consent: Object.freeze({
        ...generic.consent,
        write: effect !== 'read',
        allow_publish: effect === 'remote-write',
      }),
      planner:
        effect === 'read'
          ? Object.freeze({ kind: 'none' as const })
          : Object.freeze({ ...generic.planner, target_kinds: targets }),
      boundary:
        effect === 'read'
          ? Object.freeze({ kind: 'none' as const })
          : Object.freeze({ ...generic.boundary, adapter_ids: Object.freeze(adapterIds) }),
    }),
  });
}

/**
 * Resolve the parameterized `sense run` action before routing authority or
 * consent. Sensor identities and effects remain owned by the canonical sensor
 * registry; this seam only projects their capabilities into authority targets.
 */
export function resolveSenseInvocation(
  entry: RegistryEntry,
  argv: readonly string[],
): ResolvedSenseInvocation | undefined {
  if (entry.name !== 'sense run') return undefined;
  const args = argv.slice(2);
  const kind = args[2] !== undefined && !args[2].startsWith('-') ? args[2] : undefined;
  const preset = flagValue(args, '--preset');
  const roundId = flagValue(args, '--round');
  let requested: SenseSelection;
  if (kind !== undefined && preset === undefined) requested = { kind };
  else if (kind === undefined && preset !== undefined) requested = { preset };
  else throw new Error('SENSE_SELECTION_EXACTLY_ONE_REQUIRED');

  const selection = resolveSenseSelection(requested, {
    ...(roundId === undefined ? {} : { roundId }),
  });
  return Object.freeze({ entry: resolvedEntry(entry, selection), selection });
}

export function resolveInvocationEntry(
  entry: RegistryEntry,
  argv: readonly string[],
): RegistryEntry {
  if (entry.name === 'check') return resolveCheckEntry(entry, argv);
  return resolveSenseInvocation(entry, argv)?.entry ?? entry;
}
