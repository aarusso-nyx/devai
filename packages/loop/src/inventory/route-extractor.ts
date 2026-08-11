import { relative } from 'node:path';
import ts from 'typescript';
import {
  className,
  decoratorName,
  decoratorStringArg,
  iterateClassDecorators,
  iterateMethodDecorators,
  parseSourceFile,
} from './ts-ast.js';
import { deriveInventoryId } from './id.js';
import { walkFiles } from './walker.js';

export interface RouteRecord {
  readonly method: string;
  readonly path: string;
  readonly module: string;
  readonly auth?: string;
  readonly protected?: boolean;
}

export interface ExtractRoutesOptions {
  readonly repoRoot: string;
  readonly dir?: string;
  readonly ignoreDirs?: ReadonlySet<string>;
}

const HTTP_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Options',
  'Head',
  'All',
]);

export function extractRoutes(opts: ExtractRoutesOptions): readonly RouteRecord[] {
  const dir = opts.dir ?? opts.repoRoot;
  const files = walkFiles(dir, { extensions: ['.ts'], ignoreDirs: opts.ignoreDirs });
  const records: RouteRecord[] = [];

  for (const file of files) {
    if (file.endsWith('.d.ts')) continue;
    let sourceFile;
    try {
      sourceFile = parseSourceFile(file);
    } catch {
      continue;
    }

    // Identify controller classes (and their @Controller('<base>') path prefix).
    const controllers = new Map<string, { name: string; basePath: string; moduleId: string }>();
    for (const { class: cls, decorator, name } of iterateClassDecorators(sourceFile)) {
      if (name !== 'Controller') continue;
      const basePath = decoratorStringArg(decorator, 0) ?? '';
      const rel = relative(opts.repoRoot, file);
      const clsName = className(cls);
      controllers.set(clsName, {
        name: clsName,
        basePath,
        moduleId: deriveInventoryId('MOD', `nestjs_controller:${rel}:${clsName}`),
      });
    }

    for (const { class: cls, method, decorator, name } of iterateMethodDecorators(sourceFile)) {
      if (!HTTP_DECORATORS.has(name)) continue;
      const clsName = className(cls);
      const controller = controllers.get(clsName);
      if (controller === undefined) continue;
      const subPath = decoratorStringArg(decorator, 0) ?? '';
      const routePath = joinPath(controller.basePath, subPath);

      // Detect @UseGuards(...) on the same method as a hint for 'protected'.
      const protectedFlag = (method.modifiers ?? []).some((m) => {
        if (!ts.isDecorator(m)) return false;
        const dName = decoratorName(m);
        return dName === 'UseGuards' || dName === 'Auth';
      });

      records.push({
        method: name.toUpperCase(),
        path: routePath,
        module: controller.moduleId,
        ...(protectedFlag && { protected: true }),
      });
    }
  }

  return records.sort((a, b) =>
    a.method !== b.method
      ? a.method < b.method
        ? -1
        : 1
      : a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0,
  );
}

function joinPath(base: string, sub: string): string {
  const b = base.startsWith('/') ? base : `/${base}`;
  const s = sub.startsWith('/') ? sub.slice(1) : sub;
  if (s.length === 0) return b.length > 1 ? b : '/';
  return `${b.length > 1 ? b : ''}/${s}`;
}
