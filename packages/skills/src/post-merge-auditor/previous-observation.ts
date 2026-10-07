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

/** One completed `audit.observe` record of the evidence chain, in chain order. */
interface ChainObservation {
  readonly recordId: string;
  readonly mergeSha: string;
  readonly artifacts: ReadonlyMap<string, string>;
}

/**
 * The previous observation an `audit observe` bundle links (#335): the one completed
 * chain record it is bound to, the commit that record observed, the observation digest
 * of its bundle when that bundle is present in the state directory and matches the
 * record, and the observations of its backlog, whose bytes must match the record.
 */
export interface PreviousObservation {
  readonly recordId: string;
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

/** One completed `audit.observe` record, or a refusal when it cannot be bound. */
function chainObservation(record: Record<string, unknown>): ChainObservation {
  const recordId = record['id'];
  const mergeSha = exactSha(record);
  if (typeof recordId !== 'string' || recordId.length === 0 || mergeSha === undefined) {
    throw new Error('AUDIT_OBSERVE_PREVIOUS_RECORD_INVALID');
  }
  if (!Array.isArray(record['artifacts'])) throw new Error('AUDIT_OBSERVE_PREVIOUS_RECORD_INVALID');
  const artifacts = new Map<string, string>();
  for (const artifact of record['artifacts']) {
    if (!isRecord(artifact) || typeof artifact['path'] !== 'string') {
      throw new Error('AUDIT_OBSERVE_PREVIOUS_RECORD_INVALID');
    }
    const name = artifactName(artifact['path']);
    const digest = artifact['sha256'];
    if (name === undefined || typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
      throw new Error('AUDIT_OBSERVE_PREVIOUS_RECORD_INVALID');
    }
    artifacts.set(name, digest);
  }
  if (!artifacts.has('backlog')) throw new Error('AUDIT_OBSERVE_PREVIOUS_RECORD_INVALID');
  return { recordId, mergeSha, artifacts };
}

/**
 * Every completed `audit.observe` record of the chain, in chain order. An absent chain
 * holds none; a present chain that is not an object with a `records` array of objects,
 * or a completed observation record that cannot be bound, is refused.
 */
function chainObservations(repoRoot: string): readonly ChainObservation[] {
  const path = join(repoRoot, CHAIN_PATH);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('AUDIT_OBSERVE_CHAIN_INVALID');
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['records'])) {
    throw new Error('AUDIT_OBSERVE_CHAIN_INVALID');
  }
  const observations: ChainObservation[] = [];
  for (const record of parsed['records']) {
    if (!isRecord(record)) throw new Error('AUDIT_OBSERVE_CHAIN_INVALID');
    if (record['action'] !== 'audit.observe' || record['status'] !== 'completed') continue;
    observations.push(chainObservation(record));
  }
  return observations;
}

/**
 * Whether `candidate` is a strict ancestor of `at`. `git merge-base --is-ancestor` exits
 * 0 for an ancestor and 1 for a commit that is not one; any other outcome (a missing
 * object, a shallow history, a failed spawn) is refused rather than read as "no".
 */
function isStrictAncestor(repoRoot: string, candidate: string, at: string): boolean {
  if (candidate === at) return false;
  const result = git(repoRoot, ['merge-base', '--is-ancestor', candidate, at]);
  if (result.status === 0) return true;
  if (result.status === 1 && result.error === undefined) return false;
  throw new Error('AUDIT_OBSERVE_PREVIOUS_HISTORY_UNAVAILABLE');
}

function depth(repoRoot: string, sha: string): number {
  const result = git(repoRoot, ['rev-list', '--count', sha]);
  const count = Number.parseInt(result.stdout.trim(), 10);
  if (result.status !== 0 || !Number.isSafeInteger(count)) {
    throw new Error('AUDIT_OBSERVE_PREVIOUS_HISTORY_UNAVAILABLE');
  }
  return count;
}

/** The latest record, by chain order, among those that match. */
function latest(
  observations: readonly ChainObservation[],
  matches: (observation: ChainObservation) => boolean,
): ChainObservation | undefined {
  return observations.filter(matches).at(-1);
}

/**
 * The chain record a `--previous` value names: a full commit SHA (its latest completed
 * record), a recorded scorecard id whose bytes match a record's scorecard digest, or,
 * on replay, the record id the bundle already names.
 */
