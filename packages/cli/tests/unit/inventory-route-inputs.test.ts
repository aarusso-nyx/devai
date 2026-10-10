// ADR-SCR-0015: explicit inventory overrides retain the declared checkout boundary.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveInventoryRouteInputs } from '../../src/commands/sense/inventory-inputs.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'devai-route-boundary-'));
  roots.push(parent);
  const root = join(parent, 'checkout');
  const outside = join(parent, 'sibling');
  mkdirSync(join(root, 'apps/angular'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'escape'));
  return { root, outside };
}

describe('explicit inventory route population containment', () => {
  it('keeps a contained relative Angular population', () => {
    const { root } = fixture();
    expect(
      resolveInventoryRouteInputs(root, { framework: 'angular', scanDirs: ['apps/angular'] }),
    ).toEqual({ framework: 'angular', scanDirs: ['apps/angular'] });
  });

  it.each(['../sibling', 'apps/../../sibling', 'escape', 'escape/missing'])(
    'refuses escaping explicit scan directory %s before the source walk',
    (path) => {
      const { root } = fixture();
      expect(() =>
        resolveInventoryRouteInputs(root, { framework: 'angular', scanDirs: [path] }),
      ).toThrow();
    },
  );

  it('refuses an absolute external population', () => {
    const { root, outside } = fixture();
    expect(() =>
      resolveInventoryRouteInputs(root, { framework: 'angular', scanDirs: [outside] }),
    ).toThrow();
  });
});
