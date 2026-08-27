/**
 * public-safe-v1 disclosure renderer.
 *
 * Every string that leaves the local canonical record for a public projection
 * passes through here. The profile is deny-by-default: it strips credential and
 * environment material, neutralizes anything GitHub would interpret as a
 * mention or as markup, and truncates to a bounded length. Tracked text is
 * rendered as inert prose and is never interpreted as an instruction.
 */

/** Field names whose values are withheld wholesale rather than pattern-matched. */
export const WITHHELD_FIELDS: readonly string[] = [
  'token',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'authorization',
  'private_key',
  'signing_key',
  'env',
  'environment',
  'prompt',
  'stdout',
  'stderr',
  'output',
];

const REDACTED = '[REDACTED]';
const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Credential and environment shapes. Ordered most specific first so that a
 * provider-recognizable token is labelled as such before the generic
 * high-entropy rule can claim it.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/gu,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/gu,
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)S?\s*[=:]\s*\S+/gu,
  /\b[0-9a-f]{40,}\b/gu,
];

/** Absolute host paths disclose the operator's filesystem layout. */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:\/Users|\/home|\/root|\/var\/folders|[A-Za-z]:\\Users)[^\s"']*/gu,
  /\.ssh\/[^\s"']*/gu,
  /\.npmrc\b/gu,
];

function stripControlCharacters(value: string): string {
  // Stripping control characters is the point of this function.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/gu, ' ');
}

function neutralizeMarkup(value: string): string {
  return (
    value
      // HTML, including comment markers that could hide directives from a reader.
      .replace(/<[^>\n]*>/gu, ' ')
      // Fences and inline code would let tracked text escape its quoting.
      .replace(/`+/gu, "'")
      // Link and image directives.
      .replace(/!\[|\]\(|\]\[/gu, ' ')
  );
}

/**
 * Defuse mentions and issue cross-references with a zero-width space so the
 * text still reads correctly but GitHub does not notify anyone, and a governed
 * round's projection cannot cross-link a foreign issue.
 */
function neutralizeMentions(value: string): string {
  return value.replace(/([@#])(?=[A-Za-z0-9_-])/gu, `$1${ZERO_WIDTH_SPACE}`);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export interface PublicSafeOptions {
  readonly maxChars: number;
}

/**
 * Render one caller-supplied string as a public-safe summary. Truncation is
 * explicit and marked, so a reader can never mistake a clipped summary for a
 * complete one.
 */
export function renderPublicSafe(value: string, options: PublicSafeOptions): string {
  let out = stripControlCharacters(value);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  for (const pattern of SENSITIVE_PATH_PATTERNS) out = out.replace(pattern, '[PATH]');
  out = collapseWhitespace(neutralizeMentions(neutralizeMarkup(out)));
  if (out.length === 0) out = REDACTED;
  if (out.length > options.maxChars) {
    const marker = ' [TRUNCATED]';
    out = `${out.slice(0, Math.max(1, options.maxChars - marker.length)).trimEnd()}${marker}`;
  }
  return out;
}

/**
 * True when a rendered string still carries material the profile forbids.
 * Used as a final self-check before a batch is queued: a renderer bug must
 * surface as a refusal, never as a disclosure.
 */
export function containsForbiddenContent(value: string): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source, 'u').test(value)) ||
    SENSITIVE_PATH_PATTERNS.some((pattern) => new RegExp(pattern.source, 'u').test(value))
  );
}
