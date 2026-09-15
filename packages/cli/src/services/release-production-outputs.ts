import { createHash } from 'node:crypto';
import { canonicalSha256 } from '@devai-nyx/utils';
import { canonicalContainerPath, type ContainerArchiveEntry } from './container-archive.js';
import type { TaskDescriptor } from './check-runner/types.js';

export interface ProtectedGeneratedNamespace {
  readonly task_node: string;
  readonly prefix: string;
  readonly required_paths: readonly string[];
  readonly package_manifest: string | null;
  readonly package_id: string | null;
  readonly execution_only: boolean;
  readonly input_digest_sha256: string;
}

const INVALID = 'release-certification-output-declaration-invalid';
function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID);
  return value as Readonly<Record<string, unknown>>;
}
function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(INVALID);
  return value as string[];
}
function beneath(path: string, prefix: string): boolean {
  return path.startsWith(`${prefix}/`);
}

/**
 * Resolve only the source-declared DEVAI build/typecheck namespace contracts. This reads exact
 * Git bytes, never evaluates package scripts, imports candidate modules, or discovers authority
 * from task-produced path lists. Closed dist prefixes include assembly's law/resources/runtime
 * populations, not just TypeScript outDir files. Unknown compiler layouts refuse.
 */
export function resolveProtectedGeneratedNamespaces(
  descriptor: TaskDescriptor,
  source: readonly ContainerArchiveEntry[],
): readonly ProtectedGeneratedNamespace[] {
  const files = new Map(source.map((entry) => [entry.path, entry]));
  const namespaces: ProtectedGeneratedNamespace[] = [];
  const read = (path: string) => {
    const file = files.get(path);
    if (file === undefined) throw new Error(INVALID);
    return object(JSON.parse(file.bytes.toString('utf8')) as unknown);
  };
  const digestInputs = (paths: readonly string[]) =>
    canonicalSha256(
      [...new Set(paths)].sort().map((path) => {
        const file = files.get(path);
        if (file === undefined) throw new Error(INVALID);
        return {
          path,
          mode: file.mode,
          sha256: createHash('sha256').update(file.bytes).digest('hex'),
        };
      }),
    );
  const base = () => {
    const options = object(read('tsconfig.base.json').compilerOptions);
    if (
      options.declaration !== true ||
      options.declarationMap !== true ||
      options.sourceMap !== true ||
      options.composite !== true ||
      options.incremental !== true ||
      options.module !== 'ESNext' ||
      options.target !== 'ES2023'
    )
      throw new Error(INVALID);
  };
  for (const task of descriptor.tasks) {
    const declared = task.outputContract.generated_namespaces;
    if (declared === undefined) continue;
    if (!Array.isArray(declared) || declared.length === 0) throw new Error(INVALID);
    for (const raw of declared) {
      const declaration = object(raw);
      const prefix = declaration.prefix;
      if (typeof prefix !== 'string' || !canonicalContainerPath(prefix)) throw new Error(INVALID);
      const required = new Set<string>();
      let packageManifest: string | null = null;
      let packageId: string | null = null;
      let executionOnly = true;
      let inputPaths: string[];
      if (declaration.derivation === 'devai-package-dist-v1') {
        packageManifest = String(declaration.package_manifest);
        if (!/^packages\/[^/]+\/package\.json$/u.test(packageManifest)) throw new Error(INVALID);
        const root = packageManifest.slice(0, -'/package.json'.length);
        if (prefix !== `${root}/dist`) throw new Error(INVALID);
        const manifest = read(packageManifest);
        if (typeof manifest.name !== 'string') throw new Error(INVALID);
        packageId = manifest.name;
        const config = read(`${root}/tsconfig.json`);
        const compiler = object(config.compilerOptions);
        base();
        if (
          config.extends !== '../../tsconfig.base.json' ||
          compiler.rootDir !== './src' ||
          compiler.outDir !== './dist' ||
          JSON.stringify(config.include) !== JSON.stringify(['src/**/*']) ||
          ['outFile', 'declarationDir', 'noEmit', 'emitDeclarationOnly', 'tsBuildInfoFile'].some(
            (key) => Object.hasOwn(compiler, key),
          )
        )
          throw new Error(INVALID);
        const build = object(manifest.scripts).build;
        const allowedBuilds = [
          'tsc -b',
          'tsc -b && node scripts/copy-law.mjs',
          'tsc -b && node scripts/copy-constitution.mjs && node scripts/copy-policy.mjs',
          'tsc -b --force && node scripts/assemble-package.mjs',
        ];
        if (typeof build !== 'string' || !allowedBuilds.includes(build)) throw new Error(INVALID);
        executionOnly = manifest.private === true;
        const compiled = !build.includes('assemble-package.mjs');
        inputPaths = [
          'tsconfig.base.json',
          packageManifest,
          `${root}/tsconfig.json`,
          ...[...files.keys()].filter(
            (path) =>
              beneath(path, `${root}/src`) ||
              beneath(path, `${root}/scripts`) ||
              beneath(path, `${root}/vendor`) ||
              beneath(path, 'packages/skills/resources') ||
              beneath(path, 'law'),
          ),
        ];
        if (compiled) {
          for (const path of files.keys()) {
            if (!beneath(path, `${root}/src`)) continue;
            if (path.endsWith('.d.ts') || path.endsWith('/.gitkeep')) continue;
            if (!path.endsWith('.ts')) throw new Error(INVALID);
            const stem = path.slice(`${root}/src/`.length, -'.ts'.length);
            for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map'])
              required.add(`${prefix}/${stem}${suffix}`);
          }
        } else {
          for (const path of files.keys()) {
            if (beneath(path, 'packages/skills/resources'))
              required.add(
                `${prefix}/resources/${path.slice('packages/skills/resources/'.length)}`,
              );
          }
        }
        const visitExports = (value: unknown) => {
          if (typeof value === 'string') {
            if (value.startsWith('./dist/') && !value.includes('*'))
              required.add(`${root}/${value.slice(2)}`);
          } else if (value !== null && typeof value === 'object') {
            for (const nested of Object.values(value)) visitExports(nested);
          }
        };
        for (const key of ['main', 'types', 'exports', 'bin']) visitExports(manifest[key]);
        for (const path of strings(declaration.required_artifacts ?? [])) {
          if (!canonicalContainerPath(path)) throw new Error(INVALID);
          required.add(`${prefix}/${path}`);
        }
      } else if (declaration.derivation === 'devai-cli-typecheck-v1') {
        if (prefix !== 'scratch/typecheck/cli') throw new Error(INVALID);
        const config = read('packages/cli/tsconfig.typecheck.json');
        const compiler = object(config.compilerOptions);
        base();
        if (
          config.extends !== './tsconfig.json' ||
          compiler.outDir !== '../../scratch/typecheck/cli' ||
          compiler.tsBuildInfoFile !== '../../scratch/typecheck/cli.tsbuildinfo' ||
          Object.keys(compiler).length !== 2
        )
          throw new Error(INVALID);
        inputPaths = [
          'tsconfig.base.json',
          'packages/cli/tsconfig.json',
          'packages/cli/tsconfig.typecheck.json',
          ...[...files.keys()].filter((path) => beneath(path, 'packages/cli/src')),
        ];
        for (const path of inputPaths.filter((path) => beneath(path, 'packages/cli/src'))) {
          if (path.endsWith('.d.ts') || path.endsWith('/.gitkeep')) continue;
          if (!path.endsWith('.ts')) throw new Error(INVALID);
          const stem = path.slice('packages/cli/src/'.length, -'.ts'.length);
          for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map'])
            required.add(`${prefix}/${stem}${suffix}`);
        }
      } else {
        throw new Error(INVALID);
      }
      if (
        required.size === 0 ||
        [...files.keys()].some((path) => path === prefix || beneath(path, prefix)) ||
        namespaces.some(
          (entry) =>
            entry.prefix === prefix ||
            beneath(entry.prefix, prefix) ||
            beneath(prefix, entry.prefix),
        ) ||
        [...required].some((path) => !canonicalContainerPath(path) || !beneath(path, prefix))
      )
        throw new Error(INVALID);
      namespaces.push({
        task_node: task.nodeId,
        prefix,
        required_paths: [...required].sort(),
        package_manifest: packageManifest,
        package_id: packageId,
        execution_only: executionOnly,
        input_digest_sha256: digestInputs(inputPaths),
      });
    }
  }
  return namespaces;
}
