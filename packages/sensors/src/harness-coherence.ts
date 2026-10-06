import { readFileSync } from 'node:fs';
import {
  buildSensorReading,
  type SensorFinding,
  type SensorReading,
  type SensorStatus,
} from './sensor-reading.js';
import {
  concurrencyGroupContexts,
  listWorkflowFiles,
  loadWorkflows,
  jobEffectFacts,
} from './harness/workflow-parser.js';

/**
 * F5 harness coherence sensor (28.D; F5×T3). Per design note at
 * docs/theory/architecture/sensors/harness_coherence.md.
 */

export interface HarnessCoherenceOptions {
  readonly repoRoot: string;
  readonly workflowDir?: string;
  readonly maxReviewIncoherence?: number;
  readonly now?: string;
}

const DEFAULT_MAX_REVIEW = 3;

interface ConcurrencyDeclaration {
  readonly group: string;
  readonly cancelInProgress: boolean | null;
}

function concurrencyDeclaration(file: string): ConcurrencyDeclaration | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const block = text.match(/^concurrency\s*:\s*\n((?:[ \t]+.*(?:\n|$))*)/mu);
  if (block === null) return null;
  const body = block[1] ?? '';
  const group = body.match(/^\s+group\s*:\s*(.+?)\s*$/mu)?.[1] ?? '';
  const cancel = body.match(/^\s+cancel-in-progress\s*:\s*(true|false)\s*$/mu)?.[1];
  return {
    group,
    cancelInProgress: cancel === undefined ? null : cancel === 'true',
  };
}

/** Stands for "any event" when the workflow's triggers cannot be read. */
const ANY_EVENT = '*';
/**
 * The subjects a superseding group may be keyed by, with the events on which each is set: the
 * run's ref and commit on every event, the pull request number on pull request events, the
 * merge-queue head on merge-queue events, and the release tag input on dispatches.
 */
const SCOPED_SUBJECTS: ReadonlyMap<string, readonly string[] | 'every'> = new Map<
  string,
  readonly string[] | 'every'
>([
  ['github.ref', 'every'],
  ['github.sha', 'every'],
  ['github.event.pull_request.number', ['pull_request', 'pull_request_target']],
  ['github.event.merge_group.head_sha', ['merge_group']],
  ['inputs.release_tag', ['workflow_dispatch', 'workflow_call']],
]);
/** Contexts that may appear beside a scoped subject but never scope a group alone. */
const UNSCOPED_VALUES = new Set(['github.workflow']);

function subjectCovers(subject: string, event: string): boolean {
  const events = SCOPED_SUBJECTS.get(subject);
  return (
    events === 'every' || (events !== undefined && event !== ANY_EVENT && events.includes(event))
  );
}

