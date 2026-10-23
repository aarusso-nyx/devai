import ts from 'typescript';

/** Callees that open a suite or a test. */
const TEST_CALLEES = new Set(['describe', 'it', 'test', 'suite']);
/** Chain members that change neither whether nor how a test runs. */
const NEUTRAL_MARKERS = new Set(['each', 'for', 'concurrent', 'sequential']);
/** `expect` members that start an assertion; asymmetric matchers such as `expect.any` do not. */
const ASSERTION_MEMBERS = new Set(['soft', 'poll']);

interface Scope {
  readonly titles: readonly string[];
  readonly markers: readonly string[];
}

/**
 * The title and run markers (`skip`, `only`, `todo`, `skipIf`, ...) of a describe/it/test call
 * that registers a test or suite, or undefined when the call is not one. A registration names a
 * title and a body, inline or referenced (`it('x', body)`), or is a todo. `it.skipIf(c)('title',
 * fn)` and `it.each(rows)('title', fn)` are judged at their outer call; their inner call takes a
 * single argument and registers nothing.
 */
function testCall(
  node: ts.CallExpression,
  source: ts.SourceFile,
): { readonly title: string; readonly markers: readonly string[] } | undefined {
  const markers: string[] = [];
  let callee: ts.Expression = node.expression;
  for (;;) {
    if (ts.isCallExpression(callee)) callee = callee.expression;
    else if (ts.isPropertyAccessExpression(callee)) {
      if (!NEUTRAL_MARKERS.has(callee.name.text)) markers.unshift(callee.name.text);
      callee = callee.expression;
    } else break;
  }
  if (!ts.isIdentifier(callee) || !TEST_CALLEES.has(callee.text)) return undefined;
  const registersBody = markers.includes('todo') || node.arguments.length >= 2;
  const [first] = node.arguments;
  if (!registersBody || first === undefined) return undefined;
  return { title: ts.isStringLiteralLike(first) ? first.text : first.getText(source), markers };
}

function startsAssertion(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'expect';
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'expect' &&
    ASSERTION_MEMBERS.has(callee.name.text)
  );
}

/** The whole assertion chain an `expect(...)` call starts: `expect(x).not.toBe(1)`. */
function assertionChain(start: ts.CallExpression): ts.Expression {
  let top: ts.Expression = start;
  for (;;) {
    const parent = top.parent;
    const extends_ =
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent) ||
        ts.isCallExpression(parent)) &&
      parent.expression === top;
    if (!extends_ && !ts.isNonNullExpression(parent)) return top;
    top = parent as ts.Expression;
  }
}

const printer = ts.createPrinter({ removeComments: true });

/**
 * The canonical text of an expression: printed without comments, then re-tokenized so layout,
 * spacing and trailing commas never change it. Words stay separated by one space.
 */
function canonicalText(node: ts.Node, source: ts.SourceFile): string {
  const printed = printer.printNode(
    ts.isStatement(node) ? ts.EmitHint.Unspecified : ts.EmitHint.Expression,
    node,
    source,
  );
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    printed,
  );
  const tokens: string[] = [];
  const nesting: ('template' | 'brace')[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.CloseBraceToken && nesting.at(-1) === 'template') {
      kind = scanner.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateTail) nesting.pop();
    } else if (kind === ts.SyntaxKind.CloseBraceToken) nesting.pop();
    else if (kind === ts.SyntaxKind.OpenBraceToken) nesting.push('brace');
    if (kind === ts.SyntaxKind.TemplateHead) nesting.push('template');
    tokens.push(scanner.getTokenText());
  }
  let text = '';
  tokens.forEach((token, index) => {
    if (token === ',' && [')', ']', '}'].includes(tokens[index + 1] ?? '')) return;
    if (/[\w$]$/u.test(text) && /^[\w$]/u.test(token)) text += ' ';
    text += token;
  });
  return text;
}

/** The assertion and registration identities of a test source, in source order. */
function identitiesOf(source: string): {
  readonly assertions: readonly string[];
  readonly registrations: readonly string[];
} {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const identities: string[] = [];
  const registrations: string[] = [];
  const walk = (node: ts.Node, scope: Scope): void => {
    if (ts.isCallExpression(node)) {
      const test = testCall(node, file);
      if (test !== undefined) {
        const inner = {
          titles: [...scope.titles, test.title],
          markers: [...scope.markers, ...test.markers],
        };
        registrations.push(`${inner.titles.join(' > ')} :: ${inner.markers.join(',')}`);
        walk(node.expression, scope);
        for (const argument of node.arguments) walk(argument, inner);
        return;
      }
      if (startsAssertion(node)) {
        const where = scope.titles.length === 0 ? '(file)' : scope.titles.join(' > ');
        identities.push(
          `${where} :: ${scope.markers.join(',')} :: ${canonicalText(assertionChain(node), file)}`,
        );
      }
    }
    ts.forEachChild(node, (child) => {
      walk(child, scope);
    });
  };
  walk(file, { titles: [], markers: [] });
  return { assertions: identities, registrations };
}