function namedObservation(
  repoRoot: string,
  observations: readonly ChainObservation[],
  previous: string,
): ChainObservation {
  let match: ChainObservation | undefined;
  if (FULL_SHA.test(previous)) {
    match = latest(observations, (observation) => observation.mergeSha === previous);
  } else if (SCORECARD_ID.test(previous)) {
    const path = join(repoRoot, SCORECARD_RECORD_DIRECTORY, `${previous}.json`);
    if (existsSync(path)) {
      const digest = sha256(readFileSync(path));
      match = latest(
        observations,
        (observation) => observation.artifacts.get('scorecard') === digest,
      );
    }
  } else {
    throw new Error('AUDIT_OBSERVE_PREVIOUS_INVALID');
  }
  if (match === undefined) throw new Error('AUDIT_OBSERVE_PREVIOUS_UNKNOWN');
  return match;
}

/**
 * The backlog observations of the bound record, read from the state directory or from
 * a recorded copy under the scorecards directory, accepted only when the file's bytes
 * match the backlog digest the record carries. A record whose backlog bytes are found
 * nowhere is refused. A matching copy that predates the observation backlog contract
 * yields null, as in the post-merge hook.
 */
function backlogObservations(
  repoRoot: string,
  stateRoot: string,
  observation: ChainObservation,
): readonly ObservationBacklogObservation[] | null {
  const expected = observation.artifacts.get('backlog');
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
  throw new Error('AUDIT_OBSERVE_PREVIOUS_BACKLOG_MISSING');
}

/**
 * The observation digest of the bound record's bundle, when the bundle is present in
 * the state directory, validates as completed, and its status.json bytes match the
 * status digest the record carries. Recorded copies carry no status.json, so a bundle
 * known only from the scorecards directory links its record without a digest.
 */
function bundleDigest(stateRoot: string, observation: ChainObservation): string | null {
  const statusPath = join(stateRoot, observation.mergeSha, 'status.json');
  const expected = observation.artifacts.get('status');
  if (expected === undefined || !existsSync(statusPath)) return null;
  if (sha256(readFileSync(statusPath)) !== expected) return null;
  return completedObservationDigest(stateRoot, observation.mergeSha);
}

/**
 * Resolve the chain record an `audit observe` bundle at `at` links (#335).
 *
 * With `recordId` (a replay), the bundle stays bound to the record it already names.
 * With `previous`, the named record is used. Otherwise the candidates are the completed
 * `audit.observe` records whose commit is a strict ancestor of `at`; the nearest commit
 * (greatest depth, then the smaller SHA) is chosen, and within it the latest record by
 * chain order. The bound record must observe a strict ancestor of `at`. Null when no
 * candidate exists: the first observation links nothing.
 */
export function resolvePreviousObservation(opts: {
  readonly repoRoot: string;
  readonly stateRoot: string;
  readonly at: string;
  readonly previous?: string;
  readonly recordId?: string;
}): PreviousObservation | null {
  const observations = chainObservations(opts.repoRoot);
  let chosen: ChainObservation | undefined;
  if (opts.recordId !== undefined) {
    chosen = latest(observations, (observation) => observation.recordId === opts.recordId);
    if (chosen === undefined) throw new Error('AUDIT_OBSERVE_PREVIOUS_RECORD_UNKNOWN');
  } else if (opts.previous !== undefined) {
    chosen = namedObservation(opts.repoRoot, observations, opts.previous);
  } else {
    const ancestors = [
      ...new Set(
        observations
          .map((observation) => observation.mergeSha)
          .filter((sha) => isStrictAncestor(opts.repoRoot, sha, opts.at)),
      ),
    ]
      .map((sha) => ({ sha, depth: depth(opts.repoRoot, sha) }))
      .sort((left, right) => right.depth - left.depth || left.sha.localeCompare(right.sha));
    const nearest = ancestors[0]?.sha;
    chosen =
      nearest === undefined
        ? undefined
        : latest(observations, (observation) => observation.mergeSha === nearest);
  }
  if (chosen === undefined) return null;
  if (!isStrictAncestor(opts.repoRoot, chosen.mergeSha, opts.at)) {
    throw new Error('AUDIT_OBSERVE_PREVIOUS_NOT_ANCESTOR');
  }
  return {
    recordId: chosen.recordId,
    mergeSha: chosen.mergeSha,
    digest: bundleDigest(opts.stateRoot, chosen),
    observations: backlogObservations(opts.repoRoot, opts.stateRoot, chosen),
  };
}
