import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

type Ownership = 'owned' | 'external' | 'unknown';
type Classification =
  | 'owned-substitution'
  | 'external-port'
  | 'observer'
  | 'fault-injection'
  | 'unresolved'
  | 'local-double';

export interface TestMockClassification {
  readonly mocks: number;
  readonly fixtures: number;
  readonly snapshots: number;
  readonly ownedSubstitutions: number;
  readonly unresolved: number;
  readonly observers: number;
  readonly faultInjections: number;
  readonly externalPorts: number;
}

interface MockModuleResolution {
  target(file: string, specifier: string): string | undefined;
  ownership(file: string, specifier: string): Ownership;
}

/** Resolution is shared only inside one synchronous sensor invocation. */
function createMockModuleResolution(root: string): MockModuleResolution {
  const configPaths = new Map<string, string | undefined>();
  const configOptions = new Map<string, ts.CompilerOptions>();
  const targets = new Map<string, Map<string, string | undefined>>();
  const ownerships = new Map<string, Map<string, Ownership>>();
  const defaults: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext };
  let physicalRoot: string | undefined;
  const options = (file: string): ts.CompilerOptions => {
    const directory = dirname(file);
    if (!configPaths.has(directory))
      configPaths.set(directory, ts.findConfigFile(directory, ts.sys.fileExists));
    const config = configPaths.get(directory);
    if (config === undefined) return defaults;
    const cached = configOptions.get(config);
    if (cached !== undefined) return cached;
    const loaded = ts.readConfigFile(config, ts.sys.readFile);
    // Only compiler options participate in module resolution. Expanding include/files
    // would repeatedly enumerate the whole project for each import without using it.
    const value =
      loaded.error === undefined
        ? ts.parseJsonConfigFileContent(
            loaded.config,
            { ...ts.sys, readDirectory: () => [] },
            dirname(config),
          ).options
        : defaults;
    configOptions.set(config, value);
    return value;
  };
  const target = (file: string, specifier: string): string | undefined => {
    if (specifier.startsWith('node:')) return undefined;
    let cache = targets.get(file);
    if (cache === undefined) {
      cache = new Map();
      targets.set(file, cache);
    }
    if (cache.has(specifier)) return cache.get(specifier);
    let resolved = ts.resolveModuleName(specifier, file, options(file), ts.sys).resolvedModule
      ?.resolvedFileName;
    if (resolved === undefined && specifier.startsWith('.')) {
      const base = resolve(dirname(file), specifier).replace(/\.(?:js|jsx|mjs|cjs)$/u, '');
      resolved = [
        base,
        ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((extension) => `${base}${extension}`),
        resolve(base, 'index.ts'),
      ].find(existsSync);
    }
    cache.set(specifier, resolved);
    return resolved;
  };
  const ownership = (file: string, specifier: string): Ownership => {
    if (specifier.startsWith('node:')) return 'external';
    let cache = ownerships.get(file);
    if (cache === undefined) {
      cache = new Map();
      ownerships.set(file, cache);
    }
    const cached = cache.get(specifier);
    if (cached !== undefined) return cached;
    const resolved = target(file, specifier);
    let value: Ownership = 'unknown';
    if (resolved !== undefined) {
      try {
        if (!lstatSync(resolved).isSymbolicLink()) {
          physicalRoot ??= realpathSync(root);
          const rel = relative(physicalRoot, realpathSync(resolved));
          value =
            rel === '..' ||
            rel.startsWith(`..${sep}`) ||
            isAbsolute(rel) ||
            rel.split(sep).includes('node_modules')
              ? 'external'
              : 'owned';
        }
      } catch {
        // Unreadable, missing and linked targets never gain owned classification.
      }
    }
    cache.set(specifier, value);
    return value;
  };
  return { target, ownership };
}

function nameOf(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return nameOf(expression.expression);
  return undefined;
}

function chainedCalls(seed: ts.CallExpression): readonly ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  let node: ts.Node = seed;
  while (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)) {
    node = node.parent.parent;
    out.push(node as ts.CallExpression);
  }
  return out;
}