/** The events a workflow accepts, or undefined when its `on:` cannot be read. */
export function workflowEvents(text: string): readonly string[] | undefined {
  const inline = /^on[ \t]*:[ \t]*([^\s#].*?)[ \t]*$/mu.exec(text)?.[1];
  if (inline !== undefined) {
    const list = /^\[(.*)\]$/u.exec(inline)?.[1];
    const names = (list ?? inline)
      .split(',')
      .map((name) => name.trim().replace(/^['"]|['"]$/gu, ''));
    return names.every((name) => /^[a-z_]+$/u.test(name)) ? names : undefined;
  }
  const block = /^on[ \t]*:[ \t]*\n((?:[ \t]+.*(?:\n|$)|\s*\n)*)/mu.exec(text)?.[1];
  if (block === undefined) return undefined;
  const indent = /^([ \t]+)\S/mu.exec(block)?.[1];
  if (indent === undefined) return undefined;
  const names = [...block.matchAll(new RegExp(`^${indent}([a-z_]+)\\s*:`, 'gmu'))].map(
    (m) => m[1] ?? '',
  );
  return names.length > 0 ? names : undefined;
}

/**
 * Whether one `${{ … }}` expression is keyed by a scoped subject on every event in `events`.
 * Accepted shapes only: a plain scoped context; `format('literal', …)` over plain allowlisted
 * contexts, scoped through a `{n}` placeholder that references a scoped argument; and
 * `<context> == 'literal' && <value> || <value>`. A `github.event_name == 'X'` condition
 * needs its first value to cover X and its second to cover every other event; any other
 * condition needs both values to cover every event. Anything else is unproved.
 */
function scopedExpression(expression: string, events: readonly string[]): boolean {
  const token = /\s*(?:('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_.-]*)|(==|&&|\|\||[(),]))/uy;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < expression.length) {
    token.lastIndex = offset;
    const match = token.exec(expression);
    if (!match) {
      if (expression.slice(offset).trim() !== '') return false;
      break;
    }
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    offset = token.lastIndex;
  }
  let cursor = 0;
  // A value and the subjects it is keyed by, or undefined when unproved.
  function value(): readonly string[] | undefined {
    const head = tokens[cursor++];
    if (head === undefined) return undefined;
    if (SCOPED_SUBJECTS.has(head)) return [head];
    if (head !== 'format' || tokens[cursor++] !== '(') return undefined;
    const literal = tokens[cursor++];
    if (literal?.startsWith("'") !== true) return undefined;
    const args: string[] = [];
    while (tokens[cursor] === ',') {
      cursor++;
      const argument = tokens[cursor++] ?? '';
      if (!SCOPED_SUBJECTS.has(argument) && !UNSCOPED_VALUES.has(argument)) return undefined;
      args.push(argument);
    }
    if (tokens[cursor++] !== ')') return undefined;
    const text = literal.slice(1, -1).replaceAll("''", "'");
    const placeholders = [
      ...text
        .replaceAll('{{', '')
        .replaceAll('}}', '')
        .matchAll(/\{(\d+)\}/gu),
    ].map((match) => Number(match[1]));
    if (placeholders.some((index) => index >= args.length)) return undefined;
    return placeholders
      .map((index) => args[index] ?? '')
      .filter((argument) => SCOPED_SUBJECTS.has(argument));
  }
  const covers = (subjects: readonly string[], event: string): boolean =>
    subjects.some((subject) => subjectCovers(subject, event));
  const start = cursor;
  const plain = value();
  if (plain !== undefined && cursor === tokens.length)
    return events.every((event) => covers(plain, event));
  cursor = start;
  const left = tokens[cursor++] ?? '';
  if (!/^github\.[a-z_.]+$/u.test(left) || tokens[cursor++] !== '==') return false;
  const compared = tokens[cursor++];
  if (compared?.startsWith("'") !== true || tokens[cursor++] !== '&&') return false;
  const first = value();
  if (first === undefined || tokens[cursor++] !== '||') return false;
  const second = value();
  if (second === undefined || cursor !== tokens.length) return false;
  if (left === 'github.event_name') {
    const chosen = compared.slice(1, -1);
    return events.every((event) =>
      event === chosen ? covers(first, event) : covers(second, event),
    );
  }
  return events.every((event) => covers(first, event) && covers(second, event));
}

/**
 * A superseding group cancels the older runs that share it, so it must be keyed by the run's
 * own subject on every event the workflow accepts (#325): every `${{ … }}` part must be a
 * proved shape or a plain allowlisted context, and at least one part must cover every event.
 * Without readable triggers only the ref or commit covers. Literal text between parts is free.
 */
export function supersedingGroupScoped(group: string, events?: readonly string[]): boolean {
  if (concurrencyGroupContexts(group) === undefined) return false;
  const accepted = events !== undefined && events.length > 0 ? events : [ANY_EVENT];
  const parts = [...group.matchAll(/\$\{\{(.*?)\}\}/gu)].map((match) => (match[1] ?? '').trim());
  const scoped = parts.map((part) => scopedExpression(part, accepted));
  return (
    parts.every((part, index) => UNSCOPED_VALUES.has(part) || scoped[index] === true) &&
    scoped.some(Boolean)
  );
}

function requiresSerialization(relativeFile: string, file: string): boolean {
  if (/release/iu.test(relativeFile)) return true;
  try {
    return /^\s{2}schedule\s*:/mu.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

export function senseHarnessCoherence(opts: HarnessCoherenceOptions): SensorReading {
  const maxReview = opts.maxReviewIncoherence ?? DEFAULT_MAX_REVIEW;
  const workflows = loadWorkflows(opts.repoRoot, opts.workflowDir);
  const findings: SensorFinding[] = [];
  // Fail closed: a listed workflow the loader could not read is never silently dropped.
  const loaded = new Set(workflows.map((workflow) => workflow.file));
  const unreadable = listWorkflowFiles(opts.repoRoot, opts.workflowDir).filter(
    (file) => !loaded.has(file),
  );
  for (const file of unreadable)
    findings.push({
      severity: 'error',
      code: 'HARNESS_COHERENCE_WORKFLOW_UNREADABLE',
      message: `${file} could not be read; its concurrency coherence is unproved.`,
    });

  if (workflows.length === 0 && unreadable.length === 0) {
    return buildSensorReading({
      sensorName: 'harness-coherence',
      sensorKind: 'harness_coherence',
      command: ['devai', 'sense-harness-coherence'],
      status: 'review',
      deterministic: true,
      tier: 'L0',
      ...(opts.now !== undefined && { timestamp: opts.now }),
      findings: [
        {
          severity: 'info',
          code: 'HARNESS_COHERENCE_NO_WORKFLOWS',
          message: 'No workflows found.',
        },
      ],
      metrics: { workflow_count: 0, incoherence_score: 0 },
    });
  }

  // Action-version drift.
  const actionRefs = new Map<string, Set<string>>();
  for (const wf of workflows) {
    for (const use of wf.actionUses) {
      if (use.owner === '' || use.ref === '') continue;
      const key = `${use.owner}/${use.repo}`;
      let set = actionRefs.get(key);
      if (set === undefined) {
        set = new Set();
        actionRefs.set(key, set);
      }
      set.add(use.ref);
    }
  }
  let driftCount = 0;
  for (const [key, refs] of actionRefs.entries()) {
    if (refs.size > 1) {
      driftCount += 1;
      findings.push({
        severity: 'warning',
        code: 'HARNESS_COHERENCE_ACTION_VERSION_DRIFT',
        message: `Action ${key} pinned to multiple versions across workflows: ${Array.from(refs).join(', ')}`,
      });
    }
  }

  // Permissions discipline.
  const withPerms = workflows.filter((w) => w.hasPermissionsBlock).length;
  const withoutPerms = workflows.length - withPerms;
  const permissionsMixed = withPerms > 0 && withoutPerms > 0 ? 1 : 0;
  if (permissionsMixed === 1) {
    findings.push({
      severity: 'warning',
      code: 'HARNESS_COHERENCE_PERMISSIONS_MIXED',
      message: `${String(withPerms)} workflows declare permissions, ${String(withoutPerms)} do not.`,
    });
  }

  // Concurrency discipline. Ordinary ref-scoped observations cancel stale
  // runs; releases, schedules, and other shared-resource paths serialize.
  const withConcurrency = workflows.filter((w) => w.hasConcurrencyBlock).length;
  const withoutConcurrency = workflows.length - withConcurrency;
  const concurrencyMixed = withConcurrency > 0 && withoutConcurrency > 0 ? 1 : 0;
  if (concurrencyMixed === 1) {
    findings.push({
      severity: 'info',
      code: 'HARNESS_COHERENCE_CONCURRENCY_MIXED',
      message: `${String(withConcurrency)} workflows declare concurrency, ${String(withoutConcurrency)} do not.`,
    });
  }

  let concurrencySemanticIssues = 0;
  for (const workflow of workflows) {
    const declaration = concurrencyDeclaration(workflow.file);
    const events = workflowEvents(readFileSync(workflow.file, 'utf8'));
    const serialize = requiresSerialization(workflow.relativeFile, workflow.file);
    const jobs = workflow.jobs.map((job) => ({
      ...job,
      ...jobEffectFacts(readFileSync(workflow.file, 'utf8'), opts.repoRoot, job.name),
    }));
    const effectful = jobs.some((job) => job.effect !== 'read-only');
    const jobLocks =
      jobs.length > 0 &&
      jobs.every((job) => {
        const lock = job.concurrency;
        if (job.effect === 'unknown' || !lock || !lock.group || lock.cancelInProgress === null)
          return false;
        if (job.effect === 'publication')
          return (
            lock.cancelInProgress === false &&
            lock.group.toLowerCase() === 'devai-pages-publication'
          );
        return (
          lock.cancelInProgress === !serialize &&
          (serialize ||
            (supersedingGroupScoped(lock.group, events) &&
              concurrencyGroupContexts(lock.group)?.includes('github.ref') === true))
        );
      });
    const aliases = jobs.some((a) =>
      jobs.some(
        (b) =>
          a !== b &&
          a.effect !== b.effect &&
          // Two jobs without a job-level group share no lock (#325).
          a.concurrency !== undefined &&
          b.concurrency !== undefined &&
          a.concurrency.group.toLowerCase() === b.concurrency.group.toLowerCase(),
      ),
    );
    const bypass = jobs.some(
      (job) =>
        job.effect === 'publication' &&
        job.needs?.length &&
        /\b(?:always|failure|cancelled)\s*\(/u.test(job.condition ?? ''),
    );
    const valid =
      !aliases &&
      !bypass &&
      jobs.every((j) => j.effect !== 'unknown') &&
      (declaration === null
        ? jobLocks
        : declaration.group.length > 0 &&
          declaration.cancelInProgress === !(serialize || effectful) &&
          (declaration.cancelInProgress !== true ||
            supersedingGroupScoped(declaration.group, events)) &&
          (!effectful || declaration.cancelInProgress === false));
    if (valid) continue;
    concurrencySemanticIssues += 1;
    findings.push({
      severity: 'warning',
      code: 'HARNESS_COHERENCE_CONCURRENCY_POLICY',
      message: `${workflow.relativeFile} must declare a non-empty concurrency group with cancel-in-progress: ${serialize ? 'false (serialized)' : 'true (superseding)'}.`,
    });
  }

  const incoherence = driftCount + permissionsMixed + concurrencySemanticIssues + unreadable.length;
  let status: SensorStatus;
  if (incoherence === 0) status = 'pass';
  else if (incoherence <= maxReview) status = 'review';
  else status = 'fail';

  return buildSensorReading({
    sensorName: 'harness-coherence',
    sensorKind: 'harness_coherence',
    command: ['devai', 'sense-harness-coherence'],
    status,
    deterministic: true,
    tier: 'L0',
    ...(opts.now !== undefined && { timestamp: opts.now }),
    findings,
    metrics: {
      workflow_count: workflows.length,
      ...(unreadable.length === 0 ? {} : { unreadable_workflows: unreadable.length }),
      action_version_drift_count: driftCount,
      permissions_mixed: permissionsMixed,
      concurrency_mixed: concurrencyMixed,
      concurrency_semantic_issues: concurrencySemanticIssues,
      incoherence_score: incoherence,
      max_review_incoherence: maxReview,
    },
  });
}
