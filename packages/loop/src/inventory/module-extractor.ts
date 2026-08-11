import { relative } from 'node:path';
import { iterateClassDecorators, parseSourceFile, className } from './ts-ast.js';
import { deriveInventoryId } from './id.js';
import { walkFiles } from './walker.js';

export interface ModuleRecord {
  readonly id: string;
  readonly kind: 'nestjs_module' | 'ngmodule';
  readonly name: string;
  readonly path: string;
}

export interface ExtractModulesOptions {
  readonly repoRoot: string;
  /** Directory to scan; defaults to `repoRoot`. */
  readonly dir?: string;
  /** Extra directory names to skip (added to DEFAULT_IGNORE). */
  readonly ignoreDirs?: ReadonlySet<string>;
}

const MODULE_DECORATORS = new Map<string, ModuleRecord['kind']>([
  ['Module', 'nestjs_module'],
  ['NgModule', 'ngmodule'],
]);

export function extractModules(opts: ExtractModulesOptions): readonly ModuleRecord[] {
  const dir = opts.dir ?? opts.repoRoot;
  const files = walkFiles(dir, { extensions: ['.ts'], ignoreDirs: opts.ignoreDirs });
  const records: ModuleRecord[] = [];
  for (const file of files) {
    if (file.endsWith('.d.ts')) continue;
    let sourceFile;
    try {
      sourceFile = parseSourceFile(file);
    } catch {
      continue;
    }
    for (const { class: cls, name } of iterateClassDecorators(sourceFile)) {
      const kind = MODULE_DECORATORS.get(name);
      if (kind === undefined) continue;
      const rel = relative(opts.repoRoot, file);
      const moduleName = className(cls);
      records.push({
        id: deriveInventoryId('MOD', `${kind}:${rel}:${moduleName}`),
        kind,
        name: moduleName,
        path: rel,
      });
    }
  }
  // Sort by id for determinism.
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
