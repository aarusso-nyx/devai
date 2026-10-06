// ADR-MDL-0003: the one shared extractor for model-evaluated replies.
//
// It validates a provider `json` field when one is present, and otherwise accepts
// exactly one unambiguous candidate document in the reply text, fenced or not. It
// returns a validated document or an error outcome carrying a bounded, redacted
// excerpt and the SHA-256 of the full reply text; it never returns a partially
// parsed document and never guesses between candidates. It lives beside
// getValidator so the judge sensor, the triage tie-breaker, and the model bridge
// share it without an upward package edge.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ErrorObject } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { getValidator, loadSchema } from './index.js';

/** The consumer-specific reply contracts the extractor reads against. */
export type ReplySchemaName =
  'review-verdict.schema.json' | 'triage-breaker.schema.json' | 'soft-gate-score.schema.json';

export type ReplyFinishReason = 'stop' | 'length' | 'tool_use' | 'error';

/** The part of a bridge response the extractor reads. */
export interface StructuredReply {
  readonly text: string;
  readonly json?: unknown;
  readonly finish_reason?: ReplyFinishReason;
  /** Exact strict request identity; raw replies validate before optional-null removal. */
  readonly projection?: {
    readonly version: typeof REPLY_PROJECTION_VERSION;
    readonly schema: ReplySchemaName;
    readonly schema_sha256: string;
  };
}

export type ReplyErrorCode =
  | 'reply_provider_error'
  | 'reply_truncated'
  | 'reply_invalid'
  | 'reply_ambiguous'
  | 'reply_no_document';

export interface ReplyExtractionError {
  readonly code: ReplyErrorCode;
  readonly message: string;
  /** Bounded (REPLY_EXCERPT_MAX_CHARS) and redacted excerpt of the reply. */
  readonly excerpt: string;
  /** SHA-256 (hex) of the full, unredacted reply text. */
  readonly reply_sha256: string;
}

export type ReplyExtraction =
  | { readonly ok: true; readonly document: Record<string, unknown> }
  | { readonly ok: false; readonly error: ReplyExtractionError };

/** The declared bound on a reply excerpt kept as a diagnostic. */
export const REPLY_EXCERPT_MAX_CHARS = 1024;

const REDACTED = '[REDACTED]';

/** Credential shapes withheld from an excerpt, most specific first. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/gu,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/gu,
  /\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key(?:[_-]?id)?|credential)s?\s*[=:]\s*[^\s"',;]+/giu,
];

function redact(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

function excerptOf(source: string, focus?: string): string {
  const redacted = redact(source);
  let start = 0;
  if (focus !== undefined) {
    const probe = redact(focus).slice(0, 64);
    const at = probe.length > 0 ? redacted.indexOf(probe) : -1;
    if (at >= 0) start = Math.max(0, at - 64);
  }
  return redacted.slice(start, start + REPLY_EXCERPT_MAX_CHARS);
}

interface Candidate {
  readonly raw: string;
  readonly parsed?: unknown;
  readonly parses: boolean;
}

/**
 * Top-level brace groups of the text. A group is balanced with JSON string
 * awareness, so braces inside string values and nested objects never count as
 * extra candidates. A group that never closes is kept as an unparsed candidate.
 */
function candidates(text: string): Candidate[] {
  const found: Candidate[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let close = -1;
    for (let cursor = open; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          close = cursor;
          break;
        }
      }
    }
    const raw = close < 0 ? text.slice(open) : text.slice(open, close + 1);
    let parsed: unknown;
    let parses = false;
    if (close >= 0) {
      try {
        parsed = JSON.parse(raw) as unknown;
        parses = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      } catch {
        parses = false;
      }
    }
    // Prose braces such as `{x}` are not document attempts; a group that opens
    // like a JSON member (`{"`) and fails to parse is a malformed candidate.
    if (!parses && !/^\{\s*(?:"|\}|$)/u.test(raw)) {
      index = open + 1;
      continue;
    }
    found.push(parses ? { raw, parsed, parses } : { raw, parses });
    if (close < 0) break;
    index = close + 1;
  }
  return found;
}