function oneShotNegativeWitness(
  seed: ts.CallExpression,
  chain: readonly ts.CallExpression[],
): boolean {
  const override = chain[0];
  if (
    chain.length !== 1 ||
    override === undefined ||
    !ts.isPropertyAccessExpression(override.expression) ||
    override.expression.name.text !== 'mockRejectedValueOnce'
  )
    return false;
  const object = seed.arguments[0];
  const method = seed.arguments[1];
  if (object === undefined || method === undefined || !ts.isStringLiteralLike(method)) return false;
  let scope: ts.Node = seed;
  while (scope.parent !== undefined && !ts.isFunctionLike(scope)) scope = scope.parent;
  if (!ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope)) return false;
  if (
    !ts.isCallExpression(scope.parent) ||
    !/^(?:it|test)(?:\.|$)/u.test(scope.parent.expression.getText())
  )
    return false;
  let witnessed = false;
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const terminal = node.expression.expression;
      if (
        ts.isPropertyAccessExpression(terminal) &&
        /^to(?:Throw|Equal|Match|Be)/u.test(terminal.name.text)
      ) {
        const rejects = terminal.expression;
        if (
          ts.isPropertyAccessExpression(rejects) &&
          rejects.name.text === 'rejects' &&
          ts.isCallExpression(rejects.expression)
        ) {
          const expectation = rejects.expression;
          const invocation = expectation.arguments[0];
          if (
            ts.isIdentifier(expectation.expression) &&
            expectation.expression.text === 'expect' &&
            invocation !== undefined &&
            ts.isCallExpression(invocation) &&
            ts.isPropertyAccessExpression(invocation.expression) &&
            invocation.expression.name.text === method.text &&
            invocation.expression.expression.getText() === object.getText()
          )
            witnessed = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return witnessed;
}

/** Classify actual call nodes and resolved imports, never comment/string contents. */
function classifyFileMocks(
  file: string,
  content: string,
  resolution: MockModuleResolution,
): TestMockClassification {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = new Map<string, Ownership>();
  const testApis = new Set(['vi', 'jest']);
  const initializers = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const ownership = resolution.ownership(file, specifier);
      const clause = statement.importClause;
      if (clause?.name !== undefined) imports.set(clause.name.text, ownership);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings))
        imports.set(bindings.name.text, ownership);
      else if (bindings !== undefined)
        for (const element of bindings.elements) {
          imports.set(element.name.text, ownership);
          if (
            ['vitest', '@jest/globals'].includes(specifier) &&
            ['vi', 'jest'].includes(element.propertyName?.text ?? element.name.text)
          )
            testApis.add(element.name.text);
        }
    }
  }
  const declarations = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    )
      initializers.set(node.name.text, node.initializer);
    ts.forEachChild(node, declarations);
  };
  declarations(source);
  const owner = (expression: ts.Expression | undefined, seen = new Set<string>()): Ownership => {
    if (expression === undefined) return 'unknown';
    const name = nameOf(ts.isNewExpression(expression) ? expression.expression : expression);
    if (name === undefined || seen.has(name)) return 'unknown';
    const imported = imports.get(name);
    if (imported !== undefined) return imported;
    seen.add(name);
    return owner(initializers.get(name), seen);
  };
  const counts = {
    mocks: 0,
    fixtures: 0,
    snapshots: 0,
    ownedSubstitutions: 0,
    unresolved: 0,
    observers: 0,
    faultInjections: 0,
    externalPorts: 0,
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        ts.isPropertyAccessExpression(expression) &&
        ['useValue', 'useClass', 'useFactory'].includes(expression.name.text) &&
        ts.isCallExpression(expression.expression)
      ) {
        const override = expression.expression;
        if (
          ts.isPropertyAccessExpression(override.expression) &&
          [
            'overrideGuard',
            'overrideProvider',
            'overrideInterceptor',
            'overrideFilter',
            'overridePipe',
          ].includes(override.expression.name.text)
        ) {
          const ownership = owner(override.arguments[0]);
          if (ownership === 'external') counts.externalPorts += 1;
          else {
            counts.mocks += 1;
            if (ownership === 'owned') counts.ownedSubstitutions += 1;
            else counts.unresolved += 1;
          }
        }
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        /^mock(?:Implementation|ReturnValue|ResolvedValue|RejectedValue)(?:Once)?$/u.test(
          expression.name.text,
        )
      ) {
        const hasSeed = (value: ts.Expression | undefined, seen = new Set<string>()): boolean => {
          if (value === undefined) return false;
          if (ts.isIdentifier(value)) {
            if (seen.has(value.text)) return false;
            seen.add(value.text);
            return hasSeed(initializers.get(value.text), seen);
          }
          if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
            const receiver = value.expression.expression;
            return (
              (ts.isIdentifier(receiver) &&
                testApis.has(receiver.text) &&
                ['fn', 'spyOn', 'mock', 'doMock'].includes(value.expression.name.text)) ||
              hasSeed(receiver, seen)
            );
          }
          return false;
        };
        if (!hasSeed(expression.expression)) {
          const ownership = owner(expression.expression);
          if (ownership === 'external') counts.externalPorts += 1;
          else {
            counts.mocks += 1;
            if (ownership === 'owned') counts.ownedSubstitutions += 1;
            else counts.unresolved += 1;
          }
        }
      }
      if (
        ts.isIdentifier(expression) &&
        /^(?:beforeAll|beforeEach|afterAll|afterEach)$/u.test(expression.text)
      )
        counts.fixtures += 1;
      if (
        ts.isPropertyAccessExpression(expression) &&
        /^toMatch(?:Inline)?Snapshot$/u.test(expression.name.text)
      )
        counts.snapshots += 1;
      if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        testApis.has(expression.expression.text) &&
        ['mock', 'doMock', 'fn', 'spyOn'].includes(expression.name.text)
      ) {
        const allCalls = [...chainedCalls(node)];
        let declaration: ts.Node = node;
        while (
          ts.isPropertyAccessExpression(declaration.parent) ||
          ts.isCallExpression(declaration.parent)
        )
          declaration = declaration.parent;
        if (
          ts.isVariableDeclaration(declaration.parent) &&
          ts.isIdentifier(declaration.parent.name)
        ) {
          const aliases = new Set([declaration.parent.name.text]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const [name, initializer] of initializers) {
              if (
                ts.isIdentifier(initializer) &&
                aliases.has(initializer.text) &&
                !aliases.has(name)
              ) {
                aliases.add(name);
                changed = true;
              }
            }
          }
          const assignedCalls = (candidate: ts.Node): void => {
            if (
              ts.isCallExpression(candidate) &&
              ts.isPropertyAccessExpression(candidate.expression) &&
              ts.isIdentifier(candidate.expression.expression) &&
              aliases.has(candidate.expression.expression.text)
            )
              allCalls.push(candidate);
            ts.forEachChild(candidate, assignedCalls);
          };
          assignedCalls(source);
        }
        const chain = allCalls.filter(
          (call) =>
            !ts.isPropertyAccessExpression(call.expression) ||
            !['mockName', 'mockClear', 'mockRestore', 'getMockName'].includes(
              call.expression.name.text,
            ),
        );
        let classification: Classification;
        if (expression.name.text === 'spyOn' && chain.length === 0) classification = 'observer';
        else if (expression.name.text === 'spyOn' && oneShotNegativeWitness(node, chain))
          classification = 'fault-injection';
        else if (expression.name.text === 'fn') {
          classification = 'local-double';
          let ancestor: ts.Node = node;
          while (ancestor.parent !== undefined) {
            ancestor = ancestor.parent;
            if (
              ts.isCallExpression(ancestor) &&
              ts.isPropertyAccessExpression(ancestor.expression) &&
              ['mock', 'doMock'].includes(ancestor.expression.name.text) &&
              ts.isIdentifier(ancestor.expression.expression) &&
              testApis.has(ancestor.expression.expression.text)
            ) {
              const target = ancestor.arguments[0];
              if (
                target !== undefined &&
                ts.isStringLiteralLike(target) &&
                resolution.ownership(file, target.text) === 'external'
              )
                classification = 'external-port';
              break;
            }
          }
        } else {
          const target = node.arguments[0];
          const ownership =
            expression.name.text === 'spyOn'
              ? owner(target)
              : target !== undefined && ts.isStringLiteralLike(target)
                ? resolution.ownership(file, target.text)
                : 'unknown';
          classification =
            ownership === 'owned'
              ? 'owned-substitution'
              : ownership === 'external'
                ? 'external-port'
                : 'unresolved';
        }
        if (classification === 'observer') counts.observers += 1;
        else if (classification === 'fault-injection') counts.faultInjections += 1;
        else if (classification === 'external-port') counts.externalPorts += 1;
        else {
          counts.mocks += 1;
          if (classification === 'owned-substitution') counts.ownedSubstitutions += 1;
          if (classification === 'unresolved') counts.unresolved += 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
}

