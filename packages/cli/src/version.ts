import { readFileSync } from '@devai-nyx/authority';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the running CLI package version once. */
let cached: string | undefined;

function resolvePkgRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return dirname(here);
}

export function resolveCliVersion(): string {
  if (cached !== undefined) return cached;
  const pkgRoot = resolvePkgRoot();
  const pkgText = readFileSync(join(pkgRoot, 'package.json'), 'utf8');
  cached = (JSON.parse(pkgText) as { version?: string }).version ?? '0.0.0';
  return cached;
}

export interface CliProvenance {
  readonly source: 'npm-package';
  readonly resolvedPath: string;
}

let cachedProvenance: CliProvenance | undefined;

export function resolveCliProvenance(): CliProvenance {
  if (cachedProvenance !== undefined) return cachedProvenance;
  const pkgRoot = resolvePkgRoot();
  cachedProvenance = { source: 'npm-package', resolvedPath: pkgRoot };
  return cachedProvenance;
}
