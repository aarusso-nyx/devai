import { types } from 'node:util';

// Capture pure intrinsics before the adopter evaluates its configuration.
const proxy = types.isProxy;
const ownNames = Object.getOwnPropertyNames;
const ownSymbols = Object.getOwnPropertySymbols;
const descriptors = Object.getOwnPropertyDescriptors;
const prototype = Object.getPrototypeOf;
const same = Object.is;
const array = Array.isArray;
const ordinary = Object.prototype;
const arrayPrototype = Array.prototype;
const owns = Object.hasOwn;
const descriptor = Object.getOwnPropertyDescriptor;
const apply = Reflect.apply;
const define = Object.defineProperty;
const MapConstructor = Map;
const mapHas = Map.prototype.has;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const keys = (value: object): (string | symbol)[] => {
  const names = ownNames(value),
    symbols = ownSymbols(value);
  for (let index = 0; index < symbols.length; index += 1)
    define(names, names.length, {
      value: symbols[index],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  return names;
};
const refuse = (): never => {
  throw new Error('NATIVE_COVERAGE_DATA_UNSUPPORTED');
};

/** Pure Proxy detection: this operation never invokes a Proxy trap. */
export function isProxy(value: unknown): boolean {
  return proxy(value);
}

/** Compare finite own-data graphs without dispatching through caller code. */
export function sameNativeData(left: unknown, right: unknown): boolean {
  const forward = new MapConstructor<object, object>();
  const reverse = new MapConstructor<object, object>();
  let pairs = 0;
  let fields = 0;
  const compare = (a: unknown, b: unknown, depth: number): boolean => {
    if (proxy(a) || proxy(b)) return refuse();
    if (typeof a === 'function' || typeof b === 'function') return refuse();
    if (depth > 64) return refuse();
    const objectA = a !== null && typeof a === 'object';
    const objectB = b !== null && typeof b === 'object';
    if (!objectA || !objectB) return same(a, b);
    const first = a as object,
      second = b as object;
    const firstPrototype = prototype(first),
      secondPrototype = prototype(second);
    const isArrayA = array(first),
      isArrayB = array(second);
    if (
      (isArrayA && (descriptor(first, 'length')?.value as number) > 100_000) ||
      (isArrayB && (descriptor(second, 'length')?.value as number) > 100_000)
    )
      return refuse();
    if (
      (isArrayA
        ? firstPrototype !== arrayPrototype
        : firstPrototype !== ordinary && firstPrototype !== null) ||
      (isArrayB
        ? secondPrototype !== arrayPrototype
        : secondPrototype !== ordinary && secondPrototype !== null)
    )
      return refuse();
    if (firstPrototype !== secondPrototype || isArrayA !== isArrayB) return false;
    if (apply(mapHas, forward, [first]) || apply(mapHas, reverse, [second]))
      return (
        apply(mapGet, forward, [first]) === second && apply(mapGet, reverse, [second]) === first
      );
    if (++pairs > 10_000) return refuse();
    apply(mapSet, forward, [first, second]);
    apply(mapSet, reverse, [second, first]);
    const firstKeys = keys(first);
    const secondKeys = keys(second);
    fields += firstKeys.length + secondKeys.length;
    if (fields > 100_000) return refuse();
    const firstDescriptors = descriptors(first) as Record<PropertyKey, PropertyDescriptor>;
    const secondDescriptors = descriptors(second) as Record<PropertyKey, PropertyDescriptor>;
    for (let index = 0; index < firstKeys.length; index += 1)
      if (
        !owns(firstDescriptors[firstKeys[index] as string | symbol] as PropertyDescriptor, 'value')
      )
        return refuse();
    for (let index = 0; index < secondKeys.length; index += 1)
      if (
        !owns(
          secondDescriptors[secondKeys[index] as string | symbol] as PropertyDescriptor,
          'value',
        )
      )
        return refuse();
    if (firstKeys.length !== secondKeys.length) return false;
    for (let index = 0; index < firstKeys.length; index += 1) {
      const key = firstKeys[index] as string | symbol;
      if (!owns(secondDescriptors, key)) return false;
      const one = firstDescriptors[key],
        two = secondDescriptors[key];
      if (
        one === undefined ||
        two === undefined ||
        one.enumerable !== two.enumerable ||
        one.configurable !== two.configurable ||
        one.writable !== two.writable ||
        !compare(one.value, two.value, depth + 1)
      )
        return false;
    }
    return true;
  };
  return compare(left, right, 0);
}
