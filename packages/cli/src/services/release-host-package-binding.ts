import { bindSchemaPackageSnapshot } from '@devai-nyx/schemas';
import { assertBundledSensorRegistry } from '@devai-nyx/sensors';
import { assertBundledSensePresets } from '@devai-nyx/sensors/presets';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { bindMutationEvidenceV21PackageSnapshot } from './mutation-evidence-v21.js';
import {
  isVerifiedReleasePackageSnapshot,
  type ReleasePackageSnapshot,
} from './release-package-snapshot.js';

let bound = false;

function bindCompilerLibraries(snapshot: ReleasePackageSnapshot): void {
  const prefix = 'dist/runtime/index/';
  const declaration = JSON.parse(
    snapshot.read(`${prefix}typescript-libraries.json`).toString('utf8'),
  ) as {
    readonly schemaVersion: string;
    readonly compiler_version: string;
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
  };
  const names = snapshot.manifest
    .map((entry) => entry.path)
    .filter(
      (path) =>
        path.startsWith(prefix) && /^lib(?:\.[a-z0-9-]+)*\.d\.ts$/u.test(path.slice(prefix.length)),
    )
    .map((path) => path.slice(prefix.length))
    .sort();
  if (
    declaration.schemaVersion !== '1.0.0' ||
    declaration.compiler_version !== ts.version ||
    !names.includes('lib.d.ts') ||
    JSON.stringify(declaration.files.map((entry) => entry.path)) !== JSON.stringify(names)
  )
    throw new Error('rpl-package-identity-mismatch');
  const libraries = new Map(
    declaration.files.map((entry) => {
      const bytes = snapshot.read(`${prefix}${entry.path}`);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
        throw new Error('rpl-package-identity-mismatch');
      return [entry.path, new TextDecoder('utf-8', { fatal: true }).decode(bytes)];
    }),
  );
  const directory = dirname(fileURLToPath(import.meta.url));
  if (basename(directory) !== 'index' || basename(dirname(directory)) !== 'runtime')
    throw new Error('rpl-package-identity-mismatch');
  const libraryName = (path: string): string | undefined => {
    const absolute = resolve(path);
    const name = basename(absolute);
    return dirname(absolute) === directory && /^lib(?:\.[a-z0-9-]+)*\.d\.ts$/u.test(name)
      ? name
      : undefined;
  };
  const read = ts.sys.readFile;
  const exists = ts.sys.fileExists;
  // Only compiler-owned built-in libraries change read source. Candidate files
  // retain their existing behavior; no global filesystem hook or write grant.
  ts.sys.readFile = (path, encoding) => {
    const name = libraryName(path);
    return name === undefined ? read(path, encoding) : libraries.get(name);
  };
  ts.sys.fileExists = (path) => {
    const name = libraryName(path);
    return name === undefined ? exists(path) : libraries.has(name);
  };
}

/**
 * Called only by trusted host startup after loading the monolithic runtime from
 * this exact approved snapshot. A brand alone does not prove loaded-code identity.
 * Binding is permanent; late, repeated or partially failed startup cannot fall
 * back to ambient package data. No invocation/candidate field reaches this seam.
 */
export function bindReleaseHostPackageSnapshot(snapshot: ReleasePackageSnapshot): void {
  if (bound || !isVerifiedReleasePackageSnapshot(snapshot))
    throw new Error('rpl-package-identity-mismatch');
  bound = true;
  try {
    assertBundledSensorRegistry(snapshot.read('dist/runtime/index/sensor-registry.json'));
    assertBundledSensePresets(snapshot.read('dist/runtime/index/sense-presets.json'));
    const prefix = 'dist/runtime/index/schemas/';
    const schemas = new Map(
      snapshot.manifest
        .filter((entry) => entry.path.startsWith(prefix))
        .map((entry) => [entry.path.slice(prefix.length), snapshot.read(entry.path)]),
    );
    bindSchemaPackageSnapshot({
      schemas,
      sensor_registry: snapshot.read('dist/runtime/index/sensor-registry.json'),
    });
    bindCompilerLibraries(snapshot);
    bindMutationEvidenceV21PackageSnapshot(snapshot);
  } catch {
    throw new Error('rpl-package-identity-mismatch');
  }
}
