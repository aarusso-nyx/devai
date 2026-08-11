import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validators } from '@devai-nyx/schemas';

export interface SensePreset {
  readonly name: 'baseline' | 'structural' | 'governed' | 'sweep';
  readonly members: readonly string[];
  readonly excluded: readonly string[];
  readonly round_required: boolean;
}

export interface SensePresetPolicy {
  readonly schemaVersion: '1.0.0';
  readonly id: 'sense-presets';
  readonly registry: 'law/policy/sensor-registry.json';
  readonly ordering: 'canonical-sensor-registry-order';
  readonly implicit_persistence: 'forbidden';
  readonly presets: readonly SensePreset[];
  readonly exclusion_reasons: Readonly<Record<string, string>>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_POLICY_PATH = join(HERE, 'sense-presets.json');
const DEVELOPMENT_POLICY_PATH = join(HERE, '..', '..', '..', 'law', 'policy', 'sense-presets.json');

function policyPath(): string {
  if (existsSync(BUNDLED_POLICY_PATH)) return BUNDLED_POLICY_PATH;
  if (existsSync(DEVELOPMENT_POLICY_PATH)) return DEVELOPMENT_POLICY_PATH;
  throw new Error(
    'canonical sense preset policy is unavailable: package build is missing its staged law artifact',
  );
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function loadPolicy(): SensePresetPolicy {
  const path = policyPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`canonical sense preset policy could not be read at ${path}`, {
      cause: error,
    });
  }
  if (!validators.sensePresets(parsed)) {
    throw new Error(
      `canonical sense preset policy is schema-invalid: ${JSON.stringify(validators.sensePresets.errors)}`,
    );
  }
  return freeze(parsed as SensePresetPolicy);
}

export const SENSE_PRESET_POLICY: SensePresetPolicy = loadPolicy();
export const SENSE_PRESETS: readonly SensePreset[] = SENSE_PRESET_POLICY.presets;

export function sensePreset(name: string): SensePreset | undefined {
  return SENSE_PRESETS.find((preset) => preset.name === name);
}
