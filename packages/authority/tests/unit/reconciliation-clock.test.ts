import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const sourcePath = resolve(ROOT, 'packages/authority/src/runtime/reconciliation-clock.ts');
const checkpointPath = resolve(
  ROOT,
  'docs/dev/operations/u1-b1-recovery-20261024/release-280/b1-design/owner-clock-kernel-checkpoint.json',
);
const codes = [
  'RECONCILIATION_CLOCK_INVALID',
  'RECONCILIATION_CLOCK_BOOT_CHANGED',
  'RECONCILIATION_CLOCK_ROLLBACK',
  'RECONCILIATION_CLOCK_DIVERGED',
  'RECONCILIATION_CLOCK_EXPIRED',
];

describe('pure reconciliation clock eligibility', () => {
  it('has the actual pure clock module required by the frozen contract', () => {
    expect(existsSync(sourcePath), 'actual pure clock module is absent').toBe(true);
  });
  it('uses the exact five frozen diagnostic codes', () => {
    const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as { codes: string[] };
    expect(checkpoint.codes).toEqual(codes);
  });
});

interface Observation {
  readonly clock_source: 'node-uv-hrtime-ns-v1';
  readonly boot_id: string;
  readonly monotonic_ns: string;
  readonly wall_ms: number;
}
interface ClockApi {
  readonly ReconciliationClockError: new (...args: never[]) => Error & { readonly code: string };
  validateReconciliationClockObservation(value: unknown): Observation;
  checkReconciliationClockWindow(
    issued: unknown,
    observed: unknown,
    kind: unknown,
    predecessor?: unknown,
  ): Readonly<{ wall_elapsed_ms: number; monotonic_elapsed_ns: string }>;
}
let modulePromise: Promise<ClockApi> | undefined;
function clock(): Promise<ClockApi> {
  return (modulePromise ??= import(sourcePath) as Promise<ClockApi>);
}
const BOOT = '12345678-1234-1234-1234-123456789abc';
const OTHER_BOOT = '87654321-4321-4321-4321-cba987654321';
const BASE_NS = 9007199254740993123n;
const BASE_WALL = 1_800_000_000_000;
function observation(ms = 0, ns = BigInt(ms) * 1_000_000n): Observation {
  return {
    clock_source: 'node-uv-hrtime-ns-v1',
    boot_id: BOOT,
    monotonic_ns: String(BASE_NS + ns),
    wall_ms: BASE_WALL + ms,
  };
}
function expectCode(api: ClockApi, fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(api.ReconciliationClockError);
  expect(caught).toMatchObject({ name: 'ReconciliationClockError', code, message: code });
  expect(caught).not.toHaveProperty('cause');
  expect(String(caught)).not.toContain('SECRET_');
}
const INVALID = 'RECONCILIATION_CLOCK_INVALID';
const BOOT_CHANGED = 'RECONCILIATION_CLOCK_BOOT_CHANGED';
const ROLLBACK = 'RECONCILIATION_CLOCK_ROLLBACK';
const DIVERGED = 'RECONCILIATION_CLOCK_DIVERGED';
const EXPIRED = 'RECONCILIATION_CLOCK_EXPIRED';

