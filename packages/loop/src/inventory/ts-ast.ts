import ts from 'typescript';
import { inventorySnapshotValue, readInventorySource } from './walker.js';

/** Parse a TS source file into a SourceFile AST node. */
export function parseSourceFile(path: string): ts.SourceFile {
  return inventorySnapshotValue(`ts-ast:${path}`, () => {
    const text = readInventorySource(path);
    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  });
}

/**
 * Yield every decorator on every class declaration in the source file.
 * Modern TS exposes decorators via the modifiers array; this helper unifies
 * the lookup.
 */
export function* iterateClassDecorators(
  source: ts.SourceFile,
): Generator<{ class: ts.ClassDeclaration; decorator: ts.Decorator; name: string }> {
  for (const node of source.statements) {
    if (!ts.isClassDeclaration(node)) continue;
    for (const mod of node.modifiers ?? []) {
      if (!ts.isDecorator(mod)) continue;
      const name = decoratorName(mod);
      if (name === null) continue;
      yield { class: node, decorator: mod, name };
    }
  }
}

/**
 * Yield every decorator on every method declaration inside every class.
 * Used by route extraction (NestJS controller methods).
 */
export function* iterateMethodDecorators(source: ts.SourceFile): Generator<{
  class: ts.ClassDeclaration;
  method: ts.MethodDeclaration;
  decorator: ts.Decorator;
  name: string;
}> {
  for (const node of source.statements) {
    if (!ts.isClassDeclaration(node)) continue;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      for (const mod of member.modifiers ?? []) {
        if (!ts.isDecorator(mod)) continue;
        const name = decoratorName(mod);
        if (name === null) continue;
        yield { class: node, method: member, decorator: mod, name };
      }
    }
  }
}

export function decoratorName(decorator: ts.Decorator): string | null {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text;
  }
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  return null;
}

/**
 * Extract a string literal argument from a decorator call expression, by
 * argument index. Returns null for non-literal or out-of-range arguments.
 */
export function decoratorStringArg(decorator: ts.Decorator, index: number): string | null {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) return null;
  const arg = expr.arguments[index];
  if (arg === undefined) return null;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.text;
  }
  return null;
}

export function className(node: ts.ClassDeclaration): string {
  return node.name?.text ?? '<anonymous>';
}

export function methodName(node: ts.MethodDeclaration): string {
  if (ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isStringLiteral(node.name)) return node.name.text;
  return '<anonymous>';
}
