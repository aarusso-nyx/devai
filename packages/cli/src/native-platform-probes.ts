import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

const createHashOriginal = createHash;
const sha256 = (bytes: Uint8Array | string): string =>
  createHashOriginal('sha256').update(bytes).digest('hex');

export const frameworkPlatformProbeCallers = Object.freeze([
  {
    probe: 'linux-wsl-v1',
    packageName: 'vite',
    packageVersion: '7.3.6',
    file: 'dist/node/chunks/config.js',
    sha256: 'c2fcfa51206dc1f8d22120ef4a82af8b9acdc02f4476520b6a0897d12a724ba3',
    line: 15772,
    column: 13,
    path: '/proc/version',
    encoding: 'utf8',
  },
  {
    probe: 'linux-wsl-v1',
    packageName: 'playwright-core',
    packageVersion: '1.60.0',
    file: 'lib/utilsBundle.js',
    sha256: '5c42363c10d2f2f5bc91e07feaa9fa5f417a1a55e6559448d0c20d66f73db9e0',
    line: 5679,
    column: 19,
    path: '/proc/version',
    encoding: 'utf8',
  },
  {
    probe: 'linux-os-release-v1',
    packageName: 'playwright-core',
    packageVersion: '1.60.0',
    file: 'lib/coreBundle.js',
    sha256: 'f74353fcb8e406756a70a6af0dfc4a5069acd577e35ec9d923ccf36ac009c2f5',
    line: 7669,
    column: 48,
    path: '/etc/os-release',
    encoding: 'utf8',
  },
  {
    probe: 'linux-libc-v1',
    packageName: '@swc/core',
    packageVersion: '1.16.2',
    file: 'binding.js',
    sha256: '46163ee878019eb5ddb6d6783d925b6fedaa1f9dbd3c587b96dee3e5631cc72c',
    line: 28,
    column: 12,
    path: '/usr/bin/ldd',
    encoding: 'utf-8',
  },
] as const);
for (const caller of frameworkPlatformProbeCallers) Object.freeze(caller);

export type FrameworkPlatformProbeCaller = (typeof frameworkPlatformProbeCallers)[number];

/** Pure path derivation only; public helper imports never acquire unobserved filesystem access. */
export function frameworkPlatformPackageRoot(
  file: string,
  caller: FrameworkPlatformProbeCaller,
): string {
  if (!isAbsolute(file) || resolve(file) !== file || !file.endsWith(`/${caller.file}`))
    throw new Error('NATIVE_PLATFORM_CALLER_INVALID');
  return resolve(file.slice(0, -caller.file.length));
}

/** Check supplied installed-package facts without reading through a caller-controlled path. */
export function inspectFrameworkPlatformCaller(
  file: string,
  caller: FrameworkPlatformProbeCaller,
  physicalFile: string,
  fileBytes: Uint8Array,
  manifestBytes: Uint8Array,
): string {
  const root = frameworkPlatformPackageRoot(file, caller);
  if (physicalFile !== file || sha256(fileBytes) !== caller.sha256)
    throw new Error('NATIVE_PLATFORM_CALLER_INVALID');
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as {
    name?: string;
    version?: string;
  };
  if (manifest.name !== caller.packageName || manifest.version !== caller.packageVersion)
    throw new Error('NATIVE_PLATFORM_PACKAGE_INVALID');
  return root;
}

/** Measure a finite platform fact; this does not admit the path as a candidate input. */
export function nativePlatformProbeObservation(
  caller: FrameworkPlatformProbeCaller,
  host: { readonly platform: string; readonly osRelease: string },
  physical: string,
  bytes: Uint8Array,
  returnedValue?: unknown,
) {
  if (host.platform !== 'linux' || host.osRelease.toLowerCase().includes('microsoft'))
    throw new Error('NATIVE_PLATFORM_UNSUPPORTED');
  if (
    physical !== caller.path &&
    !(caller.path === '/etc/os-release' && physical === '/usr/lib/os-release')
  )
    throw new Error('NATIVE_PLATFORM_PHYSICAL_PATH_UNSUPPORTED');
  const raw = Buffer.from(bytes);
  const text = raw.toString('utf8');
  if (!Buffer.from(text).equals(raw) || (returnedValue !== undefined && returnedValue !== text))
    throw new Error('NATIVE_PLATFORM_READ_CHANGED');
  let semantics: Record<string, string | boolean>;
  if (caller.probe === 'linux-wsl-v1') {
    const includesMicrosoft = text.toLowerCase().includes('microsoft');
    if (includesMicrosoft) throw new Error('NATIVE_PLATFORM_WSL_UNSUPPORTED');
    semantics = { includesMicrosoft };
  } else if (caller.probe === 'linux-libc-v1') {
    const includesMusl = text.includes('musl');
    if (includesMusl) throw new Error('NATIVE_PLATFORM_MUSL_UNSUPPORTED');
    semantics = { includesMusl };
  } else {
    // Exactly Playwright 1.60.0's parseOSReleaseText, including duplicate-last semantics.
    const fields = new Map<string, string>();
    for (const line of text.split('\n')) {
      const tokens = line.split('=');
      const name = tokens.shift();
      let value = tokens.join('=').trim();
      if (value.startsWith('"') && value.endsWith('"'))
        value = value.substring(1, value.length - 1);
      if (name) fields.set(name.toLowerCase(), value);
    }
    semantics = { id: fields.get('id') ?? '', version: fields.get('version_id') ?? '' };
  }
  return {
    sha256: sha256(returnedValue === undefined ? text : (returnedValue as string)),
    rawSha256: sha256(raw),
    realpath: physical,
    semantics,
  };
}
