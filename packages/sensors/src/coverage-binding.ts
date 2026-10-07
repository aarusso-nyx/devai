import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The binding between a local coverage report and the producer run that wrote it (#336).
 * The producer records it in the population sidecar when it writes the report; the sensor
 * reuses an existing report only when the binding names the current candidate commit, the
 * full-suite selector and the report's own digest. Anything else reruns the producer.
 */
export const COVERAGE_PRODUCER_NAME = 'devai-local-coverage-producer';
export const FULL_SUITE_SELECTOR = 'full-suite';

export interface CoverageBinding {
  /** The commit the producer ran at. */
  readonly commit: string;
  readonly producer: { readonly name: string; readonly version: string };
  /** `full-suite`, or a description of the file filter, name filter, shard or changed set. */
  readonly selector: string;
  /** Digest of the `coverage-final.json` the producer wrote beside the sidecar. */
  readonly reportSha256: string;
}

export function sha256OfFile(path: string): string | undefined {
  try {
    return sha256OfBytes(readFileSync(path));
  } catch {
    return undefined;
  }
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

/**
 * The commit `HEAD` names in `repoRoot`, read from the repository files without starting a
 * subprocess (a worktree's `.git` is a pointer file). `undefined` when it cannot be resolved.
 */
export function readHeadCommit(repoRoot: string): string | undefined {
  const dotGit = join(repoRoot, '.git');
  if (!existsSync(dotGit)) return undefined;
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = /^gitdir:\s*(.+)$/mu.exec(readText(dotGit) ?? '');
    if (pointer?.[1] === undefined) return undefined;
    gitDir = isAbsolute(pointer[1]) ? pointer[1] : resolve(repoRoot, pointer[1]);
  }
  const head = readText(join(gitDir, 'HEAD'));
  if (head === undefined) return undefined;
  if (COMMIT_PATTERN.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/u.exec(head)?.[1];
  if (ref === undefined) return undefined;
  const common = readText(join(gitDir, 'commondir'));
  const roots = [gitDir, ...(common === undefined ? [] : [resolve(gitDir, common)])];
  for (const root of roots) {
    const loose = readText(join(root, ref));
    if (loose !== undefined && COMMIT_PATTERN.test(loose)) return loose;
    const packed = readText(join(root, 'packed-refs'));
    if (packed === undefined) continue;
    for (const line of packed.split('\n')) {
      const [sha, name] = line.split(' ');
      if (name === ref && sha !== undefined && COMMIT_PATTERN.test(sha)) return sha;
    }
  }
  return undefined;
}

/** Parses the `binding` object of a population sidecar; `undefined` when absent or malformed. */
export function parseCoverageBinding(sidecar: unknown): CoverageBinding | undefined {
  if (sidecar === null || typeof sidecar !== 'object') return undefined;
  const binding = (sidecar as { binding?: unknown }).binding;
  if (binding === null || typeof binding !== 'object') return undefined;
  const { commit, producer, selector, reportSha256 } = binding as Record<string, unknown>;
  if (typeof commit !== 'string' || typeof selector !== 'string') return undefined;
  if (typeof reportSha256 !== 'string') return undefined;
  if (producer === null || typeof producer !== 'object') return undefined;
  const { name, version } = producer as Record<string, unknown>;
  if (typeof name !== 'string' || typeof version !== 'string') return undefined;
  return { commit, producer: { name, version }, selector, reportSha256 };
}

/** The reasons a binding does not hold for the candidate; empty when it holds. */
export function bindingMismatches(
  binding: CoverageBinding | undefined,
  candidateCommit: string,
  reportBytes: Uint8Array | undefined,
): readonly string[] {
  if (binding === undefined) {
    return ['the population sidecar carries no producer binding'];
  }
  const reasons: string[] = [];
  if (binding.commit !== candidateCommit) {
    reasons.push(
      `it was produced at commit ${binding.commit}, not the candidate ${candidateCommit}`,
    );
  }
  if (binding.producer.name !== COVERAGE_PRODUCER_NAME) {
    reasons.push(`its producer is ${JSON.stringify(binding.producer.name)}`);
  }
  if (binding.selector !== FULL_SUITE_SELECTOR) {
    reasons.push(`it is a partial run (${binding.selector})`);
  }
  if (reportBytes === undefined || sha256OfBytes(reportBytes) !== binding.reportSha256) {
    reasons.push('the report does not match the digest the producer recorded');
  }
  return reasons;
}

export function sidecarPathFor(reportPath: string): string {
  return join(dirname(reportPath), 'population.json');
}
