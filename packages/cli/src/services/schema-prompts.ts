/**
 * Schema-driven prompts (ADR-CFG-0001).
 *
 * A JSON schema property decides its own prompt: an `enum` or `const` becomes a
 * numbered selection that also accepts the literal value, a `pattern`,
 * `format`, `minLength`, `minimum`, or `maximum` becomes validated text, and a
 * `description` becomes the help shown with the prompt. An answer that violates
 * the schema is rejected at the prompt and the same prompt is asked again, so an
 * invalid value never reaches apply time.
 *
 * Prompts run on the platform `node:readline/promises` when a terminal is
 * attached and on an injected `PromptIo` otherwise. No terminal user-interface
 * dependency is used.
 */
import { createInterface } from 'node:readline/promises';

/** The two operations a prompt session needs: one answer per prompt, and status text. */
export interface PromptIo {
  readonly ask: (prompt: string) => Promise<string>;
  readonly print: (text: string) => void;
}

/** A readline-backed prompt session over the process terminal. */
export interface TerminalPromptIo extends PromptIo {
  readonly close: () => void;
}

/** The subset of JSON schema keywords that shape a prompt. */
export interface PromptSchema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly pattern?: string;
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
  readonly default?: unknown;
  readonly items?: PromptSchema;
  readonly uniqueItems?: boolean;
  readonly properties?: Readonly<Record<string, PromptSchema>>;
  readonly required?: readonly string[];
}

export interface SchemaPromptRequest {
  /** Dotted key shown in the prompt, for example `repo.kind`. */
  readonly key: string;
  readonly schema: PromptSchema;
  /** Answer used when the reply is empty; it must itself satisfy the schema. */
  readonly defaultValue?: unknown;
}

/** Whether both standard streams are terminals, the precondition for readline prompts. */
export function terminalAttached(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Open a readline prompt session on the process terminal. */
export function openTerminalPromptIo(): TerminalPromptIo {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (prompt) => readline.question(prompt),
    print: (text) => {
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    },
    close: () => {
      readline.close();
    },
  };
}

/** Resolve the property schema at a dotted path below an object schema. */
export function propertySchema(root: PromptSchema, path: string): PromptSchema {
  let cursor: PromptSchema | undefined = root;
  for (const segment of path.split('.')) {
    cursor = cursor?.properties?.[segment];
    if (cursor === undefined) throw new Error(`SCHEMA_PROMPT_PROPERTY_UNKNOWN: ${path}`);
  }
  return cursor;
}

function choicesOf(schema: PromptSchema): readonly unknown[] | undefined {
  if (schema.enum !== undefined) return schema.enum;
  if ('const' in schema) return [schema.const];
  return undefined;
}

function typeOf(schema: PromptSchema): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  return schema.type?.find((candidate) => candidate !== 'null');
}

function literal(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

type Checked =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function checkScalar(schema: PromptSchema, raw: string): Checked {
  const choices = choicesOf(schema);
  if (choices !== undefined) {
    const index = /^\d+$/u.test(raw) ? Number(raw) - 1 : -1;
    const byNumber = index >= 0 && index < choices.length ? choices[index] : undefined;
    const byValue = choices.find((choice) => literal(choice) === raw);
    const chosen = byValue ?? byNumber;
    if (chosen === undefined) {
      return {
        ok: false,
        reason: `expected one of ${choices.map(literal).join(', ')} (got '${raw}')`,
      };
    }
    return { ok: true, value: chosen };
  }
  const type = typeOf(schema);
  if (type === 'boolean') {
    if (/^(y|yes|true)$/iu.test(raw)) return { ok: true, value: true };
    if (/^(n|no|false)$/iu.test(raw)) return { ok: true, value: false };
    return { ok: false, reason: `expected yes or no (got '${raw}')` };
  }
  if (type === 'integer' || type === 'number') {
    const value = Number(raw);
    if (
      raw.trim() === '' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isInteger(value))
    ) {
      return {
        ok: false,
        reason: `expected ${type === 'integer' ? 'an integer' : 'a number'} (got '${raw}')`,
      };
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      return { ok: false, reason: `must be at least ${String(schema.minimum)} (got ${raw})` };
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return { ok: false, reason: `must be at most ${String(schema.maximum)} (got ${raw})` };
    }
    return { ok: true, value };
  }
  if (schema.minLength !== undefined && raw.length < schema.minLength) {
    return { ok: false, reason: `must be at least ${String(schema.minLength)} character(s) long` };
  }
  if (schema.maxLength !== undefined && raw.length > schema.maxLength) {
    return { ok: false, reason: `must be at most ${String(schema.maxLength)} character(s) long` };
  }
  if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(raw)) {
    return { ok: false, reason: `must match ${schema.pattern} (got '${raw}')` };
  }
  if (schema.format === 'date-time' && !DATE_TIME.test(raw)) {
    return { ok: false, reason: `must be an RFC 3339 date-time (got '${raw}')` };
  }
  return { ok: true, value: raw };
}

