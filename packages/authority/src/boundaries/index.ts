import { resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import ts from 'typescript';
import { failure, isRecord, success } from '../runtime/contracts.js';
export { createAuthorityBoundaryRuntime } from './boundary-runtime.js';

export {
  classifyAuthorityResource,
  protectedReleaseBoundaryAdapterId,
} from './resource-classification.js';

const MUTATORS = new Set([
  'appendFile',
  'appendFileSync',
  'chmodSync',
  'closeSync',
  'copyFileSync',
  'cpSync',
  'execFile',
  'execFileSync',
  'fsyncSync',
  'link',
  'linkSync',
  'mkdir',
  'mkdirSync',
  'mkdtempSync',
  'openSync',
  'publishFileNoReplaceSync',
  'removeEntryIfIdentitySync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'rmdir',
  'rmdirSync',
  'spawn',
  'spawnSync',
  'symlinkSync',
  'unlink',
  'unlinkSync',
  'writeFile',
  'writeFileSync',
  'writeSync',
]);
const HOST_SCOPE_CONTROLLER = 'runWithAuthorityHostEffects';
const HOST_SCOPE_OWNERS = new Set([
  'packages/cli/src/authority/index.ts',
  'packages/cli/src/authority/broker.ts',
]);
const ATOMIC_HOST_EFFECTS_CONTROLLER = 'applyAuthorityHostEffectsAtomically';
const ATOMIC_HOST_EFFECTS_OWNER = 'packages/cli/src/authority/broker.ts';
const READ_PROCESS_EXCEPTION = 'readProcessSync';
const READ_PROCESS_OWNERS = new Set([
  'packages/cli/src/version.ts',
  'packages/loop/src/governance-ledger/history.ts',
]);
const GIT_READ_OWNERS: Readonly<Record<string, ReadonlySet<string>>> = {
  readGitObjectSync: new Set<string>(),
  readCheckPolicyGitSync: new Set(['packages/cli/src/services/check-runner/policy-git.ts']),
  readExactGitTreeSync: new Set([
    'packages/cli/src/services/check-runner/authority-process.ts',
    'packages/cli/src/services/release-certification-provider-requests.ts',
    // ADR-CHK-0007 rule 5: the check runner reads test-task-exclusivity.json only as the
    // committed bytes at the planned commit, never from the working tree.
    'packages/cli/src/services/check-runner/runner-schedule.ts',
  ]),
};
const DIRECTORY_FLUSH_EXCEPTION = 'flushDirectoryEntrySync';
const DIRECTORY_FLUSH_OWNER = 'packages/loop/src/loop/state-root.ts';
const HOST_EFFECTS_MODULE = '@devai-nyx/authority';
const CANONICAL_SOURCE_ROOTS = [
  'packages/authority/src',
  'packages/cli/src',
  'packages/effects-check/src',
  'packages/evidence/src',
  'packages/loop/src',
  'packages/sensors/src',
  'packages/skills/src',
  'packages/spec/src',
  'packages/utils/src',
] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (relative: string): void => {
    const absolute = resolvePath(root, relative);
    for (const entry of readdirSync(absolute).sort()) {
      const child = relative.length === 0 ? entry : `${relative}/${entry}`;
      const childAbsolute = resolvePath(root, child);
      if (statSync(childAbsolute).isDirectory()) visit(child);
      else if (entry.endsWith('.ts')) files.push(child);
    }
  };
  visit('');
  return files;
}

