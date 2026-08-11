import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validators } from '@devai-nyx/schemas';

export type SensorRegistryTier = 'BASELINE' | 'TIER2' | 'TIER3' | 'SWEEP';
export type SensorEffect = 'read' | 'harness-write' | 'local-write' | 'remote-write';

export interface SensorEffectBasis {
  readonly capabilities: readonly string[];
  readonly source_paths: readonly string[];
  readonly rationale: string;
}

export interface SensorCell {
  readonly substrate: string;
  readonly property: string;
}

export interface SensorDesignNote {
  readonly state: 'present' | 'backlogged';
  readonly path: string | null;
  readonly backlog_ref: string | null;
}

export interface SensorRegistryEntry {
  readonly id: string;
  readonly title: string;
  readonly type: 'sensor-registry-entry';
  readonly status: 'active';
  readonly date: string;
  readonly authority: 'Architect';
  readonly kind: string;
  readonly emitter_module: string;
  readonly effect: SensorEffect;
  readonly effect_basis?: SensorEffectBasis;
  readonly cells?: readonly SensorCell[];
  readonly diagnostic?: true;
  readonly tiers: readonly SensorRegistryTier[];
  readonly design_note: SensorDesignNote;
}

export interface SensorRegistry {
  readonly schemaVersion: '1.0.0';
  readonly id: 'sensor-registry';
  readonly entries: readonly SensorRegistryEntry[];
}

export type SensorKind = SensorRegistryEntry['kind'];

export interface SensorDescriptor {
  readonly id: string;
  readonly title: string;
  readonly kind: SensorKind;
  readonly command: string;
  readonly primaryReadingKind: SensorKind;
  readonly readingKinds: readonly SensorKind[];
  readonly lifecycle: 'supported';
  readonly emitterModule: string;
  readonly effect: SensorEffect;
  readonly capabilities: readonly string[];
  readonly cells: readonly SensorCell[];
  readonly diagnostic: boolean;
  readonly tiers: readonly SensorRegistryTier[];
  readonly designNote: SensorDesignNote;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_REGISTRY_PATH = join(HERE, 'sensor-registry.json');
const DEVELOPMENT_REGISTRY_PATH = join(
  HERE,
  '..',
  '..',
  '..',
  'law',
  'policy',
  'sensor-registry.json',
);

function registryPath(): string {
  if (existsSync(BUNDLED_REGISTRY_PATH)) return BUNDLED_REGISTRY_PATH;
  if (existsSync(DEVELOPMENT_REGISTRY_PATH)) return DEVELOPMENT_REGISTRY_PATH;
  throw new Error(
    'canonical sensor registry is unavailable: package build is missing its staged law artifact',
  );
}

function freezeRegistry(registry: SensorRegistry): SensorRegistry {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(registry);
  return registry;
}

function loadRegistry(): SensorRegistry {
  const path = registryPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`canonical sensor registry could not be read at ${path}`, { cause: error });
  }
  if (!validators.sensorRegistry(parsed)) {
    throw new Error(
      `canonical sensor registry is schema-invalid: ${JSON.stringify(validators.sensorRegistry.errors)}`,
    );
  }
  return freezeRegistry(parsed as SensorRegistry);
}

/** The validated law artifact. Every runtime view below derives from this object. */
export const SENSOR_REGISTRY: SensorRegistry = loadRegistry();

export const SENSOR_READING_KINDS: readonly SensorKind[] = Object.freeze(
  SENSOR_REGISTRY.entries.map((entry) => entry.kind),
);

const liveKindSet = new Set<SensorKind>(SENSOR_READING_KINDS);

export function isSensorKind(value: unknown): value is SensorKind {
  return typeof value === 'string' && liveKindSet.has(value);
}

export const SENSOR_ENTRIES_BY_KIND: Readonly<Record<SensorKind, SensorRegistryEntry>> =
  Object.freeze(Object.fromEntries(SENSOR_REGISTRY.entries.map((entry) => [entry.kind, entry])));

export const SENSOR_CELLS_BY_KIND: Readonly<Record<SensorKind, readonly SensorCell[]>> =
  Object.freeze(
    Object.fromEntries(
      SENSOR_REGISTRY.entries.map((entry) => [entry.kind, Object.freeze([...(entry.cells ?? [])])]),
    ),
  );

export const SENSOR_KINDS_BY_TIER: Readonly<Record<SensorRegistryTier, readonly SensorKind[]>> =
  Object.freeze(
    Object.fromEntries(
      (['BASELINE', 'TIER2', 'TIER3', 'SWEEP'] as const).map((tier) => [
        tier,
        Object.freeze(
          SENSOR_REGISTRY.entries
            .filter((entry) => entry.tiers.includes(tier))
            .map((entry) => entry.kind),
        ),
      ]),
    ) as Record<SensorRegistryTier, readonly SensorKind[]>,
  );

export const DIAGNOSTIC_SENSOR_KINDS: readonly SensorKind[] = Object.freeze(
  SENSOR_REGISTRY.entries.filter((entry) => entry.diagnostic === true).map((entry) => entry.kind),
);

export const SENSOR_DESCRIPTORS: readonly SensorDescriptor[] = Object.freeze(
  SENSOR_REGISTRY.entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    command: `sense run ${entry.kind}`,
    primaryReadingKind: entry.kind,
    readingKinds: Object.freeze([entry.kind]),
    lifecycle: 'supported' as const,
    emitterModule: entry.emitter_module,
    effect: entry.effect,
    capabilities: Object.freeze([...(entry.effect_basis?.capabilities ?? [])]),
    cells: Object.freeze([...(entry.cells ?? [])]),
    diagnostic: entry.diagnostic === true,
    tiers: Object.freeze([...entry.tiers]),
    designNote: entry.design_note,
  })),
);

export function sensorCellMap(): Readonly<Record<SensorKind, readonly SensorCell[]>> {
  return SENSOR_CELLS_BY_KIND;
}

export function sensorTierKinds(tier: SensorRegistryTier): readonly SensorKind[] {
  return SENSOR_KINDS_BY_TIER[tier];
}

export function sensorDescriptor(kind: string): SensorDescriptor | undefined {
  return SENSOR_DESCRIPTORS.find((descriptor) => descriptor.kind === kind);
}

export function renderSensorRegistryMarkdown(): string {
  const lines = [
    '---',
    'title: Sensor registry',
    '---',
    '',
    '# Sensor registry',
    '',
    '**Generated from `law/policy/sensor-registry.json`. Do not hand-edit.**',
    '',
    `Live kinds: **${String(SENSOR_DESCRIPTORS.length)}**.`,
    '',
    '| Kind | Runner | Emitter | Cells | Tiers | Standing |',
    '|---|---|---|---|---|---|',
  ];
  for (const descriptor of SENSOR_DESCRIPTORS) {
    const cells =
      descriptor.cells.length === 0
        ? 'none'
        : descriptor.cells.map((cell) => `${cell.substrate}:${cell.property}`).join(', ');
    lines.push(
      `| \`${descriptor.kind}\` | \`${descriptor.command}\` | \`${descriptor.emitterModule}\` | ${cells} | ${descriptor.tiers.join(', ')} | ${descriptor.diagnostic ? 'diagnostic' : 'scorecard'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