/**
 * Every `expect` assertion of a test source, in source order, by its identity: the describe/it
 * titles that hold it, the run markers on that chain, and its canonical text (ADR-GOV-0026).
 * An assertion outside any test is identified by the file alone. Identical assertions in one
 * test appear once each.
 */
export function assertionIdentities(source: string): readonly string[] {
  return identitiesOf(source).assertions;
}

/** The base identities the head no longer holds, each lost occurrence named once. */
function lost(base: readonly string[], head: readonly string[]): readonly string[] {
  const remaining = new Map<string, number>();
  for (const identity of head) remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  const changed: string[] = [];
  for (const identity of base) {
    const left = remaining.get(identity) ?? 0;
    if (left > 0) remaining.set(identity, left - 1);
    else changed.push(identity);
  }
  return changed;
}

/**
 * The base assertions the head no longer holds with the same identity: edited, removed, moved
 * to another test, or re-marked (skipped, focused, todo). Formatting, comments, reordering and
 * added assertions change nothing. Each lost occurrence is named once.
 */
export function changedAssertions(base: string, head: string): readonly string[] {
  return lost(assertionIdentities(base), assertionIdentities(head));
}

/**
 * The base test and suite registrations the head no longer holds with the same describe/it
 * chain and run markers: removed, renamed or re-marked tests, including those registered with a
 * referenced callback (`it('x', body)`), whose assertions live outside the registration and so
 * never carry its markers. Added registrations change nothing.
 */
export function changedTestRegistrations(base: string, head: string): readonly string[] {
  return lost(identitiesOf(base).registrations, identitiesOf(head).registrations);
}

/** A test or suite registration statement with an inline block body, split into key and body. */
function registrationBlock(
  statement: ts.Statement,
  source: ts.SourceFile,
): { readonly key: string; readonly body: readonly ts.Statement[] } | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return undefined;
  }
  const call = statement.expression;
  if (testCall(call, source) === undefined) return undefined;
  const body = [...call.arguments]
    .reverse()
    .find(
      (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
        (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
        ts.isBlock(argument.body),
    );
  if (body === undefined) return undefined;
  const key = [
    canonicalText(call.expression, source),
    ...call.arguments.filter((argument) => argument !== body).map((a) => canonicalText(a, source)),
    body.parameters.map((parameter) => canonicalText(parameter, source)).join(','),
    String(body.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false),
  ].join(' | ');
  return { key, body: (body.body as ts.Block).statements };
}

/**
 * The base statements the head does not preserve, in order. The head may insert statements
 * anywhere; every base statement must reappear, in order, with the same canonical text, except a
 * registration with an inline body, which must reappear with the same key and a body that in
 * turn preserves its own statements. An edit that only adds tests, imports or assertions keeps
 * the list empty, whatever assertion library the existing statements use.
 */
export function unpreservedStatements(base: string, head: string): readonly string[] {
  const baseFile = ts.createSourceFile('base.ts', base, ts.ScriptTarget.Latest, true);
  const headFile = ts.createSourceFile('head.ts', head, ts.ScriptTarget.Latest, true);
  const compare = (
    before: readonly ts.Statement[],
    after: readonly ts.Statement[],
  ): readonly string[] => {
    const lostStatements: string[] = [];
    let next = 0;
    for (const statement of before) {
      const registration = registrationBlock(statement, baseFile);
      const text = registration === undefined ? canonicalText(statement, baseFile) : undefined;
      let matched = -1;
      let nested: readonly string[] = [];
      for (let index = next; index < after.length && matched < 0; index += 1) {
        const candidate = after[index] as ts.Statement;
        if (registration === undefined) {
          if (canonicalText(candidate, headFile) === text) matched = index;
          continue;
        }
        const other = registrationBlock(candidate, headFile);
        if (other?.key === registration.key) {
          matched = index;
          nested = compare(registration.body, other.body);
        }
      }
      if (matched < 0) lostStatements.push(text ?? registration?.key ?? '');
      else {
        lostStatements.push(...nested);
        next = matched + 1;
      }
    }
    return lostStatements;
  };
  return compare(baseFile.statements, headFile.statements);
}
