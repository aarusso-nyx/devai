import { EXIT_USAGE } from '@devai-nyx/utils';

export type JsonRecord = Record<string, unknown>;

export function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value as T];
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usage(command: string, text: string): void {
  process.stderr.write(`devai ${command}: ${text}\n`);
  process.exitCode = EXIT_USAGE;
}

export function jsonRecord(value: unknown, diagnostic: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${diagnostic}: expected a JSON object`);
  }
  return value as JsonRecord;
}

export function parseJson(text: string, diagnostic: string): JsonRecord {
  return jsonRecord(JSON.parse(text) as unknown, diagnostic);
}
