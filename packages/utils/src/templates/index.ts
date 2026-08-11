/**
 * Phase 18.C: deterministic template engine for the scaffolder family
 * Consumed by deterministic scaffold operations; renders
 * token-bearing template files into concrete output by substituting
 * a fixed token set + evaluating simple conditional blocks.
 *
 * Deterministic by construction. NO LLM. NO regex eval. NO shell-out.
 * Same blueprint + same template = byte-identical output. This is the
 * load-bearing safety property of D-59's locked decision #1
 * ("scaffolders are deterministic").
 *
 * Token set (locked at 18.C to codex's exact list per SCAFFOLDER_DESIGN.md):
 *   __NAMESPACE__        — kebab namespace (e.g. "demo")
 *   __MODULE__           — PascalCase module name (e.g. "Greeter")
 *   __kebabModule__      — kebab-case module name (e.g. "greeter")
 *   __snake_module__     — snake_case module name (e.g. "greeter")
 *   __moduleSlug__       — "<namespace>-<kebab-module>" (e.g. "demo-greeter")
 *   __ENTITY__           — PascalCase entity (e.g. "Greeting")
 *   __classEntity__      — alias of __ENTITY__ for codex compat
 *   __kebabEntity__      — kebab entity (e.g. "greeting")
 *   __snake_entity__     — snake entity (e.g. "greeting")
 *   __snake_table__      — "<namespace>__<snake-module>_<snake-entity>"
 *   __SPEC_VERSION__     — blueprint.module.version (semver)
 *   __SPEC_SHA__         — canonical-JSON sha256 head8 of the blueprint
 *
 * Conditional blocks:
 *   <!-- IF:<flag> -->...<!-- ENDIF:<flag> -->
 *   Pure boolean inclusion; nested blocks supported.
 *   Flag truthiness comes from `flags: Record<string, boolean>`.
 *
 * Per Constitution Article 25 (no surprising substrate); per D-59.
 */

import { createHash } from 'node:crypto';

export interface TokenMap {
  readonly __NAMESPACE__: string;
  readonly __MODULE__: string;
  readonly __kebabModule__: string;
  readonly __snake_module__: string;
  readonly __moduleSlug__: string;
  readonly __ENTITY__: string;
  readonly __classEntity__: string;
  readonly __kebabEntity__: string;
  readonly __snake_entity__: string;
  readonly __snake_table__: string;
  readonly __SPEC_VERSION__: string;
  readonly __SPEC_SHA__: string;
  /**
   * Open extension slot: per-template callers may include additional
   * named tokens (e.g. `__FOO__`) without modifying the engine. The
   * canonical 12 above are the contract; everything else is opaque
   * pass-through.
   */
  readonly [extra: string]: string;
}

/**
 * Validate that a key looks like a token (starts and ends with
 * double-underscore, only [A-Za-z0-9_] inside). Rejecting weird
 * keys protects callers from silently passing a misnamed token
 * that the engine then can't substitute.
 */
function isCanonicalToken(key: string): boolean {
  return /^__[A-Za-z][A-Za-z0-9_]*__$/.test(key);
}

/** PascalCase / camelCase → kebab-case. Leaves all-lowercase input alone. */
export function toKebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/** PascalCase / camelCase / kebab → snake_case. */
export function toSnake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

export interface BuildTokensInput {
  readonly namespace: string;
  readonly module: string;
  readonly entity: string;
  readonly specVersion: string;
  readonly specSha256: string;
  readonly extra?: Readonly<Record<string, string>>;
}

export function buildTokens(input: BuildTokensInput): TokenMap {
  const ns = input.namespace.trim();
  const mod = input.module.trim();
  const ent = input.entity.trim();
  const kebabModule = toKebab(mod);
  const snakeModule = toSnake(mod);
  const kebabEntity = toKebab(ent);
  const snakeEntity = toSnake(ent);
  const specSha = input.specSha256.trim();
  const tokens: TokenMap = {
    __NAMESPACE__: ns,
    __MODULE__: mod,
    __kebabModule__: kebabModule,
    __snake_module__: snakeModule,
    __moduleSlug__: `${ns}-${kebabModule}`,
    __ENTITY__: ent,
    __classEntity__: ent,
    __kebabEntity__: kebabEntity,
    __snake_entity__: snakeEntity,
    __snake_table__: `${ns}__${snakeModule}_${snakeEntity}`,
    __SPEC_VERSION__: input.specVersion.trim(),
    __SPEC_SHA__: specSha.length >= 8 ? specSha.slice(0, 8) : specSha,
    ...(input.extra ?? {}),
  };
  // Validate any caller-supplied extras conform to the token convention.
  // Misnamed extras would silently fail substitution otherwise.
  for (const key of Object.keys(input.extra ?? {})) {
    if (!isCanonicalToken(key)) {
      throw new Error(
        `buildTokens: extra token name '${key}' does not match the canonical __NAME__ pattern`,
      );
    }
  }
  return tokens;
}

const IF_OPEN = /<!--\s*IF:([A-Za-z][A-Za-z0-9_]*)\s*-->/;
const IF_CLOSE = /<!--\s*ENDIF:([A-Za-z][A-Za-z0-9_]*)\s*-->/;

