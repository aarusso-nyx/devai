import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateObservationBacklog,
  type ObservationBacklogObservation,
} from '../operations/backlog.js';
import { completedObservationDigest } from './observation-bundle.js';
import { git, isRecord, sha256 } from './support.js';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SCORECARD_ID = /^SC-[0-9A-Z-]+$/u;
const CHAIN_PATH = 'record/proofs/chain.json';
const SCORECARD_RECORD_DIRECTORY = 'record/proofs/compliance/scorecards';

/** One completed `audit.observe` record of the evidence chain. */
interface ChainObservation {
  readonly mergeSha: string;
  readonly artifacts: ReadonlyMap<string, string>;
}

/**
 * The previous observation an `audit observe` bundle links (#335): the commit it
 * observed, the observation digest of its bundle when that bundle is present and
 * valid in the state directory, and the observations of its backlog when a copy whose
 * bytes match the chain's digest is found.
 */
export interface PreviousObservation {
  readonly mergeSha: string;
  readonly digest: string | null;
  readonly observations: readonly ObservationBacklogObservation[] | null;
}

function artifactName(path: string): string | undefined {
  return /\/([a-z]+)\.json$/u.exec(path)?.[1];
}

function exactSha(record: Record<string, unknown>): string | undefined {
  const notes = Array.isArray(record['notes']) ? record['notes'] : [];
  for (const note of notes) {
    const sha =
      typeof note === 'string' ? /^exact_sha=([0-9a-f]{40})$/u.exec(note)?.[1] : undefined;
    if (sha !== undefined) return sha;
  }
  return undefined;
}

/** Every completed `audit.observe` record of the chain, in chain order. */
function chainObservations(repoRoot: string): readonly ChainObservation[] {
  const path = join(repoRoot, CHAIN_PATH);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('AUDIT_OBSERVE_CHAIN_UNREADABLE');
  }
  const records = isRecord(parsed) && Array.isArray(parsed['records']) ? parsed['records'] : [];
  const observations: ChainObservation[] = [];
  for (const record of records) {
    if (!isRecord(record) || record['action'] !== 'audit.observe') continue;
    if (record['status'] !== 'completed') continue;
    const mergeSha = exactSha(record);
    if (mergeSha === undefined || !Array.isArray(record['artifacts'])) continue;
    const artifacts = new Map<string, string>();
    for (const artifact of record['artifacts']) {
      if (!isRecord(artifact)) continue;
      const name =
        typeof artifact['path'] === 'string' ? artifactName(artifact['path']) : undefined;
      const digest = artifact['sha256'];
      if (name !== undefined && typeof digest === 'string') artifacts.set(name, digest);
    }
    observations.push({ mergeSha, artifacts });
  }
  return observations;
}

function isStrictAncestor(repoRoot: string, candidate: string, at: string): boolean {
  if (candidate === at) return false;
  return git(repoRoot, ['merge-base', '--is-ancestor', candidate, at]).status === 0;
}

function depth(repoRoot: string, sha: string): number {
  const result = git(repoRoot, ['rev-list', '--count', sha]);
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (result.status !== 0 || !Number.isSafeInteger(count)) {
    throw new Error('AUDIT_OBSERVE_PREVIOUS_HISTORY_UNAVAILABLE');
  }
  return count;
}

/**
 * The chain observation a `--previous` value names: a full commit SHA, or the id of
 * a recorded scorecard whose bytes match the scorecard digest of a chain observation.
 */
function namedObservation(
  repoRoot: string,
  candidates: readonly ChainObservation[],
  previous: string,
): ChainObservation {
  if (FULL_SHA.test(previous)) {
    const match = candidates.find((observation) => observation.mergeSha === previous);
    if (match === undefined) throw new Error('AUDIT_OBSERVE_PREVIOUS_UNKNOWN');
    return match;
  }
  if (SCORECARD_ID.test(previous)) {
    const path = join(repoRoot, SCORECARD_RECORD_DIRECTORY, `${previous}.json`);
    if (!existsSync(path)) throw new Error('AUDIT_OBSERVE_PREVIOUS_UNKNOWN');
    const digest = sha256(readFileSync(path));
    const match = candidates.find(
      (observation) => observation.artifacts.get('scorecard') === digest,
    );
    if (match === undefined) throw new Error('AUDIT_OBSERVE_PREVIOUS_UNKNOWN');
    return match;
  }
  throw new Error('AUDIT_OBSERVE_PREVIOUS_INVALID');
}

