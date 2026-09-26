import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '@devai-nyx/utils';

/**
 * ADR-SEC-0001: the one credential probe shared by `devai doctor` and the
 * preflight `credential` probe kind. It verifies presence, shape, scope, and
 * expiry through the consuming tool's own status command and reports one of
 * four statuses with the manifest id. It never returns, logs, or stores a
 * value: subprocess output is parsed for fixed facts and then discarded.
 */

export const CREDENTIAL_MANIFEST_RELATIVE = 'law/policy/credential-requirements.json';
/** Where an adopter binding lands when the scaffold materializes it. */
export const CREDENTIAL_BINDING_RELATIVE = '.devai/config/credential-requirements.json';

export type CredentialKind =
  'environment' | 'repository-secret' | 'environment-secret' | 'gh-auth' | 'file';
export type CredentialStatus = 'present' | 'absent' | 'scope-insufficient' | 'expired';

export interface CredentialEntry {
  readonly id: string;
  readonly kind: CredentialKind;
  readonly scope: string;
  readonly consumer: readonly unknown[];
  readonly absence: 'block' | 'degrade';
  readonly description: string;
}

export interface CredentialManifest {
  readonly path: string;
  readonly entries: readonly CredentialEntry[];
}

/** An injectable subprocess boundary. A refusal or spawn failure may throw. */
export type CredentialSubprocess = (argv: readonly string[]) => {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export interface ProbeCredentialOptions {
  readonly repoRoot: string;
  readonly id: string;
  readonly run: CredentialSubprocess;
  /** Defaults to the manifest resolved from `repoRoot`. */
  readonly manifest?: CredentialManifest;
  /** Defaults to `process.env`. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface ProbeCredentialResult {
  readonly id: string;
  readonly kind: CredentialKind | 'unknown';
  readonly status: CredentialStatus;
  /** A fixed vocabulary word, never subprocess text. */
  readonly reason?: string;
  /** Scope names the consumer requires that the observed session lacks. */
  readonly missing_scopes?: readonly string[];
}

/**
 * Token-shaped values and secret-named assignments. Every probe observation,
 * failure reason, and diagnostic stream tail passes through these before it is
 * written to a report or a diagnostics file.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/gu,
  /\bnpm_[A-Za-z0-9]{20,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bsk-[A-Za-z0-9_-]{20,}/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b(?:Bearer|Basic) [A-Za-z0-9._~+/=-]{8,}/gu,
  /_authToken=\S+/gu,
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*=\S+/gu,
];

/** Masks every token-shaped value and secret-named assignment in text. */
export function redactDiagnosticText(value: string): string {
  return redact(value, { patterns: SECRET_PATTERNS, fields: [] }) as string;
}

const KINDS: readonly CredentialKind[] = [
  'environment',
  'repository-secret',
  'environment-secret',
  'gh-auth',
  'file',
];

function isEntry(value: unknown): value is CredentialEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    /^[A-Z][A-Z0-9_]*$/u.test(entry.id) &&
    KINDS.includes(entry.kind as CredentialKind) &&
    typeof entry.scope === 'string' &&
    Array.isArray(entry.consumer)
  );
}

/**
 * The manifest that governs `repoRoot`: DEVAI's own law manifest when the
 * repository carries one, then a materialized adopter binding, then the
 * manifest shipped beside this module.
 */
export function resolveCredentialManifestPath(repoRoot: string): string | undefined {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  return [
    join(resolve(repoRoot), CREDENTIAL_MANIFEST_RELATIVE),
    join(resolve(repoRoot), CREDENTIAL_BINDING_RELATIVE),
    resolve(moduleRoot, `../../${CREDENTIAL_MANIFEST_RELATIVE}`),
    resolve(moduleRoot, `../../../../${CREDENTIAL_MANIFEST_RELATIVE}`),
  ].find((candidate) => existsSync(candidate));
}

/** Reads the governing manifest; throws CREDENTIAL_MANIFEST_* codes only. */
export function loadCredentialManifest(repoRoot: string): CredentialManifest {
  const path = resolveCredentialManifestPath(repoRoot);
  if (path === undefined) throw new Error('CREDENTIAL_MANIFEST_MISSING');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('CREDENTIAL_MANIFEST_UNREADABLE');
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries) || !entries.every(isEntry)) {
    throw new Error('CREDENTIAL_MANIFEST_MALFORMED');
  }
  return { path, entries };
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Classic OAuth scopes that satisfy each required permission. A requirement
 * absent from this table (for example `id-token:write`, which only exists
 * inside a workflow run) cannot be observed locally and is not held against
 * the session.
 */
const SCOPE_SATISFIERS: Readonly<Record<string, readonly string[]>> = {
  'read:packages': ['read:packages', 'write:packages'],
  'packages:read': ['read:packages', 'write:packages'],
  'packages:write': ['write:packages'],
  'write:packages': ['write:packages'],
  'contents:read': ['repo', 'public_repo'],
  'contents:write': ['repo', 'public_repo'],
  'issues:read': ['repo', 'public_repo'],
  'issues:write': ['repo', 'public_repo'],
  'pages:write': ['repo', 'public_repo'],
  'deployments:write': ['repo', 'repo_deployment'],
  'actions:read': ['repo', 'workflow'],
};

