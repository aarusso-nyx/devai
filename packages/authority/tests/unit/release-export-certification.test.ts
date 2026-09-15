import { describe, expect, it } from 'vitest';
import { captureExportCertificationUnitProjections } from '../../src/boundaries/release-export-certification.js';

const identity = (hex = 'a') => ({ sha256: hex.repeat(64), size_bytes: 1 });
const packages = [
  { package_id: '@fixture/z', release_unit: 'unit' },
  { package_id: '@fixture/a', release_unit: 'unit' },
];
function unit(release_unit = 'unit', carrier_package_id = '@fixture/a') {
  return {
    release_unit,
    carrier_package_id,
    carrier: identity(),
    derivation_binding_digest_sha256: 'a'.repeat(64),
    candidate_receipt: identity(),
    task_policy: identity(),
    task_results: [identity('a'), identity('b')],
    namespace_census: identity(),
    census_member_projection_digest_sha256: 'b'.repeat(64),
    census_member_count: 0,
  };
}
function capture(value: unknown, roster: unknown = packages, maximum = 10) {
  return captureExportCertificationUnitProjections(value, roster as typeof packages, maximum);
}
const refusal = (callback: () => unknown) =>
  expect(callback).toThrow('AUTHORITY_PROTECTED_RELEASE_BINDING_INVALID');

describe('certification export identity population', () => {
  it('selects the lexically first carrier independently of package order', () => {
    const value = unit();
    expect(capture([value])).toEqual([value]);
    expect(capture([value], [...packages].reverse())).toEqual([value]);
    refusal(() => capture([{ ...value, carrier_package_id: '@fixture/z' }]));
    refusal(() => capture([{ ...value, carrier_package_id: '@fixture/missing' }]));
  });

  it('accepts exactly one complete ordered carrier for each unit', () => {
    const roster = [...packages, { package_id: '@fixture/second', release_unit: 'unit-two' }];
    const first = unit(),
      second = unit('unit-two', '@fixture/second');
    expect(capture([first, second], roster)).toEqual([first, second]);
    for (const value of [[], [first], [second, first], [first, first], [first, second, second]])
      refusal(() => capture(value, roster));
    refusal(() => capture([unit('other-unit')]));
    refusal(() => capture([first], []));
    refusal(() => capture([first], [...packages, packages[0]]));
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid package limits %s',
    (maximum) => {
      refusal(() => capture([unit()], packages, maximum));
    },
  );

  it('enforces the maximum package population even when it shares one release unit', () => {
    expect(capture([unit()], packages, 2)).toHaveLength(1);
    refusal(() => capture([unit()], packages, 1));
  });

  it.each(['', 'UPPER', '@scope', '@scope/UPPER', 'package/child', 'a b', 'a'.repeat(215)])(
    'rejects invalid package id %j',
    (package_id) => {
      refusal(() => capture([unit('unit', package_id)], [{ package_id, release_unit: 'unit' }]));
    },
  );

  it.each(['', 'e\u0301', 'a\0b', 'a\nb', '\ud800', 'a'.repeat(201)])(
    'rejects invalid release-unit text %j',
    (release_unit) => {
      refusal(() => capture([unit(release_unit)], [{ package_id: '@fixture/a', release_unit }]));
    },
  );

  it('accepts normalized non-ASCII unit identities in byte order', () => {
    const roster = [
      { package_id: 'a', release_unit: 'z' },
      { package_id: 'b', release_unit: 'é' },
    ];
    const values = [unit('z', 'a'), unit('é', 'b')];
    expect(capture(values, roster)).toEqual(values);
    refusal(() => capture([...values].reverse(), roster));
  });

  it('requires every byte-identity field and both projection digests', () => {
    const value = unit();
    for (const field of [
      'carrier',
      'candidate_receipt',
      'task_policy',
      'namespace_census',
    ] as const) {
      for (const invalid of [
        null,
        {},
        { ...identity(), extra: true },
        { ...identity(), sha256: 'A'.repeat(64) },
        { ...identity(), sha256: 'a'.repeat(63) },
        { ...identity(), sha256: 'a'.repeat(65) },
      ])
        refusal(() => capture([{ ...value, [field]: invalid }]));
    }
    for (const field of [
      'derivation_binding_digest_sha256',
      'census_member_projection_digest_sha256',
    ] as const)
      for (const digest of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 1])
        refusal(() => capture([{ ...value, [field]: digest }]));
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects invalid archive sizes %s',
    (size_bytes) => {
      refusal(() => capture([{ ...unit(), carrier: { sha256: 'a'.repeat(64), size_bytes } }]));
    },
  );

  it('distinguishes a valid empty census from invalid census counts', () => {
    expect(capture([unit()])[0]?.census_member_count).toBe(0);
    expect(capture([{ ...unit(), census_member_count: 1 }])[0]?.census_member_count).toBe(1);
    for (const count of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])
      refusal(() => capture([{ ...unit(), census_member_count: count }]));
  });

  it('requires nonempty, unique, ascending result identities', () => {
    const value = unit();
    for (const task_results of [
      [],
      [identity('b'), identity('a')],
      [identity('a'), identity('a')],
      [{ ...identity(), size_bytes: 0 }],
      [identity(), null],
    ])
      refusal(() => capture([{ ...value, task_results }]));
    expect(capture([{ ...value, task_results: [identity()] }])[0]?.task_results).toEqual([
      identity(),
    ]);
  });

  it('rejects extra, missing, hidden, and symbol record members', () => {
    const value = unit();
    for (const key of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value };
      Reflect.deleteProperty(missing, key);
      refusal(() => capture([missing]));
    }
    refusal(() => capture([{ ...value, extra: true }]));
    refusal(() => capture([{ ...value, [Symbol('hidden')]: true }]));
    refusal(() =>
      capture([Object.defineProperty({ ...value }, 'release_unit', { enumerable: false })]),
    );
    refusal(() => capture([Object.assign(Object.create({ inherited: true }), value)]));
    expect(capture([Object.assign(Object.create(null), value)])).toEqual([value]);
  });

  it('rejects sparse, augmented, and nonstandard arrays', () => {
    const sparse = new Array(1);
    const augmented = Object.assign([unit()], { extra: true });
    const inherited = Object.setPrototypeOf([unit()], {});
    for (const values of [null, {}, sparse, augmented, inherited]) refusal(() => capture(values));
    refusal(() => capture([{ ...unit(), task_results: new Array(1) }]));
    refusal(() => capture([unit()], Object.assign([...packages], { extra: true })));
  });

  it('rejects getters and proxies without invoking candidate code', () => {
    let calls = 0;
    const trap = () => {
      calls += 1;
      throw Error('candidate code invoked');
    };
    const accessor = Object.defineProperty(unit(), 'release_unit', { enumerable: true, get: trap });
    const rowAccessor = Object.defineProperty([unit()], '0', { enumerable: true, get: trap });
    const resultAccessor = Object.defineProperty([identity()], '0', {
      enumerable: true,
      get: trap,
    });
    for (const values of [
      [accessor],
      rowAccessor,
      [{ ...unit(), task_results: resultAccessor }],
      new Proxy([unit()], { get: trap, ownKeys: trap, getPrototypeOf: trap }),
      [new Proxy(unit(), { get: trap, ownKeys: trap, getPrototypeOf: trap })],
      [
        {
          ...unit(),
          carrier: new Proxy(identity(), { get: trap, ownKeys: trap, getPrototypeOf: trap }),
        },
      ],
    ])
      refusal(() => capture(values));
    expect(calls).toBe(0);
  });
});