/**
 * The backlog observations of a chain observation, read from the state directory or
 * from a recorded copy under the scorecards directory, accepted only when the file's
 * bytes match the backlog digest the chain records. Null when no matching copy exists
 * or the copy predates the observation backlog contract.
 */
function backlogObservations(
  repoRoot: string,
  stateRoot: string,
  observation: ChainObservation,
): readonly ObservationBacklogObservation[] | null {
  const expected = observation.artifacts.get('backlog');
  if (expected === undefined) return null;
  const candidates = [join(stateRoot, observation.mergeSha, 'backlog.json')];
  const recordDirectory = join(repoRoot, SCORECARD_RECORD_DIRECTORY);
  if (existsSync(recordDirectory)) {
    for (const name of readdirSync(recordDirectory).sort()) {
      if (name.endsWith('.backlog.json')) candidates.push(join(recordDirectory, name));
    }
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path);
    if (sha256(raw) !== expected) continue;
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return validateObservationBacklog(parsed).ok
      ? (parsed as { readonly observations: readonly ObservationBacklogObservation[] }).observations
      : null;
  }
  return null;
}

/**
 * Resolve the observation an `audit observe` bundle at `at` links (#335).
 *
 * Without `previous`, the candidate set is every completed `audit.observe` record of
 * `record/proofs/chain.json` whose commit is a strict ancestor of `at`, and the
 * nearest one (greatest commit depth, then the smaller SHA) is chosen. The choice
 * depends on commit ancestry, not on chain order or file times. With `previous`, the
 * named chain observation is used and must be a strict ancestor of `at`. Null when no
 * candidate exists: the first observation links nothing.
 */
export function resolvePreviousObservation(opts: {
  readonly repoRoot: string;
  readonly stateRoot: string;
  readonly at: string;
  readonly previous?: string;
}): PreviousObservation | null {
  const observations = chainObservations(opts.repoRoot);
  let chosen: ChainObservation | undefined;
  if (opts.previous !== undefined) {
    chosen = namedObservation(opts.repoRoot, observations, opts.previous);
    if (!isStrictAncestor(opts.repoRoot, chosen.mergeSha, opts.at)) {
      throw new Error('AUDIT_OBSERVE_PREVIOUS_NOT_ANCESTOR');
    }
  } else {
    const ancestors = new Map<string, ChainObservation>();
    for (const observation of observations) {
      if (ancestors.has(observation.mergeSha)) continue;
      if (isStrictAncestor(opts.repoRoot, observation.mergeSha, opts.at)) {
        ancestors.set(observation.mergeSha, observation);
      }
    }
    const ranked = [...ancestors.values()]
      .map((observation) => ({ observation, depth: depth(opts.repoRoot, observation.mergeSha) }))
      .sort(
        (left, right) =>
          right.depth - left.depth ||
          left.observation.mergeSha.localeCompare(right.observation.mergeSha),
      );
    chosen = ranked[0]?.observation;
  }
  if (chosen === undefined) return null;
  return {
    mergeSha: chosen.mergeSha,
    digest: bundleDigest(opts.stateRoot, chosen),
    observations: backlogObservations(opts.repoRoot, opts.stateRoot, chosen),
  };
}

/**
 * The observation digest of a chain observation's bundle, when the bundle is present
 * in the state directory, validates as completed, and its status.json bytes match the
 * status digest the chain records. Recorded copies carry no status.json, so a bundle
 * known only from the scorecards directory links its commit without a digest.
 */
function bundleDigest(stateRoot: string, observation: ChainObservation): string | null {
  const statusPath = join(stateRoot, observation.mergeSha, 'status.json');
  const expected = observation.artifacts.get('status');
  if (expected === undefined || !existsSync(statusPath)) return null;
  if (sha256(readFileSync(statusPath)) !== expected) return null;
  return completedObservationDigest(stateRoot, observation.mergeSha);
}
