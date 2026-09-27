export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function expectSuccess<T>(result: unknown): T {
  if (!isRecord(result) || result.ok !== true || !Object.hasOwn(result, 'value')) {
    const code = isRecord(result) && typeof result.code === 'string' ? result.code : 'UNKNOWN';
    throw new Error(code);
  }
  return result.value as T;
}