function describeErrors(errors: readonly ErrorObject[] | null | undefined): string {
  const parts = (errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`);
  return parts.length === 0 ? 'document failed schema validation' : parts.join('; ');
}

/**
 * The one reply digest every recording stores and every replay recomputes (ADR-MDL-0003):
 * lowercase hexadecimal SHA-256 of the UTF-8 reply bytes the bridge selected, before
 * normalization or redaction. For a Claude envelope whose `structured_output` supplies the
 * verdict those bytes are `JSON.stringify(structured_output)` with no newline, never the
 * envelope's `result` string; for a text reply they are that text exactly.
 */
export function replySha256(reply: Pick<StructuredReply, 'text'>): string {
  const text = typeof reply.text === 'string' ? reply.text : '';
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Read one structured reply against its consumer schema (ADR-MDL-0001).
 */
export function extractStructuredReply(
  reply: StructuredReply,
  schema: ReplySchemaName,
): ReplyExtraction {
  const text = typeof reply.text === 'string' ? reply.text : '';
  const reply_sha256 = replySha256(reply);
  const fail = (code: ReplyErrorCode, message: string, source = text, focus?: string) =>
    ({
      ok: false,
      error: { code, message, excerpt: excerptOf(source, focus), reply_sha256 },
    }) as const;

  const finish = reply.finish_reason;
  if (finish === 'length') {
    return fail('reply_truncated', 'the provider stopped the reply at its output limit');
  }
  if (finish !== 'stop') {
    return fail(
      'reply_provider_error',
      `the provider has no affirmative completed turn (${String(finish)})`,
    );
  }

  const validate = getValidator(schema);
  const supplied = reply.json !== undefined && reply.json !== null;
  // An invalid provider object never falls back to apparently valid text.
  if (supplied && reply.projection === undefined && !validate(reply.json)) {
    return fail(
      'reply_invalid',
      `the provider json document fails ${schema}: ${describeErrors(validate.errors)}`,
    );
  }
  const found = candidates(text);
  if (found.length === 0) {
    return fail(
      supplied ? 'reply_invalid' : 'reply_no_document',
      'the selected reply holds no JSON document',
    );
  }
  const parsed = found.filter((candidate) => candidate.parses);
  const distinct: Candidate[] = [];
  for (const candidate of parsed) {
    if (!distinct.some((seen) => isDeepStrictEqual(seen.parsed, candidate.parsed))) {
      distinct.push(candidate);
    }
  }
  if (distinct.length > 1 || (distinct.length === 1 && found.length > parsed.length)) {
    return fail(
      'reply_ambiguous',
      `the reply holds ${String(found.length)} candidate documents; the extractor never guesses between them`,
    );
  }
  const only = distinct[0];
  if (only === undefined) {
    const first = found[0];
    return fail(
      'reply_invalid',
      'the reply candidate is not a well-formed JSON object',
      text,
      first?.raw,
    );
  }
  if (supplied && !isDeepStrictEqual(reply.json, only.parsed)) {
    return fail(
      'reply_invalid',
      'the provider json document disagrees with the selected reply text',
    );
  }
  let document = only.parsed;
  if (reply.projection !== undefined) {
    const projection = reply.projection;
    if (projection === null || typeof projection !== 'object' || Array.isArray(projection)) {
      return fail('reply_invalid', 'the strict reply projection must be an exact identity object');
    }
    const expected = providerReplySchema(schema, true);
    const identity = replyProjectionIdentity(schema);
    if (
      projection.version !== identity.version ||
      projection.schema !== schema ||
      projection.schema_sha256 !== identity.schema_sha256 ||
      Object.keys(projection).sort().join(',') !== 'schema,schema_sha256,version'
    ) {
      return fail(
        'reply_invalid',
        'the strict reply projection identity does not match the consumer schema',
      );
    }
    const projected = new Ajv2020({ strict: false, allErrors: true }).compile(expected);
    if (!projected(document)) {
      return fail(
        'reply_invalid',
        `the raw reply fails its strict projection: ${describeErrors(projected.errors)}`,
      );
    }
    document = structuredClone(document) as Record<string, unknown>;
    if (schema === 'review-verdict.schema.json') {
      const review = document as Record<string, unknown>;
      if (review['findings'] === null) delete review['findings'];
      else if (Array.isArray(review['findings'])) {
        for (const finding of review['findings'] as Record<string, unknown>[]) {
          if (finding['file'] === null) delete finding['file'];
          if (finding['line'] === null) delete finding['line'];
        }
      }
    }
  }
  if (!validate(document)) {
    return fail(
      'reply_invalid',
      `the reply document fails ${schema}: ${describeErrors(validate.errors)}`,
      text,
      only.raw,
    );
  }
  return { ok: true, document: document as Record<string, unknown> };
}

/** The version of the provider schema projection below; part of a strict reply's identity. */
export const REPLY_PROJECTION_VERSION = 'strict-reply-v2';

/** The optional positions a strict projection may turn into required-and-nullable members. */
const NULLABLE_POSITIONS: Readonly<Partial<Record<ReplySchemaName, readonly string[]>>> = {
  'review-verdict.schema.json': [
    '/properties/findings',
    '/$defs/finding/properties/file',
    '/$defs/finding/properties/line',
  ],
};

/**
 * Consumers whose string length bounds a strict projection restates as an equivalent
 * `pattern`: OpenAI strict structured outputs, which `codex exec --output-schema` uses,
 * admit `pattern` but not `minLength`/`maxLength`. The soft-gate score keeps its bounds
 * because its strings already carry a pattern that one regular expression cannot join.
 */
const LENGTH_AS_PATTERN: readonly ReplySchemaName[] = [
  'review-verdict.schema.json',
  'triage-breaker.schema.json',
];

/**
 * The consumer schema as a provider receives it (ADR-MDL-0003): the governed document
 * without its identity and documentation-only members, which structured-output hosts do
 * not read. The strict projection, for OpenAI strict mode and `codex exec
 * --output-schema`, also lists every property in `required`, makes the declared optional
 * positions nullable instead of absent, types string enums explicitly, and restates a
 * string length bound as the equivalent code-point pattern. It never changes what a
 * document means: a reply that passes the projection still has its declared nulls removed
 * and is validated against the canonical schema.
 */
export function providerReplySchema(
  name: ReplySchemaName,
  strict: boolean,
): Record<string, unknown> {
  const nullable = NULLABLE_POSITIONS[name] ?? [];
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value))
      return value.map((member, index) => visit(member, `${path}/${index}`));
    if (value === null || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>;
    const out = Object.fromEntries(
      Object.entries(node)
        .filter(
          ([key]) => !['$schema', '$id', 'schema_version', 'examples', 'default'].includes(key),
        )
        .map(([key, member]) => [key, visit(member, `${path}/${key}`)]),
    );
    if (!strict) return out;
    if (node['type'] === 'object') {
      if (
        node['additionalProperties'] !== false ||
        !node['properties'] ||
        !Array.isArray(node['required'])
      ) {
        throw new Error('MODEL_BRIDGE_SCHEMA_UNSUPPORTED');
      }
      const properties = out['properties'] as Record<string, unknown>;
      for (const key of Object.keys(properties)) {
        if ((node['required'] as string[]).includes(key)) continue;
        if (!nullable.includes(`${path}/properties/${key}`))
          throw new Error('MODEL_BRIDGE_SCHEMA_UNSUPPORTED');
        properties[key] = { anyOf: [properties[key], { type: 'null' }] };
      }
      out['required'] = Object.keys(properties);
    }
    if (
      node['type'] === undefined &&
      Array.isArray(node['enum']) &&
      node['enum'].every((member) => typeof member === 'string')
    ) {
      out['type'] = 'string';
    }
    if (
      LENGTH_AS_PATTERN.includes(name) &&
      node['type'] === 'string' &&
      (node['minLength'] !== undefined || node['maxLength'] !== undefined)
    ) {
      if (node['pattern'] !== undefined) throw new Error('MODEL_BRIDGE_SCHEMA_UNSUPPORTED');
      const min = (node['minLength'] ?? 0) as number;
      const max = node['maxLength'] as number | undefined;
      if (!Number.isSafeInteger(min) || (max !== undefined && !Number.isSafeInteger(max)))
        throw new Error('MODEL_BRIDGE_SCHEMA_UNSUPPORTED');
      delete out['minLength'];
      delete out['maxLength'];
      out['pattern'] = `^[\\s\\S]{${String(min)},${max === undefined ? '' : String(max)}}$`;
    }
    return out;
  };
  return visit(loadSchema(name), '') as Record<string, unknown>;
}

/** The identity a strict reply carries: the projection version, schema name and digest. */
export function replyProjectionIdentity(
  name: ReplySchemaName,
): NonNullable<StructuredReply['projection']> {
  return {
    version: REPLY_PROJECTION_VERSION,
    schema: name,
    schema_sha256: createHash('sha256')
      .update(JSON.stringify(providerReplySchema(name, true)), 'utf8')
      .digest('hex'),
  };
}
