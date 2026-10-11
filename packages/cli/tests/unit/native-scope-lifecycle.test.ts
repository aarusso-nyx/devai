// ADR-SCR-0017: lifecycle facts come from actual pinned Playwright, never authored execution standing.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertNativeScopeLifecycle } from '../../src/commands/sense/native-input-provenance.js';

type Row = Record<string, unknown>;
const capture = (): Row[] =>
  JSON.parse(
    readFileSync(
      new URL('../fixtures/native-test-results/playwright-lifecycle.json', import.meta.url),
      'utf8',
    ),
  ) as Row[];
const first = (rows: readonly Row[], matches: (row: Row) => boolean): Row => {
  const row = rows.find(matches);
  if (row === undefined) throw new Error('Authentic lifecycle fixture has no requested event');
  return row;
};
const loaderScope = first(capture(), (row) => row['kind'] === 'loader-registration')['childScope'];
const workerScope = first(capture(), (row) => row['kind'] === 'child')['childScope'];
const kind =
  (event: string, scope: unknown = loaderScope) =>
  (row: Row) =>
    row['kind'] === event && row['scope'] === scope;
function moveBefore(rows: Row[], event: (row: Row) => boolean, before: (row: Row) => boolean) {
  const selected = first(rows, event);
  rows.splice(rows.indexOf(selected), 1);
  rows.splice(rows.indexOf(first(rows, before)), 0, selected);
}
function duplicate(rows: Row[], matches: (row: Row) => boolean) {
  const selected = first(rows, matches);
  rows.splice(rows.indexOf(selected), 0, { ...selected });
}