function ghScopes(text: string): readonly string[] | undefined {
  const line = /Token scopes:\s*(.*)$/mu.exec(text)?.[1];
  if (line === undefined) return undefined;
  return [...line.matchAll(/'([^']+)'|"([^"]+)"|([a-z_:]+)/gu)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((scope) => scope !== '' && scope !== 'none');
}

function ghAuthStatus(entry: CredentialEntry, run: CredentialSubprocess): ProbeCredentialResult {
  let result: ReturnType<CredentialSubprocess>;
  try {
    result = run(['gh', 'auth', 'status']);
  } catch {
    return { id: entry.id, kind: entry.kind, status: 'absent', reason: 'probe-refused' };
  }
  const text = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
  if (result.status === null) {
    return { id: entry.id, kind: entry.kind, status: 'absent', reason: 'probe-unavailable' };
  }
  if (result.status !== 0) {
    const expired = /\b(?:invalid|expired|re-?authenticate|Failed to log in|bad credentials)\b/iu;
    return expired.test(text)
      ? { id: entry.id, kind: entry.kind, status: 'expired', reason: 'session-invalid' }
      : { id: entry.id, kind: entry.kind, status: 'absent', reason: 'not-logged-in' };
  }
  if (!/Logged in to /u.test(text)) {
    return { id: entry.id, kind: entry.kind, status: 'absent', reason: 'not-logged-in' };
  }
  const scopes = ghScopes(text);
  if (scopes === undefined) {
    return { id: entry.id, kind: entry.kind, status: 'present', reason: 'scopes-unlisted' };
  }
  const missing = entry.scope
    .split(/\s+/u)
    .filter((required) => required !== '')
    .filter((required) => {
      const satisfiers = SCOPE_SATISFIERS[required];
      return satisfiers !== undefined && !satisfiers.some((scope) => scopes.includes(scope));
    });
  return missing.length === 0
    ? { id: entry.id, kind: entry.kind, status: 'present' }
    : { id: entry.id, kind: entry.kind, status: 'scope-insufficient', missing_scopes: missing };
}

function probeEntry(
  entry: CredentialEntry,
  run: CredentialSubprocess,
  environment: Readonly<Record<string, string | undefined>>,
): ProbeCredentialResult {
  switch (entry.kind) {
    case 'environment':
      return {
        id: entry.id,
        kind: entry.kind,
        status: nonEmpty(environment[entry.id]) ? 'present' : 'absent',
      };
    case 'repository-secret':
    case 'environment-secret':
      // A GitHub Actions secret cannot be read outside its job; inside the job
      // the workflow maps it onto a variable of the same name.
      return nonEmpty(environment[entry.id])
        ? { id: entry.id, kind: entry.kind, status: 'present' }
        : { id: entry.id, kind: entry.kind, status: 'absent', reason: 'not-probeable-locally' };
    case 'file': {
      const path = environment[entry.id];
      let exists = false;
      try {
        exists = nonEmpty(path) && statSync(String(path)).isFile();
      } catch {
        exists = false;
      }
      return { id: entry.id, kind: entry.kind, status: exists ? 'present' : 'absent' };
    }
    case 'gh-auth':
      return ghAuthStatus(entry, run);
  }
}

function sanitized(result: ProbeCredentialResult): ProbeCredentialResult {
  return redact(result, { patterns: SECRET_PATTERNS, fields: [] }) as ProbeCredentialResult;
}

/** Probes one manifest entry by id. Unknown ids report absent. */
export function probeCredential(options: ProbeCredentialOptions): ProbeCredentialResult {
  let manifest = options.manifest;
  if (manifest === undefined) {
    try {
      manifest = loadCredentialManifest(options.repoRoot);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'CREDENTIAL_MANIFEST_UNREADABLE';
      return sanitized({ id: options.id, kind: 'unknown', status: 'absent', reason });
    }
  }
  const entry = manifest.entries.find((candidate) => candidate.id === options.id);
  if (entry === undefined) {
    return sanitized({
      id: options.id,
      kind: 'unknown',
      status: 'absent',
      reason: 'not-in-manifest',
    });
  }
  return sanitized(probeEntry(entry, options.run, options.environment ?? process.env));
}

/**
 * Probes every entry of the governing manifest. `gh auth status` runs at most
 * once per call however many gh-auth entries the manifest declares.
 */
export function probeCredentialManifest(
  repoRoot: string,
  run: CredentialSubprocess,
): { readonly manifest: CredentialManifest; readonly results: readonly ProbeCredentialResult[] } {
  const manifest = loadCredentialManifest(repoRoot);
  const cache = new Map<string, ReturnType<CredentialSubprocess> | Error>();
  const memoized: CredentialSubprocess = (argv) => {
    const key = argv.join('\0');
    if (!cache.has(key)) {
      try {
        cache.set(key, run(argv));
      } catch (error) {
        cache.set(key, error instanceof Error ? error : new Error('refused'));
      }
    }
    const cached = cache.get(key);
    if (cached instanceof Error || cached === undefined) throw new Error('refused');
    return cached;
  };
  return {
    manifest,
    results: manifest.entries.map((entry) =>
      probeCredential({ repoRoot, id: entry.id, run: memoized, manifest }),
    ),
  };
}
