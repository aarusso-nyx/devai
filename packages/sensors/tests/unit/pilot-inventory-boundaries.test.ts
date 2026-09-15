import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVENTORY_SLICES, inventorySlice } from '../../src/inventory-slices.js';
import type { InventorySlice } from '../../src/inventory-slices.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const existsSyncMock = vi.fn<(path: string) => boolean>();
const readFileSyncMock = vi.fn<(path: string, encoding: string) => string>();

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

async function loadInventoryModuleWithMockedFs(config: {
  bundledExists: boolean;
  bundledContent: string;
  developmentContent: string;
}): Promise<typeof import('../../src/inventory-slices.js')> {
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  existsSyncMock.mockImplementation(() => config.bundledExists);
  readFileSyncMock.mockImplementation((path: string) => {
    const normalized = String(path);
    return normalized.includes(join('law', 'policy'))
      ? config.developmentContent
      : config.bundledContent;
  });
  vi.doMock('node:fs', () => ({
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  }));
  vi.resetModules();
  return import('../../src/inventory-slices.js');
}

async function readRealPolicySlices(): Promise<ReadonlyArray<InventorySlice>> {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const bundledPath = join(TEST_DIR, '..', '..', 'src', 'round-execution.json');
  const developmentPath = join(
    TEST_DIR,
    '..',
    '..',
    '..',
    '..',
    'law',
    'policy',
    'round-execution.json',
  );
  const path = actualFs.existsSync(bundledPath) ? bundledPath : developmentPath;
  const parsed = JSON.parse(actualFs.readFileSync(path, 'utf8')) as {
    vocabularies?: { inventory_slices?: unknown };
  };
  const slices = parsed.vocabularies?.inventory_slices;
  if (!Array.isArray(slices)) {
    throw new Error('test fixture: real policy file did not contain an array of inventory slices');
  }
  return slices as ReadonlyArray<InventorySlice>;
}

const wrap = (inventorySlices: unknown): string =>
  JSON.stringify({ vocabularies: { inventory_slices: inventorySlices } });

