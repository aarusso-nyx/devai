import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
export { ACTION_EFFECT_CONTRACTS } from './generated/action-catalog.js';

export type EffectCapability =
  'fs:unknown-write' | 'db:unclassified' | `proc:${string}` | `net:${string}`;

export interface EffectContract {
  readonly action_id: string;
  readonly effect: string;
  readonly capabilities?: readonly string[];
}

export interface EffectDisposition {
  readonly edge: string;
  readonly reason: string;
}

export interface ActionEffectAnalysis {
  readonly declared_effect: string;
  readonly declared_capabilities: readonly string[];
  readonly capabilities: readonly EffectCapability[];
  readonly unresolved_edges: readonly string[];
  readonly dispositions: readonly EffectDisposition[];
}

export interface EffectFinding {
  readonly code: string;
  readonly action_id?: string;
  readonly message: string;
}

export interface EffectReport {
  readonly actions: Readonly<Record<string, ActionEffectAnalysis>>;
  readonly findings: readonly EffectFinding[];
  readonly subprocess_templates: readonly Readonly<{
    executable: string;
    argv_shape: readonly string[];
    actions: readonly string[];
  }>[];
  readonly advisory_patterns: Readonly<{
    violations: number;
    dispositions: readonly EffectDisposition[];
  }>;
  readonly metrics: Readonly<{
    program_files: number;
    catalog_actions: number;
    extracted_actions: number;
    unresolved_edges: number;
    dispositioned_edges: number;
    duration_ms: number;
  }>;
}

const BINDING_FINDINGS = new Set([
  'EFFECT_UNDER_DECLARED',
  'SPAWN_EFFECT_UNDECLARED',
  'EFFECT_EDGE_UNRESOLVED',
  'EFFECT_EXTRACTOR_CATALOG_MISMATCH',
  'EFFECT_CAPABILITIES_MISSING',
  'EFFECT_CONTRACT_MISSING',
]);

export function enforceEffectReport(input: {
  readonly findings: readonly Readonly<{
    code: string;
    action_id?: string;
    message: string;
  }>[];
}): void {
  const blocking = input.findings.filter((finding) => BINDING_FINDINGS.has(finding.code));
  if (blocking.length === 0) return;
  throw new Error(
    blocking
      .map(
        (finding) =>
          `${finding.code}${finding.action_id === undefined ? '' : `:${finding.action_id}`}`,
      )
      .join('\n'),
  );
}

export interface SubprocessTemplate {
  readonly executable?: unknown;
  readonly argv_shape?: unknown;
  readonly capabilities?: unknown;
}

interface AnalysisInput {
  readonly tsconfigPath: string;
  readonly catalog: readonly string[];
  readonly contracts: readonly EffectContract[];
  readonly subprocessRegistry: Readonly<{ templates: readonly SubprocessTemplate[] }>;
}

