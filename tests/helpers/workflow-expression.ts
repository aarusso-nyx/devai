// A small evaluator for the GitHub Actions expression language, enough to read the `if`,
// `concurrency`, and `env` values of a committed workflow under a chosen event context.
// It follows the documented semantics: `&&` and `||` return an operand, `==` compares loosely
// and compares strings case-insensitively, a missing property reads null, and an
// interpolated value renders null as ''. Unsupported syntax throws, so a test never passes
// on a value the evaluator silently misread.

export type ExpressionValue =
  | null
  | boolean
  | number
  | string
  | readonly ExpressionValue[]
  | { readonly [key: string]: ExpressionValue };

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'identifier'; readonly value: string }
  | { readonly kind: 'operator'; readonly value: string };

const OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '!', '(', ')', '[', ']', '.', ','];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'") {
      let value = '';
      index += 1;
      for (;;) {
        if (index >= source.length) throw new Error(`unterminated string in: ${source}`);
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += source[index];
        index += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    const number = /^(?:0x[0-9a-f]+|\d+(?:\.\d+)?)/iu.exec(source.slice(index));
    if (number !== null && /\d/u.test(char)) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*/u.exec(source.slice(index));
    if (identifier !== null) {
      tokens.push({ kind: 'identifier', value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator === undefined) throw new Error(`unsupported character ${char} in: ${source}`);
    tokens.push({ kind: 'operator', value: operator });
    index += operator.length;
  }
  return tokens;
}

export function truthy(value: ExpressionValue): boolean {
  if (value === null || value === false || value === 0 || value === '') return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  return true;
}

function toNumber(value: ExpressionValue): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value);
  return Number.NaN;
}

function looseEqual(left: ExpressionValue, right: ExpressionValue): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase();
  }
  if (typeof left === typeof right && (typeof left !== 'object' || left === null)) {
    return left === right;
  }
  if (typeof left === 'object' && left !== null) return left === right;
  if (typeof right === 'object' && right !== null) return false;
  return toNumber(left) === toNumber(right);
}

export function render(value: ExpressionValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function call(name: string, args: readonly ExpressionValue[]): ExpressionValue {
  switch (name.toLowerCase()) {
    case 'format': {
      const [template, ...rest] = args;
      return render(template ?? null).replace(/\{(\d+)\}/gu, (_match, digits: string) =>
        render(rest[Number(digits)] ?? null),
      );
    }
    case 'contains': {
      const [haystack, needle] = args;
      if (Array.isArray(haystack)) return haystack.some((item) => looseEqual(item, needle ?? null));
      return render(haystack ?? null)
        .toLowerCase()
        .includes(render(needle ?? null).toLowerCase());
    }
    case 'startswith':
      return render(args[0] ?? null)
        .toLowerCase()
        .startsWith(render(args[1] ?? null).toLowerCase());
    case 'endswith':
      return render(args[0] ?? null)
        .toLowerCase()
        .endsWith(render(args[1] ?? null).toLowerCase());
    default:
      throw new Error(`unsupported function ${name}`);
  }
}

class Parser {
  private index = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly context: Record<string, ExpressionValue>,
    private readonly source: string,
  ) {}

  parse(): ExpressionValue {
    const value = this.or();
    if (this.index !== this.tokens.length) throw new Error(`trailing tokens in: ${this.source}`);
    return value;
  }

  private peek(value: string): boolean {
    const token = this.tokens[this.index];
    return token?.kind === 'operator' && token.value === value;
  }

  private expect(value: string): void {
    if (!this.peek(value)) throw new Error(`expected ${value} in: ${this.source}`);
    this.index += 1;
  }

  private or(): ExpressionValue {
    let left = this.and();
    while (this.peek('||')) {
      this.index += 1;
      const right = this.and();
      left = truthy(left) ? left : right;
    }
    return left;
  }

  private and(): ExpressionValue {
    let left = this.equality();
    while (this.peek('&&')) {
      this.index += 1;
      const right = this.equality();
      left = truthy(left) ? right : left;
    }
    return left;
  }

  private equality(): ExpressionValue {
    let left = this.comparison();
    for (;;) {
      if (this.peek('==') || this.peek('!=')) {
        const negate = this.peek('!=');
        this.index += 1;
        const equal = looseEqual(left, this.comparison());
        left = negate ? !equal : equal;
        continue;
      }
      return left;
    }
  }

  private comparison(): ExpressionValue {
    let left = this.unary();
    for (;;) {
      const operator = ['<=', '>=', '<', '>'].find((candidate) => this.peek(candidate));
      if (operator === undefined) return left;
      this.index += 1;
      const a = toNumber(left);
      const b = toNumber(this.unary());
      left =
        operator === '<' ? a < b : operator === '>' ? a > b : operator === '<=' ? a <= b : a >= b;
    }
  }

  private unary(): ExpressionValue {
    if (this.peek('!')) {
      this.index += 1;
      return !truthy(this.unary());
    }
    return this.postfix();
  }

  private postfix(): ExpressionValue {
    let value = this.primary();
    for (;;) {
      if (this.peek('.')) {
        this.index += 1;
        const token = this.tokens[this.index];
        if (token?.kind !== 'identifier') throw new Error(`expected a property in: ${this.source}`);
        this.index += 1;
        value = property(value, token.value);
        continue;
      }
      if (this.peek('[')) {
        this.index += 1;
        const key = this.or();
        this.expect(']');
        value = property(value, render(key));
        continue;
      }
      return value;
    }
  }

  private primary(): ExpressionValue {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error(`unexpected end of: ${this.source}`);
    this.index += 1;
    if (token.kind === 'number' || token.kind === 'string') return token.value;
    if (token.kind === 'operator') {
      if (token.value !== '(') throw new Error(`unexpected ${token.value} in: ${this.source}`);
      const value = this.or();
      this.expect(')');
      return value;
    }
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    if (this.peek('(')) {
      this.index += 1;
      const args: ExpressionValue[] = [];
      if (!this.peek(')')) {
        args.push(this.or());
        while (this.peek(',')) {
          this.index += 1;
          args.push(this.or());
        }
      }
      this.expect(')');
      return call(token.value, args);
    }
    if (!(token.value in this.context)) {
      throw new Error(`unknown context ${token.value} in: ${this.source}`);
    }
    return this.context[token.value] ?? null;
  }
}

function property(value: ExpressionValue, key: string): ExpressionValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, ExpressionValue>;
  const match = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return match === undefined ? null : (record[match] ?? null);
}

/** Evaluates one bare expression, with or without its `${{ }}` wrapper. */
export function evaluate(
  expression: string,
  context: Record<string, ExpressionValue>,
): ExpressionValue {
  const trimmed = expression.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/u.exec(trimmed);
  const source = wrapped !== null && !wrapped[1]?.includes('}}') ? (wrapped[1] ?? '') : trimmed;
  return new Parser(tokenize(source), context, source).parse();
}

/** Renders a value that may interpolate `${{ }}` expressions into literal text. */
export function interpolate(text: string, context: Record<string, ExpressionValue>): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_match, source: string) =>
    render(new Parser(tokenize(source), context, source).parse()),
  );
}

/** Reads a workflow value (`if:` or a boolean-like field) as a condition. */
export function condition(value: unknown, context: Record<string, ExpressionValue>): boolean {
  if (value === undefined) return true;
  if (typeof value === 'boolean') return value;
  return truthy(evaluate(String(value), context));
}
