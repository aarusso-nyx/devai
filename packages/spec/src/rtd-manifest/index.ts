import { createHash } from 'node:crypto';
import { canonicalSha256, nextCounterId } from '@devai-nyx/utils';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from '@devai-nyx/authority';
import { join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { gatherGitContext } from '@devai-nyx/evidence';
import { loadDomains } from '../spec/domains-loader.js';
import { listSpecFiles } from '../spec/file-walker.js';
import { validateInvariants } from '../spec/invariant-validator.js';
import { validateTrace } from '../spec/trace-validator.js';
import { validateJourneys } from '../spec/journey-validator.js';
import { validateGlossary } from '../spec/glossary-validator.js';

/**
 * RTD bundle aggregator (Phase 12.A, D-41).
 *
 * Produces a hash-stamped aggregate view over the canonical
 * contract slices: invariants, trace, journeys, glossary,
 * ADRs, forbidden-actions. The distributed
 * `spec validate-*` surface stays unchanged — this is an
 * additive bundle view, not a replacement.
 *
 * The manifest's single citable handle is `RTM-NNNN sha256:<hash>`.
 * Downstream consumers (ADR references, law-pack adoption,
 * external audit) pin to that handle. Sub-verdicts let consumers
 * answer "which slice failed?" without re-running every
 * validator.
 */

export interface RtdManifestComponentEntry {
  readonly count?: number;
  readonly hash: string;
  readonly ok: boolean;
  readonly errors?: readonly string[];
}

export interface RtdManifest {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly generated_at: string;
  readonly integration_head: string;
  readonly components: {
    readonly invariants?: RtdManifestComponentEntry;
    readonly trace?: RtdManifestComponentEntry;
    readonly journeys?: RtdManifestComponentEntry;
    readonly glossary?: RtdManifestComponentEntry;
    readonly adrs?: RtdManifestComponentEntry;
    readonly forbidden_actions?: RtdManifestComponentEntry;
  };
  readonly readiness: {
    readonly ok: boolean;
    readonly sub_verdicts: readonly {
      readonly component: string;
      readonly ok: boolean;
      readonly error_count?: number;
    }[];
  };
  readonly manifest_hash: string;
  /**
   * Canonical-JSON algorithm version under which `manifest_hash`
   * was computed (Phase 16.G). rtd-manifest has always used the
   * deep-sort algorithm, now formalised as '2.0'. New writes
   * always emit '2.0'; pre-Phase-16.G records lack the field and
   * are treated as already deep-sort on read.
   */
}

const MANIFESTS_DIR_REL = 'record/proofs/compliance/rtd-manifests';

function stateDir(repoRoot: string): string {
  return join(repoRoot, MANIFESTS_DIR_REL);
}

function nextRtmId(repoRoot: string): string {
  return nextCounterId({
    repoRoot,
    key: 'RTM',
    prefix: 'RTM',
    effects: { mkdirSync, writeFileSync },
  });
}

// Route through the shared canonical-json helper (Phase 16.G). The
// algorithm here has always been deep-sort; canonicalSha256 with
// the default v2.0 setting produces the same shape, just with the
// implementation lifted out.
function hashCanonical(value: unknown): string {
  return canonicalSha256(value);
}

function readJson<T>(path: string): T | null {
  // No pre-check: readFileSync throws ENOENT for missing paths, which
  // we catch alongside parse errors. Saves one syscall per call.
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface InvariantsSummary {
  readonly entry: RtdManifestComponentEntry;
  readonly invariantIds: ReadonlySet<string>;
}

function summarizeInvariants(repoRoot: string, invariantsDir: string): InvariantsSummary {
  const files = listSpecFiles(invariantsDir, 'INV-');
  const records: Array<{ id?: string }> = [];
  const invariantIds = new Set<string>();
  const errors: string[] = [];
  for (const fullPath of files) {
    const rec = readJson<{ id?: string }>(fullPath);
    if (rec === null) {
      errors.push(`unreadable: ${fullPath}`);
    } else {
      records.push(rec);
      if (typeof rec.id === 'string') invariantIds.add(rec.id);
    }
  }
  let validatorOk = true;
  try {
    const domains = loadDomains(join(repoRoot, '.devai/config/domains.json'));
    const result = validateInvariants({ invariantsDir, domains, repoRoot });
    validatorOk = result.ok;
    if (!validatorOk) {
      for (const e of result.errors) errors.push(`${e.file}: ${e.message}`);
    }
  } catch (err) {
    validatorOk = false;
    errors.push(err instanceof Error ? err.message : String(err));
  }
  // Deterministic ordering for the canonical-hash. Stringify each
  // record once, sort by the resulting key, then unwrap — avoids the
  // O(N log N) double-stringify of an in-place sort comparator.
  const sorted = records
    .map((record) => ({ key: JSON.stringify(record), record }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((x) => x.record);
  return {
    entry: {
      count: files.length,
      hash: hashCanonical({ records: sorted }),
      ok: validatorOk && errors.length === 0,
      ...(errors.length > 0 && { errors }),
    },
    invariantIds,
  };
}

function summarizeTrace(
  tracePath: string,
  invariantIds: ReadonlySet<string>,
): RtdManifestComponentEntry | null {
  if (!existsSync(tracePath)) return null;
  const rec = readJson<{ invariants?: unknown[] }>(tracePath);
  const errors: string[] = [];
  let validatorOk = true;
  try {
    const result = validateTrace({ tracePath, invariantIds });
    validatorOk = result.ok;
    if (!validatorOk) {
      for (const e of result.errors) errors.push(`${e.file}: ${e.message}`);
    }
  } catch (err) {
    validatorOk = false;
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return {
    count: rec?.invariants?.length ?? 0,
    hash: hashCanonical(rec),
    ok: validatorOk && errors.length === 0,
    ...(errors.length > 0 && { errors }),
  };
}

function summarizeJourneys(
  journeysDir: string,
  invariantIds: ReadonlySet<string>,
): RtdManifestComponentEntry | null {
  if (!existsSync(journeysDir)) return null;
  const files = listSpecFiles(journeysDir, 'JNY-');
  const records: unknown[] = [];
  const errors: string[] = [];
  for (const fullPath of files) {
    const rec = readJson(fullPath);
    if (rec === null) errors.push(`unreadable: ${fullPath}`);
    else records.push(rec);
  }
  let validatorOk = true;
  try {
    const result = validateJourneys({ journeysDir, invariantIds });
    validatorOk = result.ok;
    if (!validatorOk) {
      for (const e of result.errors) errors.push(`${e.file}: ${e.message}`);
    }
  } catch (err) {
    validatorOk = false;
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return {
    count: files.length,
    hash: hashCanonical({ records }),
    ok: validatorOk && errors.length === 0,
    ...(errors.length > 0 && { errors }),
  };
}

function summarizeGlossary(
  glossaryDir: string,
  invariantIds: ReadonlySet<string>,
): RtdManifestComponentEntry | null {
  if (!existsSync(glossaryDir)) return null;
  const files = listSpecFiles(glossaryDir, 'GE-');
  const records: unknown[] = [];
  const errors: string[] = [];
  for (const fullPath of files) {
    const rec = readJson(fullPath);
    if (rec === null) errors.push(`unreadable: ${fullPath}`);
    else records.push(rec);
  }
  let validatorOk = true;
  try {
    const result = validateGlossary({ glossaryDir, invariantIds });
    validatorOk = result.ok;
    if (!validatorOk) {
      for (const e of result.errors) errors.push(`${e.file}: ${e.message}`);
    }
  } catch (err) {
    validatorOk = false;
    errors.push(err instanceof Error ? err.message : String(err));
  }
  return {
    count: files.length,
    hash: hashCanonical({ records }),
    ok: validatorOk && errors.length === 0,
    ...(errors.length > 0 && { errors }),
  };
}

function summarizeAdrs(adrDir: string): RtdManifestComponentEntry | null {
  if (!existsSync(adrDir)) return null;
  let files: string[];
  try {
    files = readdirSync(adrDir)
      .filter((n) => /^ADR-\d{3,}.*\.md$/.test(n))
      .sort();
  } catch {
    return null;
  }
  // ADRs are markdown — hash the directory listing + per-file content hash.
  const fingerprint = files.map((f) => {
    const content = readFileSync(join(adrDir, f), 'utf8');
    return { name: f, sha: createHash('sha256').update(content).digest('hex') };
  });
  return {
    count: files.length,
    hash: hashCanonical(fingerprint),
    ok: true,
  };
}

function summarizeForbiddenActions(repoRoot: string): RtdManifestComponentEntry | null {
  const path = join(repoRoot, 'law/policy/forbidden-actions.json');
  const rec = readJson<{ actions?: unknown[] }>(path);
  if (rec === null) return null;
  const errors: string[] = [];
  const ok = validators.forbiddenActions(rec);
  if (!ok) {
    for (const e of validators.forbiddenActions.errors ?? []) {
      errors.push(e.message ?? 'schema violation');
    }
  }
  return {
    count: rec.actions?.length ?? 0,
    hash: hashCanonical(rec),
    ok: Boolean(ok),
    ...(errors.length > 0 && { errors }),
  };
}

export interface BuildRtdManifestOptions {
  readonly repoRoot: string;
  readonly id?: string;
  readonly invariantsDir?: string;
  readonly tracePath?: string;
  readonly journeysDir?: string;
  readonly glossaryDir?: string;
  readonly adrDir?: string;
  readonly now?: string;
  readonly integrationHead?: string;
}

export function buildRtdManifest(opts: BuildRtdManifestOptions): RtdManifest {
  const repoRoot = opts.repoRoot;
  const invariantsDir = opts.invariantsDir ?? join(repoRoot, 'law/invariants');
  const tracePath = opts.tracePath ?? join(repoRoot, 'law/trace.json');
  const journeysDir = opts.journeysDir ?? join(repoRoot, 'product/journeys');
  const glossaryDir = opts.glossaryDir ?? join(repoRoot, 'law/glossary');
  const adrDir = opts.adrDir ?? join(repoRoot, 'law/adr');

  // Use a mutable shape locally; the public RtdManifest interface
  // declares readonly properties.
  const components: {
    invariants?: RtdManifestComponentEntry;
    trace?: RtdManifestComponentEntry;
    journeys?: RtdManifestComponentEntry;
    glossary?: RtdManifestComponentEntry;
    adrs?: RtdManifestComponentEntry;
    forbidden_actions?: RtdManifestComponentEntry;
  } = {};
  const subVerdicts: { component: string; ok: boolean; error_count?: number }[] = [];

  // summarizeInvariants returns both the component entry and the
  // id-set the downstream xref validators need, so we read the
  // invariants directory exactly once.
  const { entry: inv, invariantIds } = summarizeInvariants(repoRoot, invariantsDir);
  components.invariants = inv;
  subVerdicts.push({
    component: 'invariants',
    ok: inv.ok,
    ...(inv.errors !== undefined && { error_count: inv.errors.length }),
  });

  const trace = summarizeTrace(tracePath, invariantIds);
  if (trace !== null) {
    components.trace = trace;
    subVerdicts.push({
      component: 'trace',
      ok: trace.ok,
      ...(trace.errors !== undefined && { error_count: trace.errors.length }),
    });
  }

  const journeys = summarizeJourneys(journeysDir, invariantIds);
  if (journeys !== null) {
    components.journeys = journeys;
    subVerdicts.push({
      component: 'journeys',
      ok: journeys.ok,
      ...(journeys.errors !== undefined && { error_count: journeys.errors.length }),
    });
  }

  const glossary = summarizeGlossary(glossaryDir, invariantIds);
  if (glossary !== null) {
    components.glossary = glossary;
    subVerdicts.push({
      component: 'glossary',
      ok: glossary.ok,
      ...(glossary.errors !== undefined && { error_count: glossary.errors.length }),
    });
  }

  const adrs = summarizeAdrs(adrDir);
  if (adrs !== null) {
    components.adrs = adrs;
    subVerdicts.push({ component: 'adrs', ok: adrs.ok });
  }

  const fa = summarizeForbiddenActions(repoRoot);
  if (fa !== null) {
    components.forbidden_actions = fa;
    subVerdicts.push({
      component: 'forbidden_actions',
      ok: fa.ok,
      ...(fa.errors !== undefined && { error_count: fa.errors.length }),
    });
  }

  const overallOk = subVerdicts.every((v) => v.ok);

  const draft: Omit<RtdManifest, 'manifest_hash'> = {
    schemaVersion: '1.0.0',
    id: opts.id ?? nextRtmId(repoRoot),
    generated_at: opts.now ?? new Date().toISOString(),
    integration_head: opts.integrationHead ?? gatherGitContext(repoRoot).head_sha ?? '0'.repeat(40),
    components,
    readiness: { ok: overallOk, sub_verdicts: subVerdicts },
  };
  const manifest_hash = hashCanonical(draft);
  const manifest: RtdManifest = { ...draft, manifest_hash };
  const ok = validators.rtdManifest(manifest);
  if (!ok) {
    throw new Error(
      `buildRtdManifest: produced record failed rtd-manifest.schema.json validation: ${JSON.stringify(validators.rtdManifest.errors)}`,
    );
  }
  return manifest;
}

export function persistRtdManifest(manifest: RtdManifest, repoRoot: string): string {
  const dir = stateDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${manifest.id}.json`);
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return path;
}

export function getRtdManifestDir(repoRoot: string): string {
  return stateDir(repoRoot);
}
