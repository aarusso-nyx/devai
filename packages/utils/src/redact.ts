const REDACTED = '[REDACTED]';

export interface RedactionPolicy {
  readonly patterns: readonly RegExp[];
  readonly fields: readonly string[];
}

export function redact(value: unknown, policy: RedactionPolicy): unknown {
  return redactValue(value, policy);
}

function redactValue(value: unknown, policy: RedactionPolicy): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, policy);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, policy));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = policy.fields.includes(key) ? REDACTED : redactValue(v, policy);
    }
    return out;
  }
  return value;
}

function redactString(s: string, policy: RedactionPolicy): string {
  let out = s;
  for (const pattern of policy.patterns) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}
