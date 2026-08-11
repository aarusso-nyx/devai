import {
  SENSOR_REGISTRY,
  isSensorKind,
  type SensorEffect,
  type SensorRegistryEntry,
} from '@devai-nyx/sensors/registry';
import { SENSE_PRESET_POLICY, sensePreset } from '@devai-nyx/sensors/presets';

export type SenseSelection =
  | { readonly kind: string; readonly preset?: never }
  | { readonly kind?: never; readonly preset: string };

export interface SenseMemberAuthority {
  readonly kind: string;
  readonly effect: SensorEffect;
  readonly capabilities: readonly string[];
  readonly consent: {
    readonly write: boolean;
    readonly publish: boolean;
  };
}

export interface ResolvedSenseSelection {
  readonly selection: { readonly type: 'kind' | 'preset'; readonly value: string };
  readonly members: readonly SenseMemberAuthority[];
  readonly executed: readonly string[];
  readonly excluded: readonly {
    readonly kind: string;
    readonly effect: SensorEffect;
    readonly reason: string;
  }[];
  readonly round_required: boolean;
  readonly round_id?: string;
  readonly aggregate_effect: SensorEffect;
  readonly generic_ceiling: 'remote-write';
  readonly implicit_persistence: false;
}

const EFFECT_RANK: Readonly<Record<SensorEffect, number>> = Object.freeze({
  read: 0,
  'harness-write': 1,
  'local-write': 2,
  'remote-write': 3,
});
const GENERIC_CEILING = 'remote-write' as const;
const ROUND_ID = /^R-[0-9]{4}$/u;

function memberAuthority(entry: SensorRegistryEntry): SenseMemberAuthority {
  if (EFFECT_RANK[entry.effect] > EFFECT_RANK[GENERIC_CEILING]) {
    throw new Error(`SENSE_EFFECT_EXCEEDS_GENERIC_CEILING:${entry.kind}:${entry.effect}`);
  }
  const capabilities = Object.freeze([...(entry.effect_basis?.capabilities ?? [])]);
  if (entry.effect !== 'read' && capabilities.length === 0) {
    throw new Error(`SENSE_EFFECT_CAPABILITIES_MISSING:${entry.kind}`);
  }
  return Object.freeze({
    kind: entry.kind,
    effect: entry.effect,
    capabilities,
    consent: Object.freeze({
      write: entry.effect !== 'read',
      publish: entry.effect === 'remote-write',
    }),
  });
}

function validateCanonicalPolicy(): void {
  const entries = SENSOR_REGISTRY.entries;
  const byKind = new Map(entries.map((entry) => [entry.kind, entry]));
  if (byKind.size !== entries.length) throw new Error('SENSE_SENSOR_KIND_DUPLICATE');
  const presetNames = SENSE_PRESET_POLICY.presets.map((preset) => preset.name);
  if (new Set(presetNames).size !== presetNames.length) {
    throw new Error('SENSE_PRESET_DUPLICATE');
  }
  for (const preset of SENSE_PRESET_POLICY.presets) {
    if (new Set(preset.members).size !== preset.members.length) {
      throw new Error(`SENSE_PRESET_MEMBER_DUPLICATE:${preset.name}`);
    }
    if (new Set(preset.excluded).size !== preset.excluded.length) {
      throw new Error(`SENSE_PRESET_EXCLUSION_DUPLICATE:${preset.name}`);
    }
    for (const kind of [...preset.members, ...preset.excluded]) {
      if (!byKind.has(kind)) throw new Error(`SENSE_PRESET_KIND_UNKNOWN:${preset.name}:${kind}`);
    }
  }

  const sweep = sensePreset('sweep');
  if (sweep === undefined) throw new Error('SENSE_SWEEP_PRESET_MISSING');
  const readKinds = entries.filter((entry) => entry.effect === 'read').map((entry) => entry.kind);
  const writeKinds = entries.filter((entry) => entry.effect !== 'read').map((entry) => entry.kind);
  if (JSON.stringify(sweep.members) !== JSON.stringify(readKinds)) {
    throw new Error('SENSE_SWEEP_READ_POPULATION_DIVERGENCE');
  }
  if (JSON.stringify(sweep.excluded) !== JSON.stringify(writeKinds)) {
    throw new Error('SENSE_SWEEP_EXCLUSION_POPULATION_DIVERGENCE');
  }
}