describe('clock observation shape and ownership', () => {
  it('returns a distinct frozen exact copy without input mutation and admits null prototypes', async () => {
    const api = await clock();
    const value = observation();
    const before = structuredClone(value);
    const copy = api.validateReconciliationClockObservation(value);
    expect(copy).toEqual(value);
    expect(copy).not.toBe(value);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(value).toEqual(before);
    expect(Object.isFrozen(value)).toBe(false);
    const nullObject = Object.assign(Object.create(null) as object, value);
    expect(api.validateReconciliationClockObservation(nullObject)).toEqual(value);
    expect(Object.keys(copy).sort()).toEqual(
      ['clock_source', 'boot_id', 'monotonic_ns', 'wall_ms'].sort(),
    );
  });
  for (const [name, field, value] of [
    ['source', 'clock_source', 'os-uptime-ms-v1'],
    ['source-number', 'clock_source', 1],
    ['boot-uppercase', 'boot_id', BOOT.toUpperCase()],
    ['boot-short', 'boot_id', '1234'],
    ['boot-newline', 'boot_id', BOOT + '\n'],
    ['boot-space', 'boot_id', ' ' + BOOT],
    ['boot-no-hyphens', 'boot_id', BOOT.replaceAll('-', '')],
    ['boot-nonhex', 'boot_id', 'g2345678-1234-1234-1234-123456789abc'],
    ['ns-zero', 'monotonic_ns', '0'],
    ['ns-leading-zero', 'monotonic_ns', '01'],
    ['ns-negative', 'monotonic_ns', '-1'],
    ['ns-plus', 'monotonic_ns', '+1'],
    ['ns-exponent', 'monotonic_ns', '1e9'],
    ['ns-space', 'monotonic_ns', ' 1'],
    ['ns-newline', 'monotonic_ns', '1\n'],
    ['ns-number', 'monotonic_ns', 1],
    ['ns-bigint', 'monotonic_ns', 1n],
    ['ns-uint64-over', 'monotonic_ns', '18446744073709551616'],
    ['ns-too-long', 'monotonic_ns', '100000000000000000000'],
    ['ns-non-ascii', 'monotonic_ns', '١'],
    ['wall-negative', 'wall_ms', -1],
    ['wall-negative-zero', 'wall_ms', -0],
    ['wall-fraction', 'wall_ms', 0.1],
    ['wall-nan', 'wall_ms', Number.NaN],
    ['wall-infinity', 'wall_ms', Number.POSITIVE_INFINITY],
    ['wall-unsafe', 'wall_ms', Number.MAX_SAFE_INTEGER + 1],
    ['wall-string', 'wall_ms', '0'],
    ['wall-bigint', 'wall_ms', 0n],
  ] as const)
    it(`refuses malformed ${name} without coercion`, async () => {
      const api = await clock();
      expectCode(
        api,
        () => api.validateReconciliationClockObservation({ ...observation(), [field]: value }),
        INVALID,
      );
    });
  it('accepts exact positive uint64 endpoints and wall safe endpoints for observation validation', async () => {
    const api = await clock();
    for (const monotonic_ns of ['1', '18446744073709551615'])
      for (const wall_ms of [0, Number.MAX_SAFE_INTEGER])
        expect(
          api.validateReconciliationClockObservation({ ...observation(), monotonic_ns, wall_ms }),
        ).toMatchObject({ monotonic_ns, wall_ms });
  });
  for (const variant of [
    'null',
    'array',
    'date',
    'primitive',
    'unknown',
    'symbol',
    'missing',
    'nonenumerable',
    'prototype',
    'getter',
    'proxy',
    'nested-proxy',
    'coercion',
  ])
    it(`refuses ${variant} observation without traps/getters/coercion`, async () => {
      const api = await clock();
      let touches = 0;
      let value: unknown = { ...observation() };
      if (variant === 'null') value = null;
      if (variant === 'array') value = [];
      if (variant === 'date') value = new Date();
      if (variant === 'primitive') value = 'SECRET_PRIMITIVE';
      if (variant === 'unknown') value = { ...observation(), extra: 'SECRET_EXTRA' };
      if (variant === 'symbol') value = { ...observation(), [Symbol('SECRET_SYMBOL')]: 1 };
      if (variant === 'missing') {
        const { boot_id: _omitted, ...record } = observation();
        value = record;
      }
      if (variant === 'nonenumerable')
        value = Object.defineProperty({ ...observation() }, 'boot_id', {
          value: BOOT,
          enumerable: false,
        });
      if (variant === 'prototype')
        value = Object.assign(
          Object.create({
            toJSON() {
              touches++;
              throw Error('SECRET_PROTO');
            },
          }) as object,
          observation(),
        );
      if (variant === 'getter')
        value = Object.defineProperty({ ...observation() }, 'wall_ms', {
          enumerable: true,
          get() {
            touches++;
            throw Error('SECRET_GETTER');
          },
        });
      if (variant === 'proxy')
        value = new Proxy(observation(), {
          ownKeys() {
            touches++;
            throw Error('SECRET_PROXY');
          },
        });
      if (variant === 'nested-proxy')
        value = {
          ...observation(),
          wall_ms: new Proxy(
            {},
            {
              get() {
                touches++;
                throw Error('SECRET_NESTED');
              },
            },
          ),
        };
      if (variant === 'coercion')
        value = {
          ...observation(),
          monotonic_ns: {
            valueOf() {
              touches++;
              throw Error('SECRET_VALUEOF');
            },
            toString() {
              touches++;
              throw Error('SECRET_TOSTRING');
            },
            toJSON() {
              touches++;
              throw Error('SECRET_TOJSON');
            },
          },
        };
      expectCode(api, () => api.validateReconciliationClockObservation(value), INVALID);
      expect(touches).toBe(0);
    });
});

