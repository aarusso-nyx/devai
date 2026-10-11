// The adapter's pure helpers neither invoke authored behavior nor register native standing.
import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isProxy, sameNativeData } from '../../src/native-coverage-adapter.js';

describe('finite native coverage data helpers', () => {
  it('uses Object.is semantics for supported primitive values', () => {
    for (const value of [
      undefined,
      null,
      true,
      false,
      17,
      NaN,
      Infinity,
      'text',
      12n,
      Symbol.for('owned'),
    ])
      expect(sameNativeData(value, value)).toBe(true);
    expect(sameNativeData(-0, 0)).toBe(false);
    expect(sameNativeData('1', 1)).toBe(false);
    expect(sameNativeData(Symbol('same'), Symbol('same'))).toBe(false);
  });
  it('compares detached ordinary and null-prototype data without mutating descriptors', () => {
    const left = Object.freeze({ nested: Object.freeze([1, { name: 'owned' }]), empty: null });
    const right = Object.freeze({ nested: Object.freeze([1, { name: 'owned' }]), empty: null });
    expect(sameNativeData(left, right)).toBe(true);
    const a = Object.assign(Object.create(null), { owned: [1, 2] });
    const b = Object.assign(Object.create(null), { owned: [1, 2] });
    expect(sameNativeData(a, b)).toBe(true);
    expect(Object.getPrototypeOf(a)).toBeNull();
    expect(Object.isFrozen(left.nested)).toBe(true);
  });
  it('binds exact own descriptor flags and symbol keys', () => {
    const key = Symbol('owned');
    const left = Object.defineProperty({ [key]: 1 }, 'hidden', {
      value: 'value',
      enumerable: false,
      writable: false,
      configurable: false,
    });
    const right = Object.defineProperty({ [key]: 1 }, 'hidden', {
      value: 'value',
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(sameNativeData(left, right)).toBe(true);
    const altered = Object.defineProperty({ [key]: 1 }, 'hidden', {
      value: 'value',
      enumerable: false,
      writable: true,
      configurable: false,
    });
    expect(sameNativeData(left, altered)).toBe(false);
    expect(sameNativeData({ [key]: 1 }, { [Symbol('owned')]: 1 })).toBe(false);
  });
  it('compares the same own keys regardless of record insertion order', () => {
    const key = Symbol('owned');
    const left = { first: 1, second: { value: 2 }, [key]: 3 };
    const right = { [key]: 3, second: { value: 2 }, first: 1 };
    expect(Object.keys(left)).not.toEqual(Object.keys(right));
    expect(sameNativeData(left, right)).toBe(true);
    expect(sameNativeData(left, { ...right, first: 4 })).toBe(false);
  });
  it('distinguishes missing fields, array holes, and extra own array data', () => {
    expect(sameNativeData({}, { absent: undefined })).toBe(false);
    expect(sameNativeData(new Array(1), [undefined])).toBe(false);
    const left = Object.assign([1], { own: 'a' });
    const right = Object.assign([1], { own: 'b' });
    expect(sameNativeData(left, right)).toBe(false);
  });
  it('compares paired cycles and observes data mismatch within those cycles', () => {
    const left: { value: number; self?: unknown } = { value: 1 };
    left.self = left;
    const right: { value: number; self?: unknown } = { value: 1 };
    right.self = right;
    expect(sameNativeData(left, right)).toBe(true);
    right.value = 2;
    expect(sameNativeData(left, right)).toBe(false);
  });
  it('identifies live and revoked proxies without invoking any trap', () => {
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        get: () => {
          traps++;
          throw new Error('get trap');
        },
        ownKeys: () => {
          traps++;
          throw new Error('keys trap');
        },
        getPrototypeOf: () => {
          traps++;
          throw new Error('prototype trap');
        },
        getOwnPropertyDescriptor: () => {
          traps++;
          throw new Error('descriptor trap');
        },
      },
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(isProxy(proxy)).toBe(true);
    expect(isProxy(revoked.proxy)).toBe(true);
    expect(isProxy({})).toBe(false);
    expect(isProxy(null)).toBe(false);
    expect(() => sameNativeData(proxy, proxy)).toThrow();
    expect(() => sameNativeData(revoked.proxy, revoked.proxy)).toThrow();
    expect(traps).toBe(0);
  });
  it('retains captured proxy detection after the public util predicate is replaced', () => {
    const original = types.isProxy;
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          traps++;
          return [];
        },
      },
    );
    try {
      types.isProxy = () => false;
      expect(isProxy(proxy)).toBe(true);
      expect(() => sameNativeData(proxy, proxy)).toThrow();
      expect(traps).toBe(0);
    } finally {
      types.isProxy = original;
    }
  });
  it.each(['property', 'symbol'] as const)(
    'refuses an own %s accessor without invoking its getter',
    (kind) => {
      let calls = 0;
      const value = Object.defineProperty({}, kind === 'symbol' ? Symbol('owned') : 'owned', {
        get: () => {
          calls++;
          return 1;
        },
      });
      expect(() => sameNativeData(value, value)).toThrow();
      expect(calls).toBe(0);
    },
  );
  it('refuses authored toJSON and iterator callables without invoking either', () => {
    let calls = 0;
    const json = {
      toJSON: () => {
        calls++;
        return {};
      },
    };
    const array = Object.defineProperty([1], Symbol.iterator, {
      value: () => {
        calls++;
        return [1][Symbol.iterator]();
      },
    });
    expect(() => sameNativeData(json, json)).toThrow();
    expect(() => sameNativeData(array, array)).toThrow();
    expect(calls).toBe(0);
  });
  it('refuses inherited authored prototypes without consulting their accessors', () => {
    let calls = 0;
    const value = Object.create({
      get owned() {
        calls++;
        return 1;
      },
    });
    expect(() => sameNativeData(value, value)).toThrow();
    expect(calls).toBe(0);
  });
  it.each([new Date(0), new Map(), new Set(), new Uint8Array([1]), /owned/u, () => 1])(
    'refuses unsupported exotic or callable data %j (case %#)',
    (value) => {
      expect(() => sameNativeData(value, value)).toThrow();
    },
  );
  it('bounds recursive depth rather than overflowing the native stack', () => {
    let left: unknown = null;
    let right: unknown = null;
    for (let index = 0; index < 100; index++) {
      left = { next: left };
      right = { next: right };
    }
    expect(() => sameNativeData(left, right)).toThrow();
  });
  it('bounds object-pair work even for shallow wide data', () => {
    const left = Array.from({ length: 10_001 }, (_, value) => ({ value }));
    const right = Array.from({ length: 10_001 }, (_, value) => ({ value }));
    expect(() => sameNativeData(left, right)).toThrow();
  });
  it('bounds total own-field comparisons for flat primitive records', () => {
    const left: Record<string, number> = {};
    const right: Record<string, number> = {};
    for (let index = 0; index < 50_001; index++) {
      left[`field${index}`] = index;
      right[`field${index}`] = index;
    }
    expect(Object.keys(left)).toHaveLength(50_001);
    expect(() => sameNativeData(left, right)).toThrow('NATIVE_COVERAGE_DATA_UNSUPPORTED');
  });
  it('refuses oversized holey arrays without walking their logical length', () => {
    const left = new Array(0xffff_ffff);
    const right = new Array(0xffff_ffff);
    expect(Object.keys(left)).toEqual([]);
    expect(() => sameNativeData(left, right)).toThrow('NATIVE_COVERAGE_DATA_UNSUPPORTED');
  });
});