describe('native scope lifecycle ordering', () => {
  it('accepts the actual complete Playwright parent, worker and two loader lifetimes', () => {
    const rows = capture();
    expect(rows.filter((row) => row['kind'] === 'loader-registration')).toHaveLength(2);
    expect(rows.filter((row) => row['kind'] === 'begin')).toHaveLength(4);
    expect(rows.filter((row) => row['kind'] === 'loader-hook-start')).toHaveLength(174);
    expect(() => assertNativeScopeLifecycle(rows)).not.toThrow();
  });

  it('accepts actual Vitest fork lifetimes sealed before their owner terminals', () => {
    const rows = JSON.parse(
      readFileSync(
        new URL('../fixtures/native-test-results/vitest-complete-lifecycle.json', import.meta.url),
        'utf8',
      ),
    ) as Row[];
    const children = rows.filter((row) => row['kind'] === 'child');
    expect(children).toHaveLength(2);
    expect(rows.filter((row) => row['kind'] === 'end')).toHaveLength(3);
    expect(() => assertNativeScopeLifecycle(rows)).not.toThrow();
    for (const child of children) {
      const partial = rows.filter(
        (row) => row['kind'] !== 'end' || row['scope'] !== child['childScope'],
      );
      expect(() => assertNativeScopeLifecycle(partial)).toThrow(
        'NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID',
      );
    }
  });

  it('refuses an actual native-success Vitest trace whose terminated workers have no own terminal', () => {
    const rows = JSON.parse(
      readFileSync(
        new URL('../fixtures/native-test-results/vitest-lifecycle.json', import.meta.url),
        'utf8',
      ),
    ) as Row[];
    const children = rows.filter((row) => row['kind'] === 'child');
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(
        rows.some(
          (row) => row['kind'] === 'child-end' && row['childScope'] === child['childScope'],
        ),
      ).toBe(true);
      expect(rows.some(kind('end', child['childScope']))).toBe(false);
    }
    expect(() => assertNativeScopeLifecycle(rows)).toThrow('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  });

  it('refuses an ordinary child owner terminal when its actual own end is removed', () => {
    const rows = capture();
    const ownEnd = first(rows, kind('end', workerScope));
    rows.splice(rows.indexOf(ownEnd), 1);
    expect(
      rows.some((row) => row['kind'] === 'child-end' && row['childScope'] === workerScope),
    ).toBe(true);
    expect(() => assertNativeScopeLifecycle(rows)).toThrow('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  });

  it.each([
    [
      'loader begin before registration',
      (rows: Row[]) =>
        moveBefore(
          rows,
          kind('begin'),
          (row: Row) => row['kind'] === 'loader-registration' && row['childScope'] === loaderScope,
        ),
    ],
    [
      'loader ready before begin',
      (rows: Row[]) => moveBefore(rows, kind('loader-ready'), kind('begin')),
    ],
    [
      'owner acknowledgement before loader end',
      (rows: Row[]) =>
        moveBefore(
          rows,
          (row: Row) => row['kind'] === 'loader-acknowledged' && row['childScope'] === loaderScope,
          kind('end'),
        ),
    ],
    [
      'loader end while a hook remains active',
      (rows: Row[]) => {
        const readyIndex = rows.indexOf(first(rows, kind('loader-ready')));
        const activeEnd = first(rows.slice(readyIndex + 1), kind('loader-hook-end'));
        moveBefore(rows, kind('end'), (row: Row) => row === activeEnd);
      },
    ],
    [
      'worker begins before parent declares it',
      (rows: Row[]) =>
        moveBefore(
          rows,
          kind('begin', workerScope),
          (row: Row) => row['kind'] === 'child' && row['childScope'] === workerScope,
        ),
    ],
    [
      'parent declares child end before child terminal',
      (rows: Row[]) =>
        moveBefore(
          rows,
          (row: Row) => row['kind'] === 'child-end' && row['childScope'] === workerScope,
          kind('end', workerScope),
        ),
    ],
    [
      'main ends before its worker terminal',
      (rows: Row[]) => moveBefore(rows, kind('end', 'main'), kind('end', workerScope)),
    ],
  ] as const)('refuses reordered genuine events: %s', (_name, mutate) => {
    const rows = capture();
    mutate(rows);
    expect(() => assertNativeScopeLifecycle(rows)).toThrow('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  });

  it.each(['begin', 'end', 'loader-ready'])(
    'refuses duplicated genuine %s terminal or initialization',
    (event) => {
      const rows = capture();
      duplicate(rows, kind(event));
      expect(() => assertNativeScopeLifecycle(rows)).toThrow(
        'NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID',
      );
    },
  );

  it('refuses duplicated owner acknowledgement', () => {
    const rows = capture();
    duplicate(
      rows,
      (row) => row['kind'] === 'loader-acknowledged' && row['childScope'] === loaderScope,
    );
    expect(() => assertNativeScopeLifecycle(rows)).toThrow('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  });

  it.each(['loader-registration', 'begin', 'end', 'loader-ready', 'loader-acknowledged'])(
    'refuses an orphan or incomplete lifetime after removal of genuine %s',
    (event) => {
      const rows = capture();
      const selected = first(
        rows,
        (row) =>
          row['kind'] === event &&
          (event === 'loader-registration' || event === 'loader-acknowledged'
            ? row['childScope'] === loaderScope
            : row['scope'] === loaderScope),
      );
      rows.splice(rows.indexOf(selected), 1);
      expect(() => assertNativeScopeLifecycle(rows)).toThrow(
        'NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID',
      );
    },
  );

  it('refuses a genuine hook pair moved after its loader terminal', () => {
    const rows = capture();
    const start = first(rows, kind('loader-hook-start'));
    const end = first(
      rows,
      (row) => kind('loader-hook-end')(row) && row['operation'] === start['operation'],
    );
    rows.splice(rows.indexOf(start), 1);
    rows.splice(rows.indexOf(end), 1);
    const terminal = first(rows, kind('end'));
    rows.splice(rows.indexOf(terminal) + 1, 0, start, end);
    expect(() => assertNativeScopeLifecycle(rows)).toThrow('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  });

  it('refuses a genuine hook completion after removal of its matching start', () => {
    const rows = capture();
    const start = first(rows, kind('loader-hook-start'));
    rows.splice(rows.indexOf(start), 1);
    expect(() => assertNativeScopeLifecycle(rows)).toThrow('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  });

  it('refuses replay of a completed genuine hook operation identity', () => {
    const rows = capture();
    const start = first(rows, kind('loader-hook-start'));
    const end = first(
      rows,
      (row) => kind('loader-hook-end')(row) && row['operation'] === start['operation'],
    );
    rows.splice(rows.indexOf(end) + 1, 0, { ...start }, { ...end });
    expect(() => assertNativeScopeLifecycle(rows)).toThrow('NATIVE_INPUT_SCOPE_LIFECYCLE_INVALID');
  });
});