describe('INVENTORY_SLICES loaded from the real policy file', () => {
  it('is frozen as a list', () => {
    expect(Object.isFrozen(INVENTORY_SLICES)).toBe(true);
  });

  it('freezes each slice object', () => {
    for (const slice of INVENTORY_SLICES) {
      expect(Object.isFrozen(slice)).toBe(true);
    }
  });

  it('freezes each slice members array', () => {
    for (const slice of INVENTORY_SLICES) {
      expect(Object.isFrozen(slice.members)).toBe(true);
    }
  });

  it('loads at least one slice', () => {
    expect(INVENTORY_SLICES.length).toBeGreaterThan(0);
  });

  it('has unique slice names', () => {
    const names = INVENTORY_SLICES.map((slice) => slice.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('matches the names and members of the real policy file the production loader selects', async () => {
    const realSlices = await readRealPolicySlices();
    expect(INVENTORY_SLICES.map((slice) => slice.name)).toEqual(
      realSlices.map((slice) => slice.name),
    );
    expect(INVENTORY_SLICES.map((slice) => [...slice.members])).toEqual(
      realSlices.map((slice) => [...slice.members]),
    );
  });

  it('returns the exact-match slice for the first real slice name', () => {
    const firstSlice = INVENTORY_SLICES[0];
    if (firstSlice === undefined) {
      throw new Error('test fixture: expected at least one real inventory slice');
    }
    expect(inventorySlice(firstSlice.name)).toEqual(firstSlice);
  });

  it('returns undefined for a name absent from the real policy file', () => {
    const names = new Set(INVENTORY_SLICES.map((slice) => slice.name));
    let unknownName = '__pilot_unknown_slice__';
    while (names.has(unknownName)) {
      unknownName += '_';
    }
    expect(inventorySlice(unknownName)).toBeUndefined();
  });
});

describe('inventorySlice lookup against a deterministic mocked policy', () => {
  const DETERMINISTIC_POLICY_JSON = wrap([
    { name: 'lower-case-slice', members: ['lower-case-member', 'second-member'] },
    { name: 'second-slice', members: ['third-member'] },
  ]);

  it('matches the exact stored name', async () => {
    const mod = await loadInventoryModuleWithMockedFs({
      bundledExists: true,
      bundledContent: DETERMINISTIC_POLICY_JSON,
      developmentContent: '',
    });
    expect(mod.inventorySlice('lower-case-slice')).toEqual({
      name: 'lower-case-slice',
      members: ['lower-case-member', 'second-member'],
    });
  });

  it('does not match a case-variant of a stored name', async () => {
    const mod = await loadInventoryModuleWithMockedFs({
      bundledExists: true,
      bundledContent: DETERMINISTIC_POLICY_JSON,
      developmentContent: '',
    });
    expect(mod.inventorySlice('Lower-Case-Slice')).toBeUndefined();
  });

  it('does not match a member value used as a lookup name', async () => {
    const mod = await loadInventoryModuleWithMockedFs({
      bundledExists: true,
      bundledContent: DETERMINISTIC_POLICY_JSON,
      developmentContent: '',
    });
    expect(mod.inventorySlice('lower-case-member')).toBeUndefined();
  });

  it('returns undefined for a name absent from the mocked policy', async () => {
    const mod = await loadInventoryModuleWithMockedFs({
      bundledExists: true,
      bundledContent: DETERMINISTIC_POLICY_JSON,
      developmentContent: '',
    });
    expect(mod.inventorySlice('unknown-slice')).toBeUndefined();
  });
});

describe('policy file loader precedence (installed bundle vs. development source)', () => {
  it('uses the bundled policy file when it exists', async () => {
    const mod = await loadInventoryModuleWithMockedFs({
      bundledExists: true,
      bundledContent: wrap([{ name: 'bundled-slice', members: ['bundled-member'] }]),
      developmentContent: wrap([{ name: 'development-slice', members: ['development-member'] }]),
    });
    expect(mod.INVENTORY_SLICES.map((slice) => slice.name)).toEqual(['bundled-slice']);
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    const call = readFileSyncMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('test fixture: expected readFileSync to be called');
    }
    expect(call[1]).toBe('utf8');
    expect(String(call[0])).toMatch(/round-execution\.json$/);
    expect(String(call[0])).not.toMatch(/law[\\/]policy/);
  });

  it('falls back to the development policy file when the bundled file does not exist', async () => {
    const mod = await loadInventoryModuleWithMockedFs({
      bundledExists: false,
      bundledContent: '',
      developmentContent: wrap([{ name: 'development-slice', members: ['development-member'] }]),
    });
    expect(mod.INVENTORY_SLICES.map((slice) => slice.name)).toEqual(['development-slice']);
    const call = readFileSyncMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('test fixture: expected readFileSync to be called');
    }
    expect(call[1]).toBe('utf8');
    expect(String(call[0])).toMatch(/law[\\/]policy[\\/]round-execution\.json$/);
  });
});

describe('policy validation', () => {
  it('throws SENSE_INVENTORY_POLICY_INVALID when inventory_slices is missing', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: JSON.stringify({ vocabularies: {} }),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_POLICY_INVALID');
  });

  it('throws SENSE_INVENTORY_POLICY_INVALID when inventory_slices is not an array', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap('not-an-array'),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_POLICY_INVALID');
  });

  it('throws SENSE_INVENTORY_POLICY_INVALID when inventory_slices is an empty array', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap([]),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_POLICY_INVALID');
  });

  it('throws SENSE_INVENTORY_SLICE_INVALID when a slice entry is a string', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap(['not-an-object']),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_SLICE_INVALID');
  });

  it('throws SENSE_INVENTORY_SLICE_INVALID when a slice entry is null', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap([null]),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_SLICE_INVALID');
  });

  it('throws SENSE_INVENTORY_SLICE_INVALID when a slice entry is an array', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap([['nested']]),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_SLICE_INVALID');
  });

  it('throws SENSE_INVENTORY_SLICE_INVALID when name is not a string', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap([{ name: 42, members: ['a'] }]),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_SLICE_INVALID');
  });

  it('throws SENSE_INVENTORY_SLICE_INVALID when members is not an array', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap([{ name: 'alpha', members: 'not-an-array' }]),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_SLICE_INVALID');
  });

  it('throws SENSE_INVENTORY_SLICE_INVALID when members contains a non-string entry', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap([{ name: 'alpha', members: ['ok', 7] }]),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_SLICE_INVALID');
  });

  it('throws SENSE_INVENTORY_SLICE_DUPLICATE when two slices share a name', async () => {
    await expect(
      loadInventoryModuleWithMockedFs({
        bundledExists: true,
        bundledContent: wrap([
          { name: 'duplicate', members: ['a'] },
          { name: 'duplicate', members: ['b'] },
        ]),
        developmentContent: '',
      }),
    ).rejects.toThrow('SENSE_INVENTORY_SLICE_DUPLICATE');
  });

  it('successfully loads a valid multi-slice mocked policy', async () => {
    const mod = await loadInventoryModuleWithMockedFs({
      bundledExists: true,
      bundledContent: wrap([
        { name: 'first-slice', members: ['first-member'] },
        { name: 'second-slice', members: ['second-member-a', 'second-member-b'] },
      ]),
      developmentContent: '',
    });
    expect(mod.INVENTORY_SLICES).toEqual([
      { name: 'first-slice', members: ['first-member'] },
      { name: 'second-slice', members: ['second-member-a', 'second-member-b'] },
    ]);
    expect(Object.isFrozen(mod.INVENTORY_SLICES)).toBe(true);
    for (const slice of mod.INVENTORY_SLICES) {
      expect(Object.isFrozen(slice)).toBe(true);
      expect(Object.isFrozen(slice.members)).toBe(true);
    }
  });
});