interface LocalMockAnalysis {
  readonly bytes: string;
  readonly counts: TestMockClassification;
  readonly dependencies: readonly string[];
}

/** Reuse local facts, never a root's aggregate or visited set, within one scan. */
export function createTestMockClassifier(
  root: string,
): (file: string, content: string) => TestMockClassification {
  const resolution = createMockModuleResolution(root);
  const analyses = new Map<string, LocalMockAnalysis>();
  const analyze = (path: string, content?: string): LocalMockAnalysis => {
    const cached = analyses.get(path);
    if (cached !== undefined && (content === undefined || content === cached.bytes)) return cached;
    const bytes = content ?? readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, bytes, ts.ScriptTarget.Latest, true);
    const parsed = source as ts.SourceFile & {
      readonly parseDiagnostics: readonly ts.Diagnostic[];
    };
    const counts: TestMockClassification =
      parsed.parseDiagnostics.length > 0
        ? {
            mocks: 1,
            unresolved: 1,
            fixtures: 0,
            snapshots: 0,
            ownedSubstitutions: 0,
            observers: 0,
            faultInjections: 0,
            externalPorts: 0,
          }
        : classifyFileMocks(path, bytes, resolution);
    const dependencies = new Set<string>();
    let unresolvedImports = 0;
    const imports = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        if (
          !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) &&
          !(ts.isExportDeclaration(node) && node.isTypeOnly)
        )
          dependencies.add(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteralLike(argument))
          dependencies.add(argument.text);
        else unresolvedImports += 1;
      }
      ts.forEachChild(node, imports);
    };
    if (parsed.parseDiagnostics.length === 0) imports(source);
    const result: LocalMockAnalysis = {
      bytes,
      counts: {
        ...counts,
        mocks: counts.mocks + unresolvedImports,
        unresolved: counts.unresolved + unresolvedImports,
      },
      dependencies: [...dependencies],
    };
    analyses.set(path, result);
    return result;
  };
  return (file, content) => {
    const counts = {
      mocks: 0,
      fixtures: 0,
      snapshots: 0,
      ownedSubstitutions: 0,
      unresolved: 0,
      observers: 0,
      faultInjections: 0,
      externalPorts: 0,
    };
    const visited = new Set<string>();
    const unresolved = (): void => {
      counts.mocks += 1;
      counts.unresolved += 1;
    };
    const inspect = (path: string, bytes?: string): void => {
      const identity = resolve(path);
      if (visited.has(identity)) return;
      const local = analyze(identity, bytes);
      visited.add(identity);
      for (const key of Object.keys(counts) as (keyof typeof counts)[])
        counts[key] += local.counts[key];
      for (const specifier of local.dependencies) {
        const ownership = resolution.ownership(identity, specifier);
        const target = resolution.target(identity, specifier);
        if (ownership === 'owned' && target !== undefined && !target.endsWith('.d.ts')) {
          try {
            inspect(target);
          } catch {
            unresolved();
          }
        } else if (ownership === 'unknown' && specifier.startsWith('.')) unresolved();
      }
    };
    inspect(file, content);
    return counts;
  };
}

/** Follow owned imports so a helper cannot hide an authorization substitution. */
export function classifyTestMocks(
  root: string,
  file: string,
  content: string,
): TestMockClassification {
  return createTestMockClassifier(root)(file, content);
}