describe('exact independent clock windows', () => {
  for (const [kind, ms, ns] of [
    ['review', 300000, 300000000000n],
    ['grant', 900000, 900000000000n],
  ] as const) {
    it(`${kind} succeeds just before both bounds and returns distinct frozen elapsed metadata`, async () => {
      const api = await clock();
      const issued = observation();
      const observed = observation(ms - 1, ns - 1n);
      const before = structuredClone([issued, observed]);
      const result = api.checkReconciliationClockWindow(issued, observed, kind);
      expect(result).toEqual({ wall_elapsed_ms: ms - 1, monotonic_elapsed_ns: String(ns - 1n) });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.keys(result).sort()).toEqual(['monotonic_elapsed_ns', 'wall_elapsed_ms']);
      expect(api.checkReconciliationClockWindow(issued, observed, kind)).not.toBe(result);
      expect([issued, observed]).toEqual(before);
    });
    for (const [suffix, wall, mono] of [
      ['wall-equality', ms, ns - 1n],
      ['mono-equality', ms - 1, ns],
      ['both-equality', ms, ns],
      ['wall-after', ms + 1, ns - 1n],
      ['mono-after', ms - 1, ns + 1n],
    ] as const)
      it(`${kind} expires at ${suffix} without floating ns loss`, async () => {
        const api = await clock();
        expectCode(
          api,
          () => api.checkReconciliationClockWindow(observation(), observation(wall, mono), kind),
          EXPIRED,
        );
      });
    it(`${kind} detects issue plus lifetime overflow rather than wrap or saturation`, async () => {
      const api = await clock();
      const max = 18446744073709551615n;
      const issued = { ...observation(), monotonic_ns: String(max - ns + 1n) };
      expectCode(api, () => api.checkReconciliationClockWindow(issued, issued, kind), INVALID);
      const edge = { ...observation(), monotonic_ns: String(max - ns) };
      expect(api.checkReconciliationClockWindow(edge, edge, kind)).toEqual({
        wall_elapsed_ms: 0,
        monotonic_elapsed_ns: '0',
      });
      const wallOverflow = { ...observation(), wall_ms: Number.MAX_SAFE_INTEGER - ms + 1 };
      expectCode(
        api,
        () => api.checkReconciliationClockWindow(wallOverflow, wallOverflow, kind),
        INVALID,
      );
      const wallEdge = { ...observation(), wall_ms: Number.MAX_SAFE_INTEGER - ms };
      expect(api.checkReconciliationClockWindow(wallEdge, wallEdge, kind)).toEqual({
        wall_elapsed_ms: 0,
        monotonic_elapsed_ns: '0',
      });
    });
  }
  for (const [name, ms, ns, valid] of [
    ['wall-equality', 2000, 0n, true],
    ['wall-one-ms-over', 2001, 0n, false],
    ['mono-equality', 0, 2000000000n, true],
    ['mono-one-ns-over', 0, 2000000001n, false],
  ] as const)
    it(`uses exact disagreement guard for ${name}`, async () => {
      const api = await clock();
      const fn = () =>
        api.checkReconciliationClockWindow(observation(), observation(ms, ns), 'review');
      if (valid) expect(fn()).toEqual({ wall_elapsed_ms: ms, monotonic_elapsed_ns: String(ns) });
      else expectCode(api, fn, DIVERGED);
    });
  it('retains an exact single nanosecond beyond2^53 and never rounds via Number', async () => {
    const api = await clock();
    expect(api.checkReconciliationClockWindow(observation(), observation(0, 1n), 'review')).toEqual(
      { wall_elapsed_ms: 0, monotonic_elapsed_ns: '1' },
    );
  });
  it('permits an earlier authenticated predecessor at renewal but checks both elapsed references', async () => {
    const api = await clock();
    const predecessor = observation(-1000);
    const issued = observation();
    const observed = observation(1000);
    expect(api.checkReconciliationClockWindow(issued, observed, 'grant', predecessor)).toEqual({
      wall_elapsed_ms: 1000,
      monotonic_elapsed_ns: '1000000000',
    });
    const divergent = { ...observation(-1000), monotonic_ns: String(BASE_NS - 3000000001n) };
    expectCode(
      api,
      () => api.checkReconciliationClockWindow(issued, observed, 'grant', divergent),
      DIVERGED,
    );
  });
  for (const relative of ['issued', 'predecessor'])
    for (const field of ['wall', 'monotonic'])
      it(`refuses ${field} rollback relative to ${relative}`, async () => {
        const api = await clock();
        const issued = observation();
        const observed = observation(1000);
        let predecessor: Observation | undefined;
        if (relative === 'issued') {
          const rolled =
            field === 'wall'
              ? { ...observed, wall_ms: issued.wall_ms - 1 }
              : { ...observed, monotonic_ns: String(BASE_NS - 1n) };
          expectCode(
            api,
            () => api.checkReconciliationClockWindow(issued, rolled, 'review'),
            ROLLBACK,
          );
        } else {
          predecessor =
            field === 'wall'
              ? { ...observation(1000), wall_ms: observed.wall_ms + 1 }
              : { ...observation(1000), monotonic_ns: String(BigInt(observed.monotonic_ns) + 1n) };
          expectCode(
            api,
            () => api.checkReconciliationClockWindow(issued, observed, 'review', predecessor),
            ROLLBACK,
          );
        }
      });
  for (const relative of ['observed', 'predecessor'])
    it(`refuses ${relative} boot change`, async () => {
      const api = await clock();
      const issued = observation();
      const observed =
        relative === 'observed' ? { ...observation(1), boot_id: OTHER_BOOT } : observation(1);
      const predecessor =
        relative === 'predecessor' ? { ...issued, boot_id: OTHER_BOOT } : undefined;
      expectCode(
        api,
        () => api.checkReconciliationClockWindow(issued, observed, 'review', predecessor),
        BOOT_CHANGED,
      );
    });
  it('does not treat predecessor age as a renewed issue lifetime', async () => {
    const api = await clock();
    expect(
      api.checkReconciliationClockWindow(
        observation(),
        observation(1),
        'review',
        observation(-900001),
      ),
    ).toEqual({ wall_elapsed_ms: 1, monotonic_elapsed_ns: '1000000' });
  });
});

