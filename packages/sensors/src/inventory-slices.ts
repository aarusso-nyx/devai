import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InventorySlice {
  readonly name: string;
  readonly members: readonly string[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PATH = join(HERE, 'round-execution.json');
const DEVELOPMENT_PATH = join(HERE, '..', '..', '..', 'law', 'policy', 'round-execution.json');

function loadInventorySlices(): readonly InventorySlice[] {
  const path = existsSync(BUNDLED_PATH) ? BUNDLED_PATH : DEVELOPMENT_PATH;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    readonly vocabularies?: { readonly inventory_slices?: unknown };
  };
  const slices = parsed.vocabularies?.inventory_slices;
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new Error('SENSE_INVENTORY_POLICY_INVALID');
  }
  const normalized = slices.map((slice) => {
    if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) {
      throw new Error('SENSE_INVENTORY_SLICE_INVALID');
    }
    const name = (slice as { readonly name?: unknown }).name;
    const members = (slice as { readonly members?: unknown }).members;
    if (
      typeof name !== 'string' ||
      !Array.isArray(members) ||
      members.some((member) => typeof member !== 'string')
    ) {
      throw new Error('SENSE_INVENTORY_SLICE_INVALID');
    }
    return Object.freeze({ name, members: Object.freeze([...(members as string[])]) });
  });
  if (new Set(normalized.map((slice) => slice.name)).size !== normalized.length) {
    throw new Error('SENSE_INVENTORY_SLICE_DUPLICATE');
  }
  return Object.freeze(normalized);
}

export const INVENTORY_SLICES = loadInventorySlices();

export function inventorySlice(name: string): InventorySlice | undefined {
  return INVENTORY_SLICES.find((slice) => slice.name === name);
}
