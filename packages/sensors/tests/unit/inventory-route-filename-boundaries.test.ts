import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryCoverage } from '../../src/inventory-coverage.js';

let root: string;
let directory: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-route-filenames-'));
  directory = join(root, 'record/proofs/sensors/inventory_routes');
  mkdirSync(directory, { recursive: true });
  const api = join(root, 'record/proofs/sensors/inventory_api');
  mkdirSync(api, { recursive: true });
  writeFileSync(join(api, 'api-map.json'), JSON.stringify({ endpoints: [] }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function inventory(name: string, id: string): void {
  writeFileSync(
    join(directory, name),
    JSON.stringify({ framework: 'react', routes: [{ id, path: '/' + id }] }),
  );
}
function sense() {
  return senseInventoryCoverage({
    repoRoot: root,
    persistBody: false,
    now: '2026-09-09T12:00:00.000Z',
  });
}
describe('route inventory filename boundaries', () => {
  it.each(['backup-routes-react.json', 'routes-react.json.backup'])(
    'does not infer routes from %s',
    (name) => {
      inventory(name, 'decoy');
      const result = sense();
      expect(result.body).toMatchObject({ routes: [], stats: { routeCount: 0 } });
      expect(result.reading.findings).toEqual(
        expect.arrayContaining([
          {
            severity: 'warning',
            code: 'COVERAGE_REQUIRES_ROUTES',
            message: `No routes-inventory body found under ${directory}. Run 'devai sense run inventory_routes' first.`,
          },
        ]),
      );
    },
  );
  it('selects the single canonical filename despite prefixed and suffixed neighbors', () => {
    inventory('routes-react.json', 'actual');
    inventory('backup-routes-react.json', 'prefix');
    inventory('routes-react.json.backup', 'suffix');
    const result = sense();
    expect(result.body).toMatchObject({ routes: ['actual'], stats: { routeCount: 1 } });
    expect(result.reading.findings?.map((f) => f.code)).not.toContain('COVERAGE_ROUTES_AMBIGUOUS');
    expect(result.bodyPath).toBeNull();
  });
});