interface ConditionalNode {
  readonly kind: 'text' | 'block';
  readonly content?: string;
  readonly flag?: string;
  readonly children?: ConditionalNode[];
}

/**
 * Parse a template body into an alternating list of text + conditional
 * blocks. Throws on malformed input (unbalanced IF/ENDIF, unmatched
 * flag names). Callers should let parse errors propagate — the
 * scaffolder skill turns them into status:'fail' with the error in notes.
 */
function parseConditionals(body: string): ConditionalNode[] {
  const result: ConditionalNode[] = [];
  // Recursive descent — find the first IF, recurse on its body, then
  // continue on the remainder.
  let cursor = 0;
  while (cursor < body.length) {
    const remaining = body.slice(cursor);
    const openMatch = IF_OPEN.exec(remaining);
    if (openMatch === null) {
      if (cursor < body.length) result.push({ kind: 'text', content: body.slice(cursor) });
      break;
    }
    const flag = openMatch[1];
    if (flag === undefined) {
      throw new Error('parseConditionals: IF block missing flag name');
    }
    // Emit any leading text before the IF.
    if (openMatch.index > 0) {
      result.push({ kind: 'text', content: remaining.slice(0, openMatch.index) });
    }
    // Locate the *matching* ENDIF (skipping any nested same-flag pairs).
    const after = cursor + openMatch.index + openMatch[0].length;
    const matchedEnd = findMatchingEnd(body, after, flag);
    if (matchedEnd === -1) {
      throw new Error(`parseConditionals: unmatched <!-- IF:${flag} --> (no closing ENDIF)`);
    }
    const inner = body.slice(after, matchedEnd);
    result.push({ kind: 'block', flag, children: parseConditionals(inner) });
    cursor = matchedEnd + `<!-- ENDIF:${flag} -->`.length;
    // The end token may include extra whitespace; advance past whichever
    // ENDIF form actually matched.
    const endTail = IF_CLOSE.exec(body.slice(matchedEnd));
    if (endTail !== null && endTail.index === 0) {
      cursor = matchedEnd + endTail[0].length;
    }
  }
  return result;
}

function findMatchingEnd(body: string, fromIndex: number, flag: string): number {
  // Scan forward from fromIndex, counting nesting depth for the same flag.
  let depth = 1;
  let searchFrom = fromIndex;
  while (searchFrom < body.length) {
    const remaining = body.slice(searchFrom);
    const open = IF_OPEN.exec(remaining);
    const close = IF_CLOSE.exec(remaining);
    if (close === null) return -1;
    const openAt = open === null ? Infinity : searchFrom + open.index;
    const closeAt = searchFrom + close.index;
    if (openAt < closeAt) {
      const openedFlag = open?.[1];
      // Only count if it's the same flag we're tracking — different
      // flags don't nest (they're balanced independently).
      if (openedFlag === flag) depth += 1;
      searchFrom = openAt + (open?.[0].length ?? 0);
      continue;
    }
    const closedFlag = close[1];
    if (closedFlag === flag) {
      depth -= 1;
      if (depth === 0) return closeAt;
    }
    searchFrom = closeAt + close[0].length;
  }
  return -1;
}

function evalNodes(
  nodes: readonly ConditionalNode[],
  flags: Readonly<Record<string, boolean>>,
): string {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'text' && node.content !== undefined) {
      out.push(node.content);
    } else if (node.kind === 'block' && node.flag !== undefined) {
      const truthy = flags[node.flag] === true;
      if (truthy && node.children !== undefined) out.push(evalNodes(node.children, flags));
    }
  }
  return out.join('');
}

function substituteTokens(body: string, tokens: TokenMap): string {
  let out = body;
  // Iterate by token key (not regex over arbitrary `__\w+__`) so we
  // never substitute partial matches and so unknown tokens are
  // intentionally left in place.
  for (const [key, value] of Object.entries(tokens)) {
    if (!isCanonicalToken(key)) continue;
    // Split + join is cheaper than RegExp for short bodies and avoids
    // regex-metachar escaping concerns entirely.
    out = out.split(key).join(value);
  }
  return out;
}

export interface RenderInput {
  /** Raw template body (file content). */
  readonly body: string;
  /** Token map; build via buildTokens(). */
  readonly tokens: TokenMap;
  /** Flag map for conditional blocks; missing keys default to false. */
  readonly flags?: Readonly<Record<string, boolean>>;
}

export interface RenderResult {
  /** Rendered body. */
  readonly output: string;
  /** SHA-256 of the rendered body, hex-encoded (64 chars). */
  readonly sha256: string;
}

/**
 * Render a template body. Deterministic; same input = same output.
 *
 * Order of operations:
 *   1. Parse conditional blocks (IF/ENDIF). Throws on malformed input.
 *   2. Evaluate conditionals against the flag map (default-false).
 *   3. Substitute tokens in the resulting body.
 *   4. Compute sha256 of the final output.
 */
export function renderTemplate(input: RenderInput): RenderResult {
  const flags = input.flags ?? {};
  const nodes = parseConditionals(input.body);
  const flattened = evalNodes(nodes, flags);
  const output = substituteTokens(flattened, input.tokens);
  const sha256 = createHash('sha256').update(output, 'utf8').digest('hex');
  return { output, sha256 };
}