/** Check one raw answer against a property schema; arrays take comma-separated items. */
export function checkAnswer(schema: PromptSchema, raw: string): Checked {
  const answer = raw.trim();
  if (typeOf(schema) !== 'array') return checkScalar(schema, answer);
  const itemSchema = schema.items ?? {};
  const parts =
    answer === '' || answer === 'none'
      ? []
      : answer
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
  const values: unknown[] = [];
  for (const part of parts) {
    const checked = checkScalar(itemSchema, part);
    if (!checked.ok) return { ok: false, reason: `item '${part}': ${checked.reason}` };
    values.push(checked.value);
  }
  if (schema.uniqueItems === true && new Set(values.map(literal)).size !== values.length) {
    return { ok: false, reason: 'items must be unique' };
  }
  return { ok: true, value: values };
}

/** The help text and selection menu shown before a property prompt. */
export function describePrompt(request: SchemaPromptRequest): string {
  const { key, schema } = request;
  const lines: string[] = [];
  if (schema.description !== undefined) lines.push(`${key}: ${schema.description}`);
  const choices = choicesOf(typeOf(schema) === 'array' ? (schema.items ?? {}) : schema);
  if (choices !== undefined) {
    choices.forEach((choice, index) => {
      lines.push(`  ${String(index + 1)}) ${literal(choice)}`);
    });
  }
  return lines.join('\n');
}

function promptLine(request: SchemaPromptRequest): string {
  const { key, schema, defaultValue } = request;
  const array = typeOf(schema) === 'array';
  const choices = choicesOf(array ? (schema.items ?? {}) : schema);
  const shape = array
    ? choices !== undefined
      ? 'comma-separated numbers or values, or none'
      : 'comma-separated values, or none'
    : choices !== undefined
      ? `1-${String(choices.length)} or a value`
      : typeOf(schema) === 'boolean'
        ? 'yes/no'
        : 'text';
  const fallback = defaultValue === undefined ? '' : ` (default ${literal(defaultValue)})`;
  return `${key} [${shape}]${fallback}: `;
}

/**
 * Ask for one property until the answer satisfies its schema. A rejected answer
 * prints the schema constraint and asks the same prompt again.
 */
export async function promptForProperty(
  io: PromptIo,
  request: SchemaPromptRequest,
): Promise<unknown> {
  const help = describePrompt(request);
  if (help !== '') io.print(help);
  const line = promptLine(request);
  for (;;) {
    const raw = await io.ask(line);
    if (raw.trim() === '' && request.defaultValue !== undefined) return request.defaultValue;
    const checked = checkAnswer(request.schema, raw);
    if (checked.ok) return checked.value;
    io.print(`${request.key}: ${checked.reason}`);
  }
}

/** Ask a yes or no question that is not backed by a schema property. */
export async function promptYesNo(
  io: PromptIo,
  key: string,
  description: string,
): Promise<boolean> {
  return (await promptForProperty(io, {
    key,
    schema: { type: 'boolean', description },
  })) as boolean;
}
