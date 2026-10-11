import { isAbsolute, dirname, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { readCandidateFile } from '../audit-projection.js';
import type { ReviewedWorkflowStep } from './reviewed-workflow-steps.js';

/** Closed execution forms for adopter reviews; unsupported selectors keep the effect unknown. */
export function adopterWorkflowClosure(
  root: string,
  run: string,
  entry: ReviewedWorkflowStep,
  workingDirectory = '',
): readonly string[] | undefined {
  root = realpathSync(root);
  let runtime: 'node' | 'tsx' | undefined;
  const files = new Set<string>();
  const pending: string[] = [];
  const followed = new Set<string>();
  const add = (path: string): string => {
    const absolute = resolve(root, path);
    const rel = relative(resolve(root), absolute).split(sep).join('/');
    readCandidateFile(root, rel);
    if (!files.has(rel)) {
      files.add(rel);
      pending.push(rel);
    }
    return rel;
  };
  try {
    if (isAbsolute(workingDirectory) || workingDirectory.split('/').includes('..'))
      return undefined;
    const config = (directory: string): void => {
      for (const file of [
        'package.json',
        'pnpm-lock.yaml',
        'package-lock.json',
        'pnpm-workspace.yaml',
        '.npmrc',
        'tsconfig.json',
      ]) {
        const path = directory === '' ? file : `${directory}/${file}`;
        if (existsSync(resolve(root, path))) add(path);
      }
      for (const hook of ['.pnpmfile.cjs', 'pnpmfile.cjs', '.pnpmfile.js'])
        if (existsSync(resolve(root, hook))) throw new Error('unproved package hook');
    };
    const execute = (script: string, directory: string, stack: ReadonlySet<string>): void => {
      for (const physical of script.split('\n')) {
        const line = physical.trim();
        if (
          line === '' ||
          line.startsWith('#') ||
          line === 'set -e' ||
          line === 'set -euo pipefail'
        )
          continue;
        if (/[;&|`<>$()\\]/u.test(line)) throw new Error('unproved shell execution');
        const words = line.split(/\s+/u);
        if (words.some((word) => /['"]/u.test(word))) throw new Error('unproved shell quoting');
        const executable = words[0];
        if (executable === 'node' || executable === 'tsx') {
          if (runtime !== undefined && runtime !== executable)
            throw new Error('mixed runtime resolution');
          runtime = executable;
          const path = words[1];
          if (path === undefined || path.startsWith('-') || !/\.(?:[cm]?js|tsx?)$/u.test(path))
            throw new Error('unproved runtime selection');
          add(directory === '' ? path : `${directory}/${path}`);
          config(directory);
        } else if (executable === 'pnpm' || executable === 'npm') {
          config('');
          config(directory);
          let index = 1;
          if (words[index] === '--dir' || words[index] === '--prefix')
            throw new Error('unproved package directory selector');
          if (words[index] === 'run' || words[index] === 'run-script') index += 1;
          const name = words[index];
          if (name === undefined || words.length !== index + 1 || !/^[a-z][\w:.-]*$/u.test(name))
            throw new Error('unproved package invocation');
          const manifestPath = directory === '' ? 'package.json' : `${directory}/package.json`;
          const manifest = JSON.parse(readCandidateFile(root, manifestPath).toString('utf8')) as {
            scripts?: Record<string, unknown>;
          };
          const key = `${directory}:${name}`;
          if (stack.has(key)) throw new Error('recursive package invocation');
          const next = new Set(stack);
          next.add(key);
          for (const scriptName of [`pre${name}`, name, `post${name}`]) {
            const body = manifest.scripts?.[scriptName];
            if (body === undefined && scriptName !== name) continue;
            if (typeof body !== 'string') throw new Error('missing package script');
            execute(body, directory, next);
          }
        } else throw new Error('unproved executable');
      }
    };
    execute(run, workingDirectory, new Set());
    for (let index = 0; index < pending.length; index += 1) {
      const file = pending[index];
      if (file === undefined || followed.has(file)) continue;
      followed.add(file);
      const bytes = readCandidateFile(root, file).toString('utf8');
      if (!/\.(?:[cm]?js|[jt]sx?)$/u.test(file)) continue;
      const parsed = ts.createSourceFile(file, bytes, ts.ScriptTarget.Latest, true);
      if (
        (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
          .length > 0
      )
        return undefined;
      const compilerConfig = ts.findConfigFile(dirname(resolve(root, file)), ts.sys.fileExists);
      let options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext };
      if (compilerConfig !== undefined) {
        add(relative(root, compilerConfig).split(sep).join('/'));
        const loaded = ts.readConfigFile(compilerConfig, ts.sys.readFile);
        if (loaded.error !== undefined || loaded.config.extends !== undefined) return undefined;
        options = ts.parseJsonConfigFileContent(
          loaded.config,
          ts.sys,
          dirname(compilerConfig),
        ).options;
      }
      const module = (specifier: string): void => {
        const builtin = specifier.replace(/^node:/u, '');
        if (['child_process', 'module', 'vm', 'worker_threads'].includes(builtin))
          throw new Error('unproved executable builtin capability');
        if (builtinModules.includes(builtin)) return;
        let actual: string | undefined;
        if (runtime === 'node' && specifier.startsWith('.')) {
          const exact = resolve(root, dirname(file), specifier);
          if (existsSync(exact)) actual = exact;
        } else if (runtime === 'tsx') {
          actual = ts.resolveModuleName(specifier, resolve(root, file), options, ts.sys)
            .resolvedModule?.resolvedFileName;
        } else {
          // Bare workspace/package resolution can select different import/require exports.
          throw new Error('unproved runtime package resolution');
        }
        if (actual === undefined) throw new Error('unresolved import');
        const lexicalRelative = relative(root, actual);
        if (
          lexicalRelative === '..' ||
          lexicalRelative.startsWith(`..${sep}`) ||
          isAbsolute(lexicalRelative)
        )
          throw new Error('unbound external import');
        // Inspect the lexical import path before realpath can erase a symlink component.
        readCandidateFile(root, lexicalRelative.split(sep).join('/'));
        const real = realpathSync(actual);
        const rel = relative(root, real);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw new Error('unbound external import');
        if (rel.split(sep).includes('node_modules')) {
          // Installed dependency bytes are selected by the reviewed root lock and manifest.
          if (
            !files.has('package.json') ||
            !['pnpm-lock.yaml', 'package-lock.json'].some((path) => files.has(path))
          )
            throw new Error('unbound external dependency');
          return;
        }
        add(rel.split(sep).join('/'));
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression))
          throw new Error('unproved computed executor');
        if (
          ts.isPropertyAccessExpression(node) &&
          ['mainModule', 'binding', '_linkedBinding', 'dlopen', 'constructor'].includes(
            node.name.text,
          )
        )
          throw new Error('unproved runtime loader capability');
        if (
          ts.isIdentifier(node) &&
          [
            'require',
            'createRequire',
            'exec',
            'execSync',
            'execFile',
            'execFileSync',
            'spawn',
            'spawnSync',
            'Worker',
            'eval',
            'Function',
          ].includes(node.text)
        ) {
          const parent = node.parent;
          const directRequire =
            node.text === 'require' && ts.isCallExpression(parent) && parent.expression === node;
          if (!directRequire) throw new Error('unproved loader or executor alias');
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          [
            'exec',
            'execSync',
            'execFile',
            'execFileSync',
            'spawn',
            'spawnSync',
            'Worker',
            'createRequire',
          ].includes(node.name.text)
        )
          throw new Error('unproved child executor');

        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
          if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly !== true)
            module(node.moduleSpecifier.text);
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          const specifier = node.arguments[0];
          if (specifier !== undefined && ts.isStringLiteralLike(specifier)) module(specifier.text);
          else {
            const cover = entry.computed_imports?.find((item) => item.from === file);
            if (cover === undefined) throw new Error('unreviewed computed import');
            for (const path of cover.files) add(path);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    }
    return [...files].sort();
  } catch {
    return undefined;
  }
}
