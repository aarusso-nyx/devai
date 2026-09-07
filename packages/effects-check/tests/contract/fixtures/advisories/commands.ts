declare const moduleName: string, target: (...args: unknown[]) => unknown;
declare function ordinary(value: string): void;
class Ordinary {
  value = 1;
}
const other = { apply(_target: unknown) {} };

// Parsed only; no evaluation, loading, or reflective invocation occurs in the test.
export function advisoryExamples() {
  void import(moduleName);
  eval('void 0');
  new Function('return 1');
  Reflect.apply(target, undefined, []);
  Reflect.construct(Ordinary, []);
  void import('node:fs');
  ordinary('literal');
  new Ordinary();
  other.apply(target);
}
