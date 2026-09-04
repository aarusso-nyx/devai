import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { satisfies, validRange } from 'semver';
import { canonicalJson } from '@devai-nyx/utils';
import { isJsonObject } from './adopter-policy.js';
import {
  isVerifiedReleasePackageSnapshot,
  type ReleasePackageSnapshot,
} from './release-package-snapshot.js';

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const LOCKS = ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml'] as const;
const INVALID = 'rpl-adopter-binding-mismatch';

export interface ReleaseLockfileBinding {
  readonly package_manager: 'npm' | 'pnpm';
  readonly package_manifest: { readonly path: 'package.json'; readonly sha256: string };
  readonly lockfiles: readonly { readonly path: string; readonly sha256: string }[];
}

function fail(): never {
  throw new Error(INVALID);
}
function object(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : fail();
}
function member(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** Root install lock population; nested independent projects do not resolve the root dependency. */
export function verifyReleasePolicyLockfiles(input: {
  readonly paths: readonly string[];
  readonly read: (path: string) => Buffer;
  readonly installed_package: ReleasePackageSnapshot;
  readonly require_installed_dependency: boolean;
}): ReleaseLockfileBinding {
  try {
    if (!isVerifiedReleasePackageSnapshot(input.installed_package)) return fail();
    if (
      input.paths.includes('yarn.lock') ||
      input.paths.includes('bun.lock') ||
      input.paths.includes('bun.lockb')
    )
      return fail();
    const hashes: { path: string; sha256: string }[] = [];
    const read = (path: string): Buffer => {
      if (!input.paths.includes(path)) return fail();
      const bytes = Buffer.from(input.read(path));
      hashes.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
      return bytes;
    };
    const decode = (bytes: Buffer): string => {
      const text = bytes.toString('utf8');
      return Buffer.from(text, 'utf8').equals(bytes) ? text : fail();
    };
    const manifest = object(JSON.parse(decode(read('package.json'))));
    const lockPaths = LOCKS.filter((path) => input.paths.includes(path));
    if (
      lockPaths.length === 0 ||
      (lockPaths.includes('npm-shrinkwrap.json') && lockPaths.includes('package-lock.json'))
    )
      return fail();
    const packageManager = member(manifest, 'packageManager');
    let manager: 'npm' | 'pnpm';
    if (
      typeof packageManager === 'string' &&
      /^pnpm@\d+\.\d+\.\d+(?:\+sha(?:256|512)\.[a-f0-9]+)?$/u.test(packageManager)
    )
      manager = 'pnpm';
    else if (
      typeof packageManager === 'string' &&
      /^npm@\d+\.\d+\.\d+(?:\+sha(?:256|512)\.[a-f0-9]+)?$/u.test(packageManager)
    )
      manager = 'npm';
    else if (packageManager === undefined && !lockPaths.includes('pnpm-lock.yaml')) manager = 'npm';
    else return fail();
    if (
      manager === 'pnpm'
        ? !lockPaths.includes('pnpm-lock.yaml')
        : !lockPaths.some((path) => path.endsWith('.json'))
    )
      return fail();
    const name = input.installed_package.identity.name;
    const version = input.installed_package.identity.version;
    const archive = input.installed_package.readArchive();
    const integrities = new Set(
      ['sha256', 'sha512'].map(
        (algorithm) => `${algorithm}-${createHash(algorithm).update(archive).digest('base64')}`,
      ),
    );
    const verifyIntegrity = (value: unknown) => {
      if (typeof value !== 'string' || !integrities.has(value)) return fail();
    };
    const declared = SECTIONS.flatMap((section) => {
      const values = member(manifest, section);
      if (values === undefined) return [];
      const dependencies = object(values);
      if (Object.values(dependencies).some((value) => typeof value !== 'string')) return fail();
      const value = member(dependencies, name);
      return typeof value === 'string' ? [{ section, specifier: value }] : [];
    });
    if (input.require_installed_dependency && declared.length !== 1) return fail();
    if (input.require_installed_dependency) {
      const specifier = declared[0]?.specifier ?? fail();
      if (specifier.startsWith('file:')) {
        const path = specifier.slice(5);
        if (
          path.length === 0 ||
          path.startsWith('/') ||
          path.includes('\\') ||
          path.includes(':') ||
          [...path].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          return fail();
      } else if (validRange(specifier) === null || !satisfies(version, specifier)) return fail();
    }
    for (const path of lockPaths) {
      const text = decode(read(path));
      let lock: Record<string, unknown>;
      if (path.endsWith('.yaml')) {
        const document = parseDocument(text, { uniqueKeys: true });
        if (document.errors.length !== 0) return fail();
        lock = object(document.toJS({ maxAliasCount: 0 }));
        if (lock['lockfileVersion'] !== '9.0') return fail();
        const importer = object(member(object(member(lock, 'importers')), '.'));
        for (const section of SECTIONS) {
          const declarations = object(member(manifest, section) ?? {});
          const resolutions = object(member(importer, section) ?? {});
          if (
            canonicalJson(Object.keys(declarations).sort()) !==
            canonicalJson(Object.keys(resolutions).sort())
          )
            return fail();
          for (const [dependency, specifier] of Object.entries(declarations)) {
            const resolution = object(member(resolutions, dependency));
            if (resolution['specifier'] !== specifier || typeof resolution['version'] !== 'string')
              return fail();
          }
        }
        if (input.require_installed_dependency) {
          const declaration = declared[0] ?? fail();
          const resolution = object(member(object(member(importer, declaration.section)), name));
          const reference = String(resolution['version']).split('(')[0] ?? fail();
          const local = reference.startsWith('file:');
          if (local ? reference !== declaration.specifier : reference !== version) return fail();
          const packageRecord = object(
            member(object(member(lock, 'packages')), `${name}@${reference}`),
          );
          if (local && packageRecord['version'] !== version) return fail();
          verifyIntegrity(object(member(packageRecord, 'resolution'))['integrity']);
        }
      } else {
        lock = object(JSON.parse(text));
        if (lock['lockfileVersion'] !== 2 && lock['lockfileVersion'] !== 3) return fail();
        const packages = object(member(lock, 'packages'));
        const root = object(member(packages, ''));
        if (lock['name'] !== manifest['name'] || lock['version'] !== manifest['version'])
          return fail();
        for (const section of SECTIONS) {
          if (
            canonicalJson(member(root, section) ?? {}) !==
            canonicalJson(member(manifest, section) ?? {})
          )
            return fail();
        }
        if (input.require_installed_dependency) {
          const installed = object(member(packages, `node_modules/${name}`));
          if (installed['version'] !== version || installed['link'] === true) return fail();
          const declaration = declared[0] ?? fail();
          if (
            declaration.specifier.startsWith('file:') &&
            installed['resolved'] !== declaration.specifier
          )
            return fail();
          verifyIntegrity(installed['integrity']);
        }
      }
    }
    return {
      package_manager: manager,
      package_manifest: { path: 'package.json', sha256: hashes[0]?.sha256 ?? fail() },
      lockfiles: hashes
        .filter((entry) => entry.path !== 'package.json')
        .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))),
    };
  } catch {
    return fail();
  }
}