function unauthorizedMutatorCalls(
  source: string,
  fileName: string,
): Array<{ line: number; symbol: string }> {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imported = new Map<string, string>();
  const importedNames = new Map<string, string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause
    )
      continue;
    const moduleName = statement.moduleSpecifier.text;
    const bindings = statement.importClause.namedBindings;
    if (statement.importClause.name) imported.set(statement.importClause.name.text, moduleName);
    if (bindings && ts.isNamespaceImport(bindings)) imported.set(bindings.name.text, moduleName);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imported.set(element.name.text, moduleName);
        importedNames.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  const calls: Array<{ line: number; symbol: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const symbol = ts.isIdentifier(expression)
        ? (importedNames.get(expression.text) ?? expression.text)
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      if (symbol && MUTATORS.has(symbol)) {
        const owner = ts.isIdentifier(expression)
          ? imported.get(expression.text)
          : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
            ? imported.get(expression.expression.text)
            : undefined;
        if (owner !== HOST_EFFECTS_MODULE) {
          calls.push({
            line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            symbol,
          });
        }
      }
      const importedSymbol = ts.isIdentifier(expression)
        ? (importedNames.get(expression.text) ?? expression.text)
        : symbol;
      const gitReadOwners =
        importedSymbol !== undefined && Object.hasOwn(GIT_READ_OWNERS, importedSymbol)
          ? GIT_READ_OWNERS[importedSymbol]
          : undefined;
      const importedModule = ts.isIdentifier(expression)
        ? imported.get(expression.text)
        : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
          ? imported.get(expression.expression.text)
          : undefined;
      if (
        importedSymbol !== undefined &&
        gitReadOwners !== undefined &&
        (!gitReadOwners.has(fileName) || importedModule !== HOST_EFFECTS_MODULE)
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: importedSymbol,
        });
      }
      if (
        importedSymbol === HOST_SCOPE_CONTROLLER &&
        (!HOST_SCOPE_OWNERS.has(fileName) || importedModule !== HOST_EFFECTS_MODULE)
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: HOST_SCOPE_CONTROLLER,
        });
      }
      if (
        importedSymbol === ATOMIC_HOST_EFFECTS_CONTROLLER &&
        (fileName !== ATOMIC_HOST_EFFECTS_OWNER || importedModule !== HOST_EFFECTS_MODULE)
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: ATOMIC_HOST_EFFECTS_CONTROLLER,
        });
      }
      if (
        importedSymbol === READ_PROCESS_EXCEPTION &&
        (!READ_PROCESS_OWNERS.has(fileName) || importedModule !== HOST_EFFECTS_MODULE)
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: READ_PROCESS_EXCEPTION,
        });
      }
      if (
        importedSymbol === DIRECTORY_FLUSH_EXCEPTION &&
        (fileName !== DIRECTORY_FLUSH_OWNER || importedModule !== HOST_EFFECTS_MODULE)
      ) {
        calls.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          symbol: DIRECTORY_FLUSH_EXCEPTION,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

export function validateDirectMutatorInventory(input: unknown) {
  if (!isRecord(input) || !isRecord(input.inventory) || !Array.isArray(input.inventory.entries)) {
    return failure('usage-error', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_INVALID');
  }
  const unauthorized: Array<{ path: string; line: number; symbol: string }> = [];
  if (typeof input.repo_root === 'string') {
    for (const sourceRoot of CANONICAL_SOURCE_ROOTS) {
      const absoluteRoot = resolvePath(input.repo_root, sourceRoot);
      if (!existsSync(absoluteRoot)) continue;
      for (const relative of sourceFiles(absoluteRoot)) {
        const path = `${sourceRoot}/${relative}`;
        const source = readFileSync(resolvePath(absoluteRoot, relative), 'utf8');
        for (const call of unauthorizedMutatorCalls(source, path)) {
          unauthorized.push({ path, ...call });
        }
      }
    }
  }
  if (isRecord(input.virtual_sources)) {
    for (const [path, source] of Object.entries(input.virtual_sources)) {
      if (typeof source !== 'string') continue;
      for (const call of unauthorizedMutatorCalls(source, path))
        unauthorized.push({ path, ...call });
    }
  }
  if (unauthorized.length > 0) {
    return { ...failure('refused', 'AUTHORITY_DIRECT_MUTATOR_INVENTORY_STALE'), unauthorized };
  }
  return success({
    unauthorized_call_sites: 0,
    wildcard_exemptions: input.inventory.totals?.exemptions ?? 0,
  });
}