function aggregateEffect(members: readonly SenseMemberAuthority[]): SensorEffect {
  let aggregate: SensorEffect = 'read';
  for (const member of members) {
    if (EFFECT_RANK[member.effect] > EFFECT_RANK[aggregate]) aggregate = member.effect;
  }
  return aggregate;
}

/**
 * Resolve a kind or preset completely before authority and consent checks.
 *
 * This is the single integration seam for the central router/authority layer. It
 * derives all populations from Architect policy and returns every member's actual
 * effect contract instead of applying the generic `sense run` ceiling as authority.
 */
export function resolveSenseSelection(
  selection: SenseSelection,
  options: { readonly roundId?: string } = {},
): ResolvedSenseSelection {
  validateCanonicalPolicy();
  const kindSelected = typeof selection.kind === 'string';
  const presetSelected = typeof selection.preset === 'string';
  if (kindSelected === presetSelected) throw new Error('SENSE_SELECTION_EXACTLY_ONE_REQUIRED');

  let selectionType: 'kind' | 'preset';
  let selectionValue: string;
  let memberKinds: readonly string[];
  let excludedKinds: readonly string[];
  let roundRequired: boolean;
  if (kindSelected) {
    const kind = selection.kind;
    if (!isSensorKind(kind)) throw new Error(`SENSE_KIND_UNKNOWN:${kind}`);
    selectionType = 'kind';
    selectionValue = kind;
    memberKinds = [kind];
    excludedKinds = [];
    roundRequired = false;
  } else {
    const presetName = selection.preset;
    const preset = sensePreset(presetName);
    if (preset === undefined) {
      throw new Error(`SENSE_PRESET_UNKNOWN:${presetName}`);
    }
    selectionType = 'preset';
    selectionValue = preset.name;
    memberKinds = preset.members;
    excludedKinds = preset.excluded;
    roundRequired = preset.round_required;
  }

  if (roundRequired && (options.roundId === undefined || !ROUND_ID.test(options.roundId))) {
    throw new Error('SENSE_ROUND_REQUIRED');
  }
  if (options.roundId !== undefined && !ROUND_ID.test(options.roundId)) {
    throw new Error(`SENSE_ROUND_INVALID:${options.roundId}`);
  }

  const byKind = new Map(SENSOR_REGISTRY.entries.map((entry) => [entry.kind, entry]));
  const members = Object.freeze(
    memberKinds.map((kind) => {
      const entry = byKind.get(kind);
      if (entry === undefined) throw new Error(`SENSE_KIND_UNKNOWN:${kind}`);
      return memberAuthority(entry);
    }),
  );
  const excluded = Object.freeze(
    excludedKinds.map((kind) => {
      const entry = byKind.get(kind);
      if (entry === undefined) throw new Error(`SENSE_KIND_UNKNOWN:${kind}`);
      return Object.freeze({
        kind,
        effect: entry.effect,
        reason:
          SENSE_PRESET_POLICY.exclusion_reasons[kind] ??
          'Excluded by the canonical sense preset policy.',
      });
    }),
  );

  return Object.freeze({
    selection: Object.freeze({ type: selectionType, value: selectionValue }),
    members,
    executed: Object.freeze(members.map((member) => member.kind)),
    excluded,
    round_required: roundRequired,
    ...(options.roundId === undefined ? {} : { round_id: options.roundId }),
    aggregate_effect: aggregateEffect(members),
    generic_ceiling: GENERIC_CEILING,
    implicit_persistence: false,
  });
}
