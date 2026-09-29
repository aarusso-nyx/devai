// ADR-MDL-0001: the one shared extractor for model-evaluated replies.
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
import { getValidator } from './index.js';

/** The consumer-specific reply contracts the extractor reads against. */
export type ReplySchemaName = 'review-verdict.schema.json' | 'triage-breaker.schema.json';

export type ReplyFinishReason = 'stop' | 'length' | 'tool_use' | 'error';

/** The part of a bridge response the extractor reads. */
export interface StructuredReply {
  readonly text: string;
  readonly json?: unknown;
  readonly finish_reason?: ReplyFinishReason;
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
 * Read one structured reply against its consumer schema (ADR-MDL-0001).
 */
export function extractStructuredReply(
  reply: StructuredReply,
  schema: ReplySchemaName,
): ReplyExtraction {
  const text = typeof reply.text === 'string' ? reply.text : '';
  const reply_sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const fail = (code: ReplyErrorCode, message: string, source = text, focus?: string) =>
    ({
      ok: false,
      error: { code, message, excerpt: excerptOf(source, focus), reply_sha256 },
    }) as const;

  const finish = reply.finish_reason ?? 'stop';
  if (finish === 'length') {
    return fail('reply_truncated', 'the provider stopped the reply at its output limit');
  }
  if (finish !== 'stop') {
    return fail(
      'reply_provider_error',
      `the provider finished the reply with ${finish}, not a completed turn`,
    );
  }

  const validate = getValidator(schema);
  if (reply.json !== undefined && reply.json !== null) {
    if (validate(reply.json)) {
      return { ok: true, document: reply.json as Record<string, unknown> };
    }
    let source: string;
    try {
      source = JSON.stringify(reply.json) ?? String(reply.json);
    } catch {
      source = String(reply.json);
    }
    return fail(
      'reply_invalid',
      `the provider json document fails ${schema}: ${describeErrors(validate.errors)}`,
      source,
    );
  }

  const found = candidates(text);
  if (found.length === 0) {
    return fail('reply_no_document', 'the reply holds no JSON document');
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
  if (!validate(only.parsed)) {
    return fail(
      'reply_invalid',
      `the reply document fails ${schema}: ${describeErrors(validate.errors)}`,
      text,
      only.raw,
    );
  }
  return { ok: true, document: only.parsed as Record<string, unknown> };
}