describe('closed clock comparison precedence', () => {
  it('validates every supplied observation before an otherwise expired window', async () => {
    const api = await clock();
    expectCode(
      api,
      () => api.checkReconciliationClockWindow(observation(), observation(900000), 'review', null),
      INVALID,
    );
    expectCode(
      api,
      () =>
        api.checkReconciliationClockWindow(observation(), observation(900000), 'review', {
          ...observation(),
          extra: true,
        }),
      INVALID,
    );
  });
  it('treats omitted and explicit undefined predecessor identically', async () => {
    const api = await clock();
    expect(api.checkReconciliationClockWindow(observation(), observation(1), 'review')).toEqual(
      api.checkReconciliationClockWindow(observation(), observation(1), 'review', undefined),
    );
  });
  for (const kind of ['REVIEW', 'grant\n', '', null, {}, new String('review')])
    it(`refuses malformed kind ${typeof kind} before other comparisons`, async () => {
      const api = await clock();
      expectCode(
        api,
        () => api.checkReconciliationClockWindow(observation(), observation(900000), kind),
        INVALID,
      );
    });
  it('checks overflow before boot change, boot before rollback, rollback before disagreement, disagreement before expiry', async () => {
    const api = await clock();
    const overflow = { ...observation(), monotonic_ns: '18446744073709551615' };
    expectCode(
      api,
      () =>
        api.checkReconciliationClockWindow(
          overflow,
          { ...overflow, boot_id: OTHER_BOOT },
          'review',
        ),
      INVALID,
    );
    expectCode(
      api,
      () =>
        api.checkReconciliationClockWindow(
          observation(),
          { ...observation(-1), boot_id: OTHER_BOOT },
          'review',
        ),
      BOOT_CHANGED,
    );
    expectCode(
      api,
      () =>
        api.checkReconciliationClockWindow(observation(), observation(-1, 3000000001n), 'review'),
      ROLLBACK,
    );
    expectCode(
      api,
      () =>
        api.checkReconciliationClockWindow(
          observation(),
          observation(300000, 297999999999n),
          'review',
        ),
      DIVERGED,
    );
  });
});

for (const [name, wallOffset, nsOffset, valid] of [
  ['predecessor-wall-exact', -2000, 0n, true],
  ['predecessor-wall-over', -2001, 0n, false],
  ['predecessor-mono-exact', 0, -2000000000n, true],
  ['predecessor-mono-over', 0, -2000000001n, false],
] as const)
  it(`independently checks ${name} drift without renewing issue time`, async () => {
    const api = await clock();
    const issued = observation();
    const predecessor = observation(wallOffset, nsOffset);
    const fn = () => api.checkReconciliationClockWindow(issued, issued, 'review', predecessor);
    if (valid) expect(fn()).toEqual({ wall_elapsed_ms: 0, monotonic_elapsed_ns: '0' });
    else expectCode(api, fn, DIVERGED);
  });
it('rejects a Proxy kind without property lookup or coercion', async () => {
  const api = await clock();
  let touches = 0;
  const kind = new Proxy(
    {},
    {
      get() {
        touches++;
        throw Error('SECRET_KIND_PROXY');
      },
    },
  );
  expectCode(
    api,
    () => api.checkReconciliationClockWindow(observation(), observation(), kind),
    INVALID,
  );
  expect(touches).toBe(0);
});
