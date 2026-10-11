import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { readCandidateFile } from '@devai-nyx/sensors';

const PURE_PACKAGES = new Set([
  '@playwright/test',
  'vitest/config',
  'typescript',
  'unplugin-swc',
  'unplugin-swc/vite',
  '@swc/core',
]);
const BUILTINS = new Set(['node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:module']);
const AMBIENT = new Set([
  'Date',
  'Intl',
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'performance',
  'crypto',
  'global',
  'globalThis',
  'Reflect',
  'Function',
  'eval',
]);
const TYPESCRIPT_AST = new Set([
  'createSourceFile',
  'ScriptTarget',
  'ScriptKind',
  'isExportDeclaration',
  'isImportDeclaration',
]);

/** Finite configuration language; unsupported ambient selection cannot acquire standing. */
export function assertNativeConfigCapabilities(root: string, entry: string): void {
  const pending = [entry];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const path = pending[index] as string;
    if (visited.has(path)) continue;
    visited.add(path);
    const bytes = readCandidateFile(root, path);
    const source = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    const typescriptNamespaces = new Set<string>();
    const requireFactories = new Set<string>();
    const requireHandles = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const clause = statement.importClause;
      if (statement.moduleSpecifier.text === 'typescript') {
        if (clause?.name !== undefined) typescriptNamespaces.add(clause.name.text);
        if (clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings))
          typescriptNamespaces.add(clause.namedBindings.name.text);
        if (
          clause?.namedBindings !== undefined &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.some(
            (element) => !TYPESCRIPT_AST.has((element.propertyName ?? element.name).text),
          )
        )
          throw new Error('SENSE_NATIVE_CONFIG_TYPESCRIPT_CAPABILITY_UNSUPPORTED');
      }
      if (
        statement.moduleSpecifier.text === 'node:module' &&
        clause?.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings)
      )
        for (const element of clause.namedBindings.elements)
          requireFactories.add(element.name.text);
    }
    const findHandles = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        requireFactories.has(node.initializer.expression.text)
      )
        requireHandles.add(node.name.text);
      ts.forEachChild(node, findHandles);
    };
    findHandles(source);
    const dependency = (specifier: string, declaration?: ts.ImportDeclaration): void => {
      if (specifier.startsWith('.')) {
        const target = relative(root, resolve(root, dirname(path), specifier));
        if (!/\.(?:[cm]?js|[cm]?ts)$/u.test(target))
          throw new Error('SENSE_NATIVE_CONFIG_IMPORT_UNSUPPORTED');
        readCandidateFile(root, target);
        pending.push(target);
      } else if (!PURE_PACKAGES.has(specifier) && !BUILTINS.has(specifier))
        throw new Error('SENSE_NATIVE_CONFIG_CAPABILITY_UNSUPPORTED');
      if (specifier === 'typescript' && declaration === undefined)
        throw new Error('SENSE_NATIVE_CONFIG_TYPESCRIPT_CAPABILITY_UNSUPPORTED');
      if (specifier === 'node:module') {
        const bindings = declaration?.importClause?.namedBindings;
        if (
          declaration?.importClause?.name !== undefined ||
          bindings === undefined ||
          !ts.isNamedImports(bindings) ||
          bindings.elements.some(
            (element) => (element.propertyName ?? element.name).text !== 'createRequire',
          )
        )
          throw new Error('SENSE_NATIVE_CONFIG_MODULE_CAPABILITY_UNSUPPORTED');
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        ((ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
          (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
          (ts.isImportSpecifier(node.parent) && node.parent.propertyName === node))
      )
        return;
      if (ts.isIdentifier(node) && AMBIENT.has(node.text))
        throw new Error('SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED');
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const property = ts.isPropertyAccessExpression(parent) && parent.expression === node;
        const binding =
          (ts.isVariableDeclaration(parent) && parent.name === node) ||
          (ts.isImportClause(parent) && parent.name === node) ||
          (ts.isNamespaceImport(parent) && parent.name === node) ||
          (ts.isImportSpecifier(parent) && parent.name === node);
        if (node.text === 'process' && !property)
          throw new Error('SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED');
        if (node.text === 'module' && (!property || parent.name.text !== 'exports'))
          throw new Error('SENSE_NATIVE_CONFIG_MODULE_CAPABILITY_UNSUPPORTED');
        if (
          node.text === 'require' &&
          !binding &&
          !(ts.isCallExpression(parent) && parent.expression === node) &&
          !(
            property &&
            parent.name.text === 'resolve' &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent
          )
        )
          throw new Error('SENSE_NATIVE_CONFIG_MODULE_CAPABILITY_UNSUPPORTED');
        if (
          requireHandles.has(node.text) &&
          !binding &&
          !(
            property &&
            parent.name.text === 'resolve' &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent
          )
        )
          throw new Error('SENSE_NATIVE_CONFIG_MODULE_CAPABILITY_UNSUPPORTED');
        if (
          requireFactories.has(node.text) &&
          !binding &&
          !(
            ts.isCallExpression(parent) &&
            parent.expression === node &&
            ts.isVariableDeclaration(parent.parent) &&
            parent.parent.initializer === parent
          )
        )
          throw new Error('SENSE_NATIVE_CONFIG_MODULE_CAPABILITY_UNSUPPORTED');
        if (
          typescriptNamespaces.has(node.text) &&
          !binding &&
          !(property && TYPESCRIPT_AST.has(parent.name.text))
        )
          throw new Error('SENSE_NATIVE_CONFIG_TYPESCRIPT_CAPABILITY_UNSUPPORTED');
      }
      if (
        ts.isIdentifier(node) &&
        node.text === 'Math' &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          node.parent.name.text !== 'random'
        )
      )
        throw new Error('SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED');
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined &&
        ts.isStringLiteral(node.argumentExpression) &&
        ['constructor', '__proto__'].includes(node.argumentExpression.text)
      )
        throw new Error('SENSE_NATIVE_CONFIG_COMPUTED_CAPABILITY_UNSUPPORTED');
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'process' &&
        node.name.text === 'env'
      ) {
        const access = node.parent;
        if (!(
          (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) &&
          access.expression === node
        ))
          throw new Error('SENSE_NATIVE_CONFIG_ENVIRONMENT_MUTATION_UNSUPPORTED');
        let target: ts.Node = access;
        for (;;) {
          const parent = target.parent;
          if (
            ts.isParenthesizedExpression(parent) ||
            ts.isAsExpression(parent) ||
            ts.isNonNullExpression(parent) ||
            ts.isTypeAssertionExpression(parent) ||
            ts.isArrayLiteralExpression(parent) ||
            ts.isObjectLiteralExpression(parent) ||
            (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
            ts.isSpreadElement(parent) ||
            ts.isSpreadAssignment(parent)
          ) {
            target = parent;
            continue;
          }
          if (
            (ts.isBinaryExpression(parent) &&
              parent.left === target &&
              parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ts.isDeleteExpression(parent) ||
            (ts.isPrefixUnaryExpression(parent) &&
              [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
                parent.operator,
              )) ||
            ts.isPostfixUnaryExpression(parent) ||
            ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
              parent.initializer === target)
          )
            throw new Error('SENSE_NATIVE_CONFIG_ENVIRONMENT_MUTATION_UNSUPPORTED');
          break;
        }
      }
      if (ts.isPropertyAccessExpression(node)) {
        if (
          node.name.text === 'constructor' ||
          node.name.text === '__proto__' ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'Math' &&
            node.name.text === 'random') ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'process' &&
            !['env', 'cwd', 'platform', 'arch', 'versions', 'version'].includes(node.name.text))
        )
          throw new Error('SENSE_NATIVE_CONFIG_AMBIENT_SELECTION_UNSUPPORTED');
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ['Math', 'process'].includes(node.expression.text)
      )
        throw new Error('SENSE_NATIVE_CONFIG_COMPUTED_CAPABILITY_UNSUPPORTED');
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
        dependency(node.moduleSpecifier.text, node);
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        dependency(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument === undefined || !ts.isStringLiteral(argument))
          throw new Error('SENSE_NATIVE_CONFIG_COMPUTED_IMPORT_UNSUPPORTED');
        dependency(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
