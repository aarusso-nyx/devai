#!/usr/bin/env node
import { existsSync, globSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseDocument } from 'yaml';

// Inspect execution surfaces, not report names or ordinary source-write tests.
// This is a static regression guard, not a sandbox for arbitrary dynamic code.
const engine = /(?:^|\/)stryker(?:\.cmd|\.js)?$|^@stryker-mutator\/core(?:@[^/\s]+)?$/u;
const executionFile = /(?:^|\/)mutation-(?:production|diagnostic)\.mjs$/u;
const scriptExtension = /\.(?:[cm]?[jt]s|tsx|sh|bash|py)$/u;
const tokens = (value) =>
  String(value)
    .match(/"[^"\n]*"|'[^'\n]*'|[;&|]+|[^\s;&|()]+/gu)
    ?.map((word) => word.replace(/^["']|["']$/gu, '')) ?? [];
const invokesMutation = (argv) =>
  argv.some(
    (word, index) =>
      (engine.test(word) && argv[index + 1] === 'run') ||
      (/(?:^|\/)bedel(?:\.cmd)?$/u.test(word) && ['run', 'resume'].includes(argv[index + 1])) ||
      /^test:mutation$/u.test(word) ||
      executionFile.test(word),
  );

export function checkMutationFreeDelivery(root) {
  root = resolve(root);
  const violations = new Set();
  const scriptsSeen = new Set();
  const workflowsSeen = new Set();
  const label = (file) => relative(root, file).split('\\').join('/');
  const report = (file, detail) => violations.add(`${label(file)}: ${detail}`);
  const inside = (file) => {
    const path = relative(root, file);
    return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
  };
  function yaml(file) {
    const document = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
    if (document.errors.length) {
      report(file, 'invalid YAML');
      return {};
    }
    return document.toJS() ?? {};
  }
  function localFile(value, cwd) {
    if (typeof value !== 'string' || /[$*{}]/u.test(value)) return undefined;
    const file = resolve(cwd, value);
    return inside(file) && existsSync(file) ? file : undefined;
  }
  function command(value, file, cwd) {
    const argv = Array.isArray(value)
      ? value.filter((part) => typeof part === 'string')
      : tokens(value);
    if (invokesMutation(argv)) report(file, 'mutation execution');
    // Follow concrete script paths passed to interpreters, shell sources, and
    // direct script invocations. Test-file arguments are not executable wrappers.
    const words = ['node', 'tsx', 'ts-node', 'python', 'python3', 'bash', 'sh', 'source', '.'];
    for (let index = 0; index < argv.length; index++) {
      const word = argv[index];
      if (words.includes(word)) {
        for (let next = index + 1; next < argv.length; next++) {
          if (['-e', '-c', '--eval'].includes(argv[next])) {
            command(argv[next + 1] ?? '', file, cwd);
            break;
          }
          if (argv[next].startsWith('-')) continue;
          const target = localFile(argv[next], cwd);
          if (target && scriptExtension.test(target)) script(target, cwd);
          break;
        }
      } else if (
        (index === 0 || ['&&', ';', '|'].includes(argv[index - 1])) &&
        scriptExtension.test(word)
      ) {
        const target = localFile(word, cwd);
        if (target) script(target, cwd);
      }
    }
  }
  function literal(node) {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) {
      const values = node.elements.map(literal);
      return values.every((value) => typeof value === 'string') ? values : undefined;
    }
    return undefined;
  }
  function script(file, cwd) {
    const key = `${file}\0${cwd}`;
    if (scriptsSeen.has(key)) return;
    scriptsSeen.add(key);
    const source = readFileSync(file, 'utf8');
    if (/\.(?:sh|bash)$/u.test(file)) {
      for (const line of source.split('\n'))
        if (!line.trimStart().startsWith('#')) command(line, file, cwd);
      return;
    }
    if (/\.py$/u.test(file)) {
      // Python wrappers commonly pass a literal command list to subprocess.
      // Only inspect process calls; fixtures and error messages remain data.
      for (const match of source.matchAll(
        /(?:subprocess\.(?:run|Popen|call|check_call|check_output)|os\.system)\s*\(\s*(\[[\s\S]*?\]|'[^']*'|"[^"]*")/gu,
      )) {
        const argv = [...match[1].matchAll(/['"]([^'"]*)['"]/gu)].map((part) => part[1]);
        command(match[1].startsWith('[') ? argv : (argv[0] ?? ''), file, cwd);
      }
      return;
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteralLike(specifier)) {
          if (specifier.text.startsWith('@stryker-mutator/'))
            report(file, 'mutation engine import');
          if (specifier.text.startsWith('.')) {
            const dependency = localFile(specifier.text, dirname(file));
            if (dependency && scriptExtension.test(dependency)) script(dependency, cwd);
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : '';
        if (
          [
            'spawn',
            'spawnSync',
            'exec',
            'execSync',
            'execFile',
            'execFileSync',
            'execa',
            'execaSync',
          ].includes(name)
        ) {
          const first = node.arguments[0] && literal(node.arguments[0]);
          const second = node.arguments[1] && literal(node.arguments[1]);
          if (typeof first === 'string')
            command(Array.isArray(second) ? [first, ...second] : first, file, cwd);
        }
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === 'require') {
          const specifier = node.arguments[0] && literal(node.arguments[0]);
          if (typeof specifier === 'string' && specifier.startsWith('@stryker-mutator/'))
            report(file, 'mutation engine import');
          if (typeof specifier === 'string' && specifier.startsWith('.')) {
            const dependency = localFile(specifier, dirname(file));
            if (dependency && scriptExtension.test(dependency)) script(dependency, cwd);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  function workflow(file) {
    if (workflowsSeen.has(file)) return;
    workflowsSeen.add(file);
    const document = yaml(file);
    function uses(value) {
      if (typeof value !== 'string' || !value.startsWith('./')) return;
      const path = resolve(root, value);
      if (!inside(path)) {
        report(file, 'local action escapes repository');
        return;
      }
      if (/\.ya?ml$/u.test(path) && existsSync(path)) {
        workflow(path);
        return;
      }
      const action = ['action.yml', 'action.yaml'].map((name) => join(path, name)).find(existsSync);
      if (action) workflow(action);
      else report(file, `unresolved local action ${value}`);
    }
    function steps(items, cwd) {
      for (const step of items ?? []) {
        if (step.run) {
          const body = step.run
            .replace(/\$\{\{\s*github\.action_path\s*\}\}/gu, dirname(file))
            .replace(/\$\{\{\s*github\.workspace\s*\}\}/gu, root);
          command(body, file, resolve(cwd, step['working-directory'] ?? '.'));
        }
        uses(step.uses);
      }
    }
    for (const job of Object.values(document.jobs ?? {})) {
      uses(job.uses);
      steps(
        job.steps,
        resolve(
          root,
          job.defaults?.run?.['working-directory'] ??
            document.defaults?.run?.['working-directory'] ??
            '.',
        ),
      );
    }
    if (document.runs?.using === 'composite') steps(document.runs.steps, root);
    for (const key of ['main', 'pre', 'post']) {
      const target = localFile(document.runs?.[key], dirname(file));
      if (target) script(target, root);
    }
  }
  const packageFile = join(root, 'package.json');
  const manifest = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : {};
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  const patterns = existsSync(workspaceFile)
    ? (yaml(workspaceFile).packages ?? [])
    : Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : (manifest.workspaces?.packages ?? ['packages/*']);
  const exclusions = [
    '**/node_modules/**',
    '**/.git/**',
    ...patterns
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => `${pattern.slice(1)}/package.json`),
  ];
  const manifests = new Set(existsSync(packageFile) ? [packageFile] : []);
  for (const pattern of patterns.filter((value) => !value.startsWith('!'))) {
    for (const name of globSync(`${pattern}/package.json`, { cwd: root, exclude: exclusions }))
      manifests.add(resolve(root, name));
  }
  for (const file of manifests) {
    const packageManifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const name of Object.keys(packageManifest[section] ?? {}))
        if (name.startsWith('@stryker-mutator/')) report(file, name);
    }
    for (const body of Object.values(packageManifest.scripts ?? {}))
      command(body, file, dirname(file));
  }
  for (const file of new Set([
    join(root, 'test-tasks.json'),
    ...[...manifests].map((file) => join(dirname(file), 'test-tasks.json')),
  ])) {
    if (!existsSync(file)) continue;
    const descriptor = JSON.parse(readFileSync(file, 'utf8'));
    for (const task of descriptor.tasks ?? []) {
      command(task.argv ?? [], file, resolve(root, task.cwd ?? '.'));
      if (
        task.runner === 'stryker' ||
        task.runner === 'stryker-v1' ||
        task.runner === 'mutation-v1'
      )
        report(file, `mutation runner ${task.nodeId}`);
    }
  }
  const directory = join(root, '.github/workflows');
  if (existsSync(directory))
    for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name)))
      workflow(join(directory, file));
  const result = [...violations].sort();
  return { ok: result.length === 0, violations: result };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkMutationFreeDelivery(resolve(import.meta.dirname, '..'));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
