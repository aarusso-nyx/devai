import ts from 'typescript';

type TestRunnerFamily = 'node-test' | 'vitest' | 'jest';
const TEST_APIS: Record<TestRunnerFamily, ReadonlySet<string>> = {
  'node-test': new Set(['test', 'it', 'describe', 'suite']),
  vitest: new Set(['test', 'it', 'describe']),
  jest: new Set(['test', 'it', 'describe']),
};

/** Static naming evidence only: a value import and its unshadowed test API call. */
export function testRunnerFamily(path: string, content: string): TestRunnerFamily | undefined {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const diagnostics = (
    source as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (diagnostics.length > 0) return undefined;
  const families = new Set<TestRunnerFamily>();
  const bindings = new Map<string, { family: TestRunnerFamily; namespace: boolean }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    const family =
      module === 'node:test'
        ? 'node-test'
        : module === 'vitest'
          ? 'vitest'
          : module === '@jest/globals'
            ? 'jest'
            : undefined;
    const clause = statement.importClause;
    if (family === undefined || clause === undefined || clause.isTypeOnly) continue;
    const add = (name: string, namespace: boolean): void => {
      families.add(family);
      bindings.set(name, { family, namespace });
    };
    if (clause.name !== undefined) {
      families.add(family);
      if (family === 'node-test') add(clause.name.text, false);
    }
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) add(named.name.text, true);
    else if (named !== undefined)
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        families.add(family);
        if (TEST_APIS[family].has(element.propertyName?.text ?? element.name.text))
          add(element.name.text, false);
      }
  }
  if (families.size !== 1 || bindings.size === 0) return undefined;

  // Any local redeclaration of an imported name makes this small classifier
  // conservative, even if its scope is unrelated to a witnessed call.
  const shadowed = new Set<string>();
  const names = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) shadowed.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) names(element.name);
  };
  const declarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) names(node.name);
    else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isImportEqualsDeclaration(node)) &&
      node.name !== undefined
    )
      shadowed.add(node.name.text);
    ts.forEachChild(node, declarations);
  };
  declarations(source);
  let witnessed: TestRunnerFamily | undefined;
  const calls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const binding = bindings.get(callee.text);
        if (binding !== undefined && !binding.namespace && !shadowed.has(callee.text))
          witnessed = binding.family;
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const name = callee.expression.text;
        const binding = bindings.get(name);
        if (
          binding?.namespace === true &&
          TEST_APIS[binding.family].has(callee.name.text) &&
          !shadowed.has(name)
        )
          witnessed = binding.family;
      }
    }
    ts.forEachChild(node, calls);
  };
  calls(source);
  return witnessed;
}
