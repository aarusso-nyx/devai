import { dirname } from 'node:path';
import ts from 'typescript';

export const FS_MUTATORS = new Set([
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'link',
  'linkSync',
  'mkdir',
  'mkdirSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'symlink',
  'symlinkSync',
  'unlink',
  'unlinkSync',
  'write',
  'writeFile',
  'writeFileSync',
  'writeSync',
]);
export const PROCESS_CALLS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'fork',
  'spawn',
  'spawnSync',
]);
export const UNAMBIGUOUS_PROCESS_CALLS = new Set([
  'execFile',
  'execFileSync',
  'fork',
  'spawn',
  'spawnSync',
]);
export const FUNCTION_FLAGS =
  ts.SymbolFlags.Function |
  ts.SymbolFlags.Method |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Variable |
  ts.SymbolFlags.Alias;

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function loadProgram(tsconfigPath: string): ts.Program {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfigPath));
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  }
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
}

export function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

export function functionsFromDeclaration(
  declaration: ts.Declaration,
): ts.FunctionLikeDeclaration[] {
  if (
    (ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isArrowFunction(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isGetAccessorDeclaration(declaration) ||
      ts.isSetAccessorDeclaration(declaration) ||
      ts.isConstructorDeclaration(declaration)) &&
    declaration.body !== undefined
  ) {
    return [declaration];
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return [declaration.initializer];
  }
  return [];
}

export function literalText(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const value = unwrapExpression(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

export function argvShape(expression: ts.Expression | undefined): readonly string[] {
  if (expression === undefined) return ['<none>'];
  const value = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(value)) return ['<dynamic-argv>'];
  if (value.elements.length === 0) return ['<none>'];
  return value.elements.map((element) => literalText(element as ts.Expression) ?? '<dynamic>');
}
