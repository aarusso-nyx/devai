import { relative } from 'node:path';
import { iterateClassDecorators, parseSourceFile, className } from './ts-ast.js';
import { deriveInventoryId } from './id.js';
import { walkFiles } from './walker.js';

export interface ComponentRecord {
  readonly kind: string;
  readonly name: string;
  readonly module: string;
  readonly path: string;
}

export interface ExtractComponentsOptions {
  readonly repoRoot: string;
  readonly dir?: string;
  readonly ignoreDirs?: ReadonlySet<string>;
}

// Angular and NestJS class-level decorators worth surfacing as "components".
const COMPONENT_DECORATORS = new Map<string, string>([
  ['Component', 'angular_component'],
  ['Directive', 'angular_directive'],
  ['Pipe', 'angular_pipe'],
  ['Injectable', 'service'],
  ['Controller', 'nestjs_controller'],
]);

export function extractComponents(opts: ExtractComponentsOptions): readonly ComponentRecord[] {
  const dir = opts.dir ?? opts.repoRoot;
  const files = walkFiles(dir, { extensions: ['.ts'], ignoreDirs: opts.ignoreDirs });
  const records: ComponentRecord[] = [];

  for (const file of files) {
    if (file.endsWith('.d.ts')) continue;
    let sourceFile;
    try {
      sourceFile = parseSourceFile(file);
    } catch {
      continue;
    }
    for (const { class: cls, name } of iterateClassDecorators(sourceFile)) {
      const kind = COMPONENT_DECORATORS.get(name);
      if (kind === undefined) continue;
      const rel = relative(opts.repoRoot, file);
      const clsName = className(cls);
      // Synthesize a module id from the file's path so the FK on components
      // resolves coherently even when no @Module/@NgModule is colocated.
      const moduleId = deriveInventoryId('MOD', `module:${rel}`);
      records.push({ kind, name: clsName, module: moduleId, path: rel });
    }
  }

  return records.sort((a, b) =>
    a.path !== b.path ? (a.path < b.path ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
