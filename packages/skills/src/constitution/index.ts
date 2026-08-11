import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConstitutionVersion } from '@devai-nyx/utils';

/**
 * Constitution binding vendors the canonical constitution at
 * `.devai/pin/constitution.md`, writes a regular pointer file at
 * `.devai/constitution.md`, and records its version and digest in project.json.
 */

export interface ConstitutionPin {
  readonly version: string;
  readonly sha256: string;
}

export type ConstitutionSource = 'bundled';

export interface ResolvedConstitution {
  readonly text: string;
  readonly version: string | null;
  readonly sha256: string;
  readonly source: ConstitutionSource;
  readonly path: string;
}

export { parseConstitutionVersion };

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Resolve the constitution carried by the installed package. The candidate
 * paths cover the skills package build, its source test harness, and the
 * self-contained CLI bundle; no repository checkout is an authority source.
 */
export function resolveCanonicalConstitution(): ResolvedConstitution | null {
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }

  const bundled = [
    join(here, '..', 'law/constitution.md'),
    join(here, '..', '..', 'law/constitution.md'),
    join(here, '..', '..', 'dist/law/constitution.md'),
  ].find((candidate) => existsSync(candidate));
  if (bundled !== undefined) {
    const text = readFileSync(bundled, 'utf8');
    return {
      text,
      version: parseConstitutionVersion(text),
      sha256: sha256Text(text),
      source: 'bundled',
      path: bundled,
    };
  }

  return null;
}

export function computeConstitutionPin(text: string): ConstitutionPin | null {
  const version = parseConstitutionVersion(text);
  if (version === null) return null;
  return { version, sha256: sha256Text(text) };
}

/**
 * `devai doctor`-facing binding status for an adopter repo. Reads
 * `.devai/config/project.json`'s `constitution` pin and the
 * `.devai/pin/constitution.md` vendored copy, and cross-checks against
 * whatever canonical text the running core package can resolve (for
 * an upstream-drift note only — a lagging pin is reported, not
 * failed, since adopters may deliberately hold a version).
 */
export interface ConstitutionBindingStatus {
  readonly hasPin: boolean;
  readonly hasVendoredCopy: boolean;
  readonly pin?: ConstitutionPin;
  readonly vendoredVersion?: string | null;
  readonly vendoredSha256?: string;
  readonly versionMatches?: boolean;
  readonly shaMatches?: boolean;
  readonly upstreamVersion?: string | null;
  readonly upstreamAhead?: boolean;
  readonly ok: boolean;
  readonly errors: readonly string[];
}

interface ProjectConfigConstitution {
  readonly constitution?: { readonly version?: string; readonly sha256?: string };
}

export function verifyConstitutionBinding(repoRoot: string): ConstitutionBindingStatus {
  const configPath = join(repoRoot, '.devai/config/project.json');
  let pin: ConstitutionPin | undefined;
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfigConstitution;
      const v = parsed.constitution?.version;
      if (typeof v === 'string') {
        pin = { version: v, sha256: parsed.constitution?.sha256 ?? '' };
      }
    } catch {
      // malformed config → no pin resolved; reported below via hasPin: false
    }
  }

  const vendoredPath = join(repoRoot, '.devai/pin/constitution.md');
  const hasVendoredCopy = existsSync(vendoredPath);
  const vendoredText = hasVendoredCopy ? readFileSync(vendoredPath, 'utf8') : null;
  const vendoredVersion =
    vendoredText !== null ? parseConstitutionVersion(vendoredText) : undefined;
  const vendoredSha256 = vendoredText !== null ? sha256Text(vendoredText) : undefined;

  const errors: string[] = [];
  if (pin === undefined) errors.push('no constitution pin declared in .devai/config/project.json');
  if (!hasVendoredCopy) errors.push(`no vendored constitution copy at ${vendoredPath}`);

  const versionMatches =
    pin !== undefined && vendoredVersion !== undefined
      ? pin.version === vendoredVersion
      : undefined;
  const shaMatches =
    pin !== undefined && pin.sha256.length > 0 && vendoredSha256 !== undefined
      ? pin.sha256 === vendoredSha256
      : undefined;
  if (versionMatches === false) {
    errors.push(
      `pinned version ${pin?.version ?? '?'} does not match vendored copy version ${vendoredVersion ?? '?'}`,
    );
  }
  if (shaMatches === false) {
    errors.push('pinned sha256 does not match the vendored copy (tamper or stale pin)');
  }

  const canonical = resolveCanonicalConstitution();
  const upstreamVersion = canonical?.version ?? null;
  const upstreamAhead =
    pin !== undefined && upstreamVersion !== null
      ? isVersionBehind(pin.version, upstreamVersion)
      : undefined;

  const ok =
    pin !== undefined && hasVendoredCopy && versionMatches !== false && shaMatches !== false;

  return {
    hasPin: pin !== undefined,
    hasVendoredCopy,
    ...(pin !== undefined && { pin }),
    ...(vendoredVersion !== undefined && { vendoredVersion }),
    ...(vendoredSha256 !== undefined && { vendoredSha256 }),
    ...(versionMatches !== undefined && { versionMatches }),
    ...(shaMatches !== undefined && { shaMatches }),
    upstreamVersion,
    ...(upstreamAhead !== undefined && { upstreamAhead }),
    ok,
    errors,
  };
}

function isVersionBehind(pinned: string, upstream: string): boolean {
  const a = pinned.split('.').map(Number);
  const b = upstream.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

/**
 * Build the adopter constitution binding. A target-local `law/constitution.md`
 * does not change this shape or become the canonical source.
 */
export interface ConstitutionBindingPlan {
  readonly rootFile: { readonly path: string; readonly content: string };
  readonly pointerFile: {
    readonly path: string;
    readonly content: string;
  };
  readonly pin: ConstitutionPin;
}

export function buildConstitutionBindingPlan(
  _targetRoot: string,
  version: string,
): ConstitutionBindingPlan {
  const canonical = resolveCanonicalConstitution();
  if (canonical === null) {
    throw new Error('canonical DEVAI Constitution is unavailable from the installed package');
  }

  const pin = computeConstitutionPin(canonical.text);
  if (pin === null) {
    throw new Error('canonical DEVAI Constitution has no parseable version');
  }
  return {
    rootFile: { path: '.devai/pin/constitution.md', content: canonical.text },
    pointerFile: {
      path: '.devai/constitution.md',
      content: `# See pin/constitution.md\n\nVendored constitution copy at \`.devai/pin/constitution.md\`. This regular file points \`devai doctor\` at the binding; the vendored copy and the \`constitution\` entry in \`.devai/config/project.json\` are authoritative. Refresh both with \`devai init bind --constitution --write\`. Generated by DEVAI v${version}.\n`,
    },
    pin,
  };
}
