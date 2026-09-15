// Invariants: INV-DEVAI-001, INV-DEVAI-015
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getValidator } from '@devai-nyx/schemas';
import {
  findStackAdapterPacks,
  resolveSensorParams,
  resolveStackAdapterPack,
} from '../../src/pack-resolver/index.js';

const schema = getValidator('stack-adapter.schema.json');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-pack-manifest-'));
  writeFileSync(join(root, 'marker.txt'), 'fixture\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function manifest() {
  return {
    schemaVersion: '1.0.0',
    id: 'redox-pack-fixture',
    name: 'Fixture',
    version: '1.0.0',
    stack: { backend: 'test', frontend: 'test', db: 'test' },
    detect: { signals: [{ kind: 'file_present', path: 'marker.txt' }], priority: 50 },
    extractor_params: { inventory_api: { source: 'src/api' } },
  };
}
function save(value: unknown, directory = join(root, 'examples', 'redox-pack-fixture')) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'stack-adapter.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('loaded stack adapter manifest schema boundary', () => {
  it.each([null, [], 17, 'pack'].map((value) => ({ value })))(
    'ignores parseable JSON that is not a manifest: $value',
    ({ value }) => {
      const path = save(value);
      const bytes = readFileSync(path);
      expect(schema(value)).toBe(false);
      expect(findStackAdapterPacks({ repoRoot: root })).toEqual([]);
      expect(resolveStackAdapterPack({ repoRoot: root })).toEqual({
        matched: null,
        candidates: [],
        ambiguous: false,
      });
      expect(readFileSync(path)).toEqual(bytes);
    },
  );

  it.each([
    { schemaVersion: '0.0.0' },
    { id: 'unapproved-prefix' },
    { version: 'latest' },
    { stack: { backend: 'test', frontend: 'test' } },
    { detect: null },
    { detect: { signals: 'marker.txt' } },
    { detect: { signals: [] } },
    { detect: { signals: [{ kind: 'unknown' }] } },
    { detect: { signals: [{ kind: 'file_present', path: 'marker.txt' }], priority: 101 } },
    { detect: { signals: [{ kind: 'file_present', path: 'marker.txt' }], priority: -1 } },
    { extractor_params: { inventory_api: 'src/api' } },
    { undeclared_authority: 'Owner' },
    { _packDir: '/candidate-supplied-location' },
  ])('refuses schema-invalid loaded fields %j', (change) => {
    const value = { ...manifest(), ...change };
    const path = save(value);
    const bytes = readFileSync(path);
    expect(schema(value)).toBe(false);
    expect(findStackAdapterPacks({ repoRoot: root })).toEqual([]);
    expect(resolveStackAdapterPack({ repoRoot: root, explicitId: value.id })).toEqual({
      matched: null,
      candidates: [],
      ambiguous: false,
    });
    expect(
      resolveSensorParams({
        packsRoot: root,
        adopterRoot: root,
        sensorKind: 'inventory_api',
        explicitId: value.id,
      }),
    ).toBeNull();
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('validates explicit pack directories and preserves valid neighbors and their settings', () => {
    const valid = manifest();
    expect(schema(valid)).toBe(true);
    const path = save(valid);
    const bytes = readFileSync(path);
    const extra = join(root, 'external-seed');
    save({ ...valid, id: 'redox-pack-invalid', detect: null }, extra);
    const loaded = findStackAdapterPacks({ repoRoot: root, additionalDirs: [extra] });
    expect(loaded).toEqual([{ ...valid, _packDir: join(root, 'examples', 'redox-pack-fixture') }]);
    expect(
      resolveSensorParams({
        packsRoot: root,
        adopterRoot: root,
        sensorKind: 'inventory_api',
        additionalDirs: [extra],
      })?.params,
    ).toEqual(valid.extractor_params.inventory_api);
    expect(readFileSync(path)).toEqual(bytes);
  });
});
