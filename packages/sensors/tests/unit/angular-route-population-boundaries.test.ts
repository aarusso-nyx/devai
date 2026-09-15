import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { senseInventoryRoutes } from '../../src/inventory-routes.js';

const NOW = '2026-09-08T12:00:00.000Z';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devai-angular-route-population-'));
  mkdirSync(join(root, 'apps/angular'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(source: string): void {
  writeFileSync(join(root, 'apps/angular/app.routes.ts'), source);
}

function sense() {
  return senseInventoryRoutes({
    repoRoot: root,
    scanDirs: ['apps/angular'],
    framework: 'angular',
    persistBody: false,
    now: NOW,
  });
}

describe('Angular route population boundaries', () => {
  it('walks only typed Routes arrays and only their real children arrays', () => {
    write(`
      type MenuEntries = { path: string; component: unknown }[];
      const menu: MenuEntries = [{ path: 'metadata', component: MenuComponent }];
      export const routes: Routes = [
        { path: 'accounts', component: AccountsComponent, data: [{ path: 'metadata-child' }] },
      ];
    `);

    const result = sense();

    expect(result.reading.status).toBe('pass');
    expect(result.body.routes.map((route) => route.path)).toEqual(['accounts']);
    expect(result.body.routes[0]?.component?.name).toBe('AccountsComponent');
  });

  it('does not infer a component from a lazy callback without then', () => {
    write(`
      export const routes: Routes = [
        { path: 'accounts', loadComponent: () => import('./accounts').catch(m => m.AccountsComponent) },
      ];
    `);

    const result = sense();

    expect(result.reading.status).toBe('pass');
    expect(result.body.routes).toEqual([expect.objectContaining({ path: 'accounts' })]);
    expect(result.body.routes[0]?.component).toBeUndefined();
  });

  it('sorts duplicate paths by their distinct deterministic route IDs', () => {
    write(`
      export const routes: Routes = [
${Array.from({ length: 10 }, (_, index) => `        { path: 'same', component: Component${index} },`).join('\n')}
      ];
    `);

    const result = sense();
    const samePath = result.body.routes.filter((route) => route.path === 'same');
    const ids = samePath.map((route) => route.id);

    expect(result.reading.status).toBe('pass');
    expect(samePath).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toEqual([...ids].sort());
  });
});
