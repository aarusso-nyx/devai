import { createHash } from 'node:crypto';

export function canonicalize(value: unknown, path = '$'): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`CHECK_RUNNER_CANONICAL: ${path} is not finite`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalize(entry, `${path}[${String(index)}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`CHECK_RUNNER_CANONICAL: ${path} is not a plain object`);
    }
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`)
      .join(',')}}`;
  }
  throw new Error(`CHECK_RUNNER_CANONICAL: ${path} is not JSON`);
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : canonicalBytes(value))
    .digest('hex');
}