const FS_MUTATORS = new Set([
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
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
const PROCESS_CALLS = new Set(['exec', 'execFile', 'execFileSync', 'fork', 'spawn', 'spawnSync']);
const UNAMBIGUOUS_PROCESS_CALLS = new Set([
  'execFile',
  'execFileSync',
  'fork',
  'spawn',
  'spawnSync',
]);
const FUNCTION_FLAGS =
  ts.SymbolFlags.Function |
  ts.SymbolFlags.Method |
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Variable |
  ts.SymbolFlags.Alias;

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

export function parseActionEffectsSource(source: string): Readonly<Record<string, string>> {
  const file = ts.createSourceFile('command-manifest.ts', source, ts.ScriptTarget.Latest, true);
  const result: Record<string, string> = {};
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ACTION_EFFECTS' &&
      node.initializer !== undefined
    ) {
      const value = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = ts.isIdentifier(property.name)
            ? property.name.text
            : ts.isStringLiteralLike(property.name)
              ? property.name.text
              : undefined;
          const initializer = unwrapExpression(property.initializer);
          if (key !== undefined && ts.isStringLiteralLike(initializer)) {
            result[key] = initializer.text;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

export function validateDeclaredCapabilityConsistency(input: {
  readonly catalog: readonly string[];
  readonly contracts: readonly EffectContract[];
}): void {
  const byAction = new Map(input.contracts.map((contract) => [contract.action_id, contract]));
  for (const action of input.catalog) {
    const contract = byAction.get(action);
    if (contract === undefined) throw new Error(`${action}: EFFECT_CONTRACT_MISSING`);
    if (contract.capabilities === undefined)
      throw new Error(`${action}: EFFECT_CAPABILITIES_MISSING`);
  }
  const extras = input.contracts.filter((contract) => !input.catalog.includes(contract.action_id));
  if (extras.length > 0) throw new Error('EFFECT_CONTRACT_CATALOG_MISMATCH');
}

function loadProgram(tsconfigPath: string): ts.Program {
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

function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

function functionsFromDeclaration(declaration: ts.Declaration): ts.FunctionLikeDeclaration[] {
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

function literalText(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const value = unwrapExpression(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function argvShape(expression: ts.Expression | undefined): readonly string[] {
  if (expression === undefined) return ['<none>'];
  const value = unwrapExpression(expression);
  if (!ts.isArrayLiteralExpression(value)) return ['<dynamic-argv>'];
  if (value.elements.length === 0) return ['<none>'];
  return value.elements.map((element) => literalText(element as ts.Expression) ?? '<dynamic>');
}

export async function analyzeEffectProgram(input: AnalysisInput): Promise<EffectReport> {
  const started = performance.now();
  const program = loadProgram(resolve(input.tsconfigPath));
  const checker = program.getTypeChecker();
  const sourceFiles = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && !file.fileName.includes('/node_modules/'));
  const entries = new Map<string, ts.Expression[]>();

  const visitEntries = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callName = ts.isIdentifier(node.expression) ? node.expression.text : undefined;
      const argument = node.arguments[0];
      if (
        callName === 'defineCommand' &&
        argument !== undefined &&
        ts.isObjectLiteralExpression(argument)
      ) {
        let name: string | undefined;
        const handlers: ts.Expression[] = [];
        for (const property of argument.properties) {
          if (property.name === undefined) continue;
          const propertyName = ts.isIdentifier(property.name)
            ? property.name.text
            : ts.isStringLiteralLike(property.name)
              ? property.name.text
              : undefined;
          if (propertyName === 'name' && ts.isPropertyAssignment(property)) {
            name = literalText(property.initializer);
          }
          if (propertyName === 'run' && ts.isPropertyAssignment(property))
            handlers.push(property.initializer);
          if (propertyName === 'register') {
            const body = ts.isMethodDeclaration(property)
              ? property.body
              : ts.isPropertyAssignment(property) &&
                  (ts.isArrowFunction(property.initializer) ||
                    ts.isFunctionExpression(property.initializer))
                ? property.initializer.body
                : undefined;
            if (body !== undefined) {
              const visitActions = (child: ts.Node): void => {
                if (
                  ts.isCallExpression(child) &&
                  ts.isPropertyAccessExpression(child.expression) &&
                  child.expression.name.text === 'action' &&
                  child.arguments[0] !== undefined
                ) {
                  handlers.push(child.arguments[0]);
                }
                ts.forEachChild(child, visitActions);
              };
              visitActions(body);
            }
          }
        }
        if (name !== undefined) entries.set(name, handlers);
      }
    }
    ts.forEachChild(node, visitEntries);
  };
  for (const sourceFile of sourceFiles) visitEntries(sourceFile);

  const evaluateFactoryTemplate = (
    expression: ts.Expression,
    bindings: ReadonlyMap<string, string>,
  ): string | undefined => {
    const value = unwrapExpression(expression);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (ts.isIdentifier(value)) return bindings.get(value.text);
    if (!ts.isTemplateExpression(value)) return undefined;
    let output = value.head.text;
    for (const span of value.templateSpans) {
      if (!ts.isIdentifier(span.expression)) return undefined;
      const binding = bindings.get(span.expression.text);
      if (binding === undefined) return undefined;
      output += binding + span.literal.text;
    }
    return output;
  };
  const visitFactoryCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const declaration = symbolAt(checker, node.expression)?.declarations?.find((candidate) =>
        ts.isFunctionDeclaration(candidate),
      );
      if (declaration !== undefined && ts.isFunctionDeclaration(declaration) && declaration.body) {
        const bindings = new Map<string, string>();
        declaration.parameters.forEach((parameter, index) => {
          if (!ts.isIdentifier(parameter.name)) return;
          const value = literalText(node.arguments[index]);
          if (value !== undefined) bindings.set(parameter.name.text, value);
        });
        const inspectFactory = (child: ts.Node): void => {
          if (
            ts.isCallExpression(child) &&
            ts.isIdentifier(child.expression) &&
            child.expression.text === 'defineCommand' &&
            child.arguments[0] !== undefined &&
            ts.isObjectLiteralExpression(child.arguments[0])
          ) {
            let name: string | undefined;
            const handlers: ts.Expression[] = [];
            for (const property of child.arguments[0].properties) {
              if (property.name === undefined) continue;
              const propertyName = ts.isIdentifier(property.name) ? property.name.text : undefined;
              if (propertyName === 'name' && ts.isPropertyAssignment(property)) {
                name = evaluateFactoryTemplate(property.initializer, bindings);
              } else if (propertyName === 'name' && ts.isShorthandPropertyAssignment(property)) {
                name = bindings.get(property.name.text);
              }
              if (propertyName === 'register') {
                const body = ts.isMethodDeclaration(property) ? property.body : undefined;
                if (body !== undefined) {
                  const inspectActions = (actionNode: ts.Node): void => {
                    if (
                      ts.isCallExpression(actionNode) &&
                      ts.isPropertyAccessExpression(actionNode.expression) &&
                      actionNode.expression.name.text === 'action' &&
                      actionNode.arguments[0] !== undefined
                    ) {
                      handlers.push(actionNode.arguments[0]);
                    }
                    ts.forEachChild(actionNode, inspectActions);
                  };
                  inspectActions(body);
                }
              }
            }
            if (name !== undefined) entries.set(name, handlers);
          }
          ts.forEachChild(child, inspectFactory);
        };
        inspectFactory(declaration.body);
      }
    }
    ts.forEachChild(node, visitFactoryCalls);
  };
  for (const sourceFile of sourceFiles) visitFactoryCalls(sourceFile);

  const selectedEntries = new Map(
    [...entries].filter(([action]) => input.catalog.includes(action)),
  );
  const extracted = [...selectedEntries.keys()].sort();
  const catalog = [...input.catalog].sort();
  if (JSON.stringify(extracted) !== JSON.stringify(catalog)) {
    const missing = catalog.filter((action) => !selectedEntries.has(action));
    const extra = extracted.filter((action) => !input.catalog.includes(action));
    throw new Error(
      `EFFECT_EXTRACTOR_CATALOG_MISMATCH missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
    );
  }
  validateDeclaredCapabilityConsistency({ catalog: input.catalog, contracts: input.contracts });

  const allMethods = new Map<string, ts.FunctionLikeDeclaration[]>();
  for (const sourceFile of sourceFiles) {
    const collect = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node) && node.body !== undefined) {
        const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
        if (name !== undefined) allMethods.set(name, [...(allMethods.get(name) ?? []), node]);
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
  }

  const contracts = new Map(input.contracts.map((contract) => [contract.action_id, contract]));
  const actions: Record<string, ActionEffectAnalysis> = {};
  const findings: EffectFinding[] = [];
  const advisoryDispositions: EffectDisposition[] = [];
  const subprocesses = new Map<
    string,
    { executable: string; argv_shape: readonly string[]; actions: Set<string> }
  >();

  const advisoryAllowlist: Readonly<Record<string, string>> = {
    'packages/cli/src/authority/index.ts':
      'Authority wrapper preserves receiver semantics while installing the verified host-effect scope.',
    'packages/authority/src/boundaries/host-effects.ts':
      'The authority seam is the audited implementation boundary for wrapped host functions.',
    'packages/cli/src/commands/mutation/run.ts':
      'Mutation adapter loads the previously resolved local runner URL; runtime charter and authority checks precede execution.',
  };
  for (const sourceFile of sourceFiles) {
    const packageSuffix = sourceFile.fileName.split('/packages/')[1];
    const relative =
      packageSuffix === undefined ? sourceFile.fileName : `packages/${packageSuffix}`;
    const scanAdvisory = (node: ts.Node): void => {
      let pattern: string | undefined;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        literalText(node.arguments[0]) === undefined
      ) {
        pattern = 'non-literal dynamic import';
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'eval'
      ) {
        pattern = 'eval';
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Function'
      ) {
        pattern = 'new Function';
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === 'Reflect' &&
        ['apply', 'construct'].includes(node.expression.name.text) &&
        literalText(node.arguments[0]) === undefined
      ) {
        pattern = `Reflect.${node.expression.name.text} with a non-literal target`;
      }
      if (pattern !== undefined) {
        const edge = `${relative}:${String(sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1)}:${pattern}`;
        const reason = advisoryAllowlist[relative];
        if (reason === undefined) {
          findings.push({
            code: 'EFFECT_UNANALYZABLE_PATTERN',
            message: `${pattern} at ${edge} is outside the audited advisory allowlist.`,
          });
        } else {
          advisoryDispositions.push({ edge, reason });
        }
      }
      ts.forEachChild(node, scanAdvisory);
    };
    scanAdvisory(sourceFile);
  }
  for (const [action, handlers] of selectedEntries) {
    const capabilities = new Set<EffectCapability>();
    const dispositions = new Map<string, EffectDisposition>();
    const visited = new Set<string>();
    const queue: ts.Node[] = [...handlers];

    const enqueueSymbol = (node: ts.Node): boolean => {
      const symbol = symbolAt(checker, node);
      let found = false;
      for (const declaration of symbol?.declarations ?? []) {
        for (const fn of functionsFromDeclaration(declaration)) {
          queue.push(fn);
          found = true;
        }
      }
      return found;
    };

    while (queue.length > 0) {
      const node = queue.pop();
      if (node === undefined) continue;
      const key = `${node.getSourceFile().fileName}:${String(node.pos)}:${String(node.end)}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const walk = (child: ts.Node): void => {
        if (child !== node && ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child) && child.expression !== undefined) {
          enqueueSymbol(child.expression);
        }
        if (ts.isCallExpression(child) || ts.isNewExpression(child)) {
          const expression = child.expression;
          const argumentsList = child.arguments ?? [];
          const nameNode = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
          const callName = ts.isPropertyAccessExpression(expression)
            ? expression.name.text
            : ts.isIdentifier(expression)
              ? expression.text
              : expression.getText().slice(0, 80);
          const symbol = symbolAt(checker, nameNode);
          const declarations = symbol?.declarations ?? [];
          const declarationFiles = declarations.map(
            (declaration) => declaration.getSourceFile().fileName,
          );
          const seam = declarationFiles.some((file) => file.endsWith('authority-host-effects.ts'));
          const directCommandService =
            callName === 'invokeCommandService' &&
            declarationFiles.some((file) => file.endsWith('/commands/evidence/direct-command.ts'));
          const nodeFs = declarationFiles.some((file) => file.includes('@types/node/fs'));
          const nodeProc = declarationFiles.some((file) =>
            file.includes('@types/node/child_process'),
          );
          const pg = declarationFiles.some(
            (file) => file.includes('/pg/') || file.includes('@types/pg'),
          );
          if ((seam || nodeFs) && FS_MUTATORS.has(callName)) capabilities.add('fs:unknown-write');
          if (pg && ['connect', 'end', 'query', 'Pool', 'Client'].includes(callName)) {
            capabilities.add('db:unclassified');
          }
          if (
            PROCESS_CALLS.has(callName) &&
            (nodeProc || seam || UNAMBIGUOUS_PROCESS_CALLS.has(callName))
          ) {
            const executable = literalText(argumentsList[0]);
            const shape = argvShape(argumentsList[1]);
            const proc =
              `proc:${executable?.replace(/[^a-z0-9-]/giu, '-').toLowerCase() || 'dynamic'}` as const;
            capabilities.add(proc);
            const registered =
              executable !== undefined &&
              input.subprocessRegistry.templates.some(
                (template) =>
                  template.executable === executable &&
                  JSON.stringify(template.argv_shape) === JSON.stringify(shape),
              );
            if (executable === undefined) {
              const edge = `${child.getSourceFile().fileName}:${String(child.getStart())}:${callName}`;
              dispositions.set(edge, {
                edge,
                reason: `Dynamic subprocess executable with argv shape ${JSON.stringify(shape)}; conservatively classified proc:dynamic and requires runtime-seam enforcement.`,
              });
            } else {
              const templateKey = JSON.stringify([executable, shape]);
              const template = subprocesses.get(templateKey) ?? {
                executable,
                argv_shape: shape,
                actions: new Set<string>(),
              };
              template.actions.add(action);
              subprocesses.set(templateKey, template);
            }
            if (!registered && executable !== undefined) {
              findings.push({
                code: 'SPAWN_EFFECT_UNDECLARED',
                action_id: action,
                message: `${callName} template ${executable} ${JSON.stringify(shape)} is absent from the subprocess registry.`,
              });
            }
          }
          let reached = false;
          if (directCommandService) {
            const edge = `${child.getSourceFile().fileName}:${String(child.getStart())}:${callName}`;
            dispositions.set(edge, {
              edge,
              reason:
                'Canonical evidence facade invokes a statically selected in-process command definition through the authority-enforced direct-command adapter.',
            });
            reached = true;
          } else {
            for (const declaration of declarations) {
              for (const fn of functionsFromDeclaration(declaration)) {
                queue.push(fn);
                reached = true;
              }
            }
            for (const argument of argumentsList) {
              if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
                queue.push(argument);
                reached = true;
              } else if ((symbolAt(checker, argument)?.flags ?? 0) & FUNCTION_FLAGS) {
                reached = enqueueSymbol(argument) || reached;
              }
            }
          }
          if (
            !reached &&
            ts.isPropertyAccessExpression(expression) &&
            declarations.some((declaration) => !declaration.getSourceFile().isDeclarationFile)
          ) {
            const candidates = allMethods.get(expression.name.text) ?? [];
            if (candidates.length > 0) {
              queue.push(...candidates);
              reached = true;
            }
          }
          if (
            !reached &&
            declarations.some((declaration) => !declaration.getSourceFile().isDeclarationFile)
          ) {
            const edge = `${child.getSourceFile().fileName}:${String(child.getStart())}:${callName}`;
            dispositions.set(edge, {
              edge,
              reason:
                'In-program declaration has no executable body; conservatively classified through same-name method expansion when available.',
            });
          }
        }
        ts.forEachChild(child, walk);
      };
      walk(node);
    }

    const declared = contracts.get(action)?.capabilities ?? [];
    const normalized = [...capabilities].map((capability): EffectCapability => {
      if (capability === 'fs:unknown-write') {
        return (
          (declared.find((item) => item.startsWith('fs:')) as EffectCapability | undefined) ??
          capability
        );
      }
      if (capability === 'db:unclassified') {
        return (
          (declared.find((item) => item.startsWith('db:')) as EffectCapability | undefined) ??
          capability
        );
      }
      return capability;
    });
    const missingDomains = normalized.filter(
      (capability) =>
        !declared.includes(capability) &&
        !declared.some((candidate) => candidate.split(':')[0] === capability.split(':')[0]),
    );
    if (missingDomains.length > 0) {
      findings.push({
        code: 'EFFECT_UNDER_DECLARED',
        action_id: action,
        message: `Inferred capabilities not covered by the declaration: ${missingDomains.join(', ')}.`,
      });
    }
    actions[action] = {
      declared_effect: contracts.get(action)?.effect ?? '<missing>',
      declared_capabilities: declared,
      capabilities: [...new Set(normalized)].sort(),
      unresolved_edges: [],
      dispositions: [...dispositions.values()].sort((a, b) => a.edge.localeCompare(b.edge)),
    };
  }

  return {
    actions,
    findings,
    subprocess_templates: [...subprocesses.values()]
      .map((template) => ({
        executable: template.executable,
        argv_shape: template.argv_shape,
        actions: [...template.actions].sort(),
      }))
      .sort((a, b) =>
        `${a.executable}:${JSON.stringify(a.argv_shape)}`.localeCompare(
          `${b.executable}:${JSON.stringify(b.argv_shape)}`,
        ),
      ),
    advisory_patterns: {
      violations: findings.filter((finding) => finding.code === 'EFFECT_UNANALYZABLE_PATTERN')
        .length,
      dispositions: advisoryDispositions.sort((a, b) => a.edge.localeCompare(b.edge)),
    },
    metrics: {
      program_files: sourceFiles.length,
      catalog_actions: input.catalog.length,
      extracted_actions: selectedEntries.size,
      unresolved_edges: 0,
      dispositioned_edges: Object.values(actions).reduce(
        (total, action) => total + action.dispositions.length,
        0,
      ),
      duration_ms: Math.round(performance.now() - started),
    },
  };
}

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
