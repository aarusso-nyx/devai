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
 * that registers a body, or undefined when the call is not one. `it.skipIf(c)('title', fn)` and
 * `it.each(rows)('title', fn)` are judged at their outer call.
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
  const registersBody =
    markers.includes('todo') ||
    node.arguments.some((arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
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
  const printed = printer.printNode(ts.EmitHint.Expression, node, source);
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

/**
 * Every `expect` assertion of a test source, in source order, by its identity: the describe/it
 * titles that hold it, the run markers on that chain, and its canonical text (ADR-GOV-0026).
 * An assertion outside any test is identified by the file alone. Identical assertions in one
 * test appear once each.
 */
export function assertionIdentities(source: string): readonly string[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const identities: string[] = [];
  const walk = (node: ts.Node, scope: Scope): void => {
    if (ts.isCallExpression(node)) {
      const test = testCall(node, file);
      if (test !== undefined) {
        const inner = {
          titles: [...scope.titles, test.title],
          markers: [...scope.markers, ...test.markers],
        };
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
  return identities;
}

/**
 * The base assertions the head no longer holds with the same identity: edited, removed, moved
 * to another test, or re-marked (skipped, focused, todo). Formatting, comments, reordering and
 * added assertions change nothing. Each lost occurrence is named once.
 */
export function changedAssertions(base: string, head: string): readonly string[] {
  const remaining = new Map<string, number>();
  for (const identity of assertionIdentities(head)) {
    remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  }
  const changed: string[] = [];
  for (const identity of assertionIdentities(base)) {
    const left = remaining.get(identity) ?? 0;
    if (left > 0) remaining.set(identity, left - 1);
    else changed.push(identity);
  }
  return changed;
}
