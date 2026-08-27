/**
 * Output-only GitHub Issues projector.
 *
 * The projector never originates governance state. It reads sealed local
 * evidence, renders it through the public-safe profile, and pushes it outward.
 * Nothing it reads back from GitHub is trusted: comments, labels, edits, and
 * issue state are untrusted output state and can never authorize, route, close,
 * merge, or publish anything. Every remote failure is classified and reported
 * as a failure to observe, never as a verdict.
 *
 * Credentials are never handled here. The transport shells out to the already
 * authenticated `gh` boundary, which resolves its own auth; DEVAI neither reads
 * nor persists a token.
 */
import { spawnSync } from '@devai-nyx/authority';
import type { ProjectionBatch, ProjectionFailureClass } from '@devai-nyx/loop';

export interface GhResponse {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable so the projector's failure handling is testable without a network. */
export type GhTransport = (args: readonly string[]) => GhResponse;

export const defaultGhTransport: GhTransport = (args) => {
  const result = spawnSync('gh', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as { status: number | null; stdout?: string; stderr?: string; error?: Error };
  if (result.error !== undefined) {
    return { status: 127, stdout: '', stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

export class ProjectorError extends Error {
  constructor(
    readonly code: string,
    readonly classification: ProjectionFailureClass,
    readonly detail: string,
  ) {
    super(code);
    this.name = 'ProjectorError';
  }
}

/**
 * Classify a transport failure. The classification decides whether a retry can
 * possibly help, so an unrecognized failure is treated as a service fault
 * rather than optimistically retried forever or silently swallowed.
 */
export function classifyGhFailure(response: GhResponse): ProjectionFailureClass {
  const text = `${response.stderr}\n${response.stdout}`;
  if (/rate limit|secondary rate|abuse detection|\b429\b/iu.test(text)) return 'rate-limit';
  if (/gh auth login|not logged into|authentication|bad credentials|\b401\b/iu.test(text)) {
    return 'authentication';
  }
  if (/\b403\b|forbidden|resource not accessible|permission/iu.test(text)) return 'permission';
  if (/\b404\b|not found/iu.test(text)) return 'missing-resource';
  if (/\b422\b|validation failed|unprocessable/iu.test(text)) return 'validation';
  return 'service';
}

export function isRetryable(classification: ProjectionFailureClass): boolean {
  return classification === 'rate-limit' || classification === 'service';
}

export interface RetryPolicy {
  readonly max_attempts: number;
  readonly initial_delay_ms: number;
  readonly max_delay_ms: number;
  readonly multiplier: number;
}

/** Bounded exponential backoff. Exposed so tests assert the schedule directly. */
export function backoffDelays(policy: RetryPolicy): readonly number[] {
  const delays: number[] = [];
  let delay = policy.initial_delay_ms;
  for (let attempt = 1; attempt < policy.max_attempts; attempt += 1) {
    delays.push(Math.min(delay, policy.max_delay_ms));
    delay *= policy.multiplier;
  }
  return delays;
}

export function roundIssueMarker(round: string): string {
  return `devai-governance-round:${round}`;
}

/**
 * Render the issue body. The marker is the durable identity; the prose around
 * it is for humans and carries no authority.
 */
export function renderIssueBody(options: {
  readonly round: string;
  readonly repository: string;
  readonly adapterVersion: string;
}): string {
  return [
    `<!-- ${roundIssueMarker(options.round)} -->`,
    `# Governed round ${options.round}`,
    '',
    'This issue is a **read-only projection** of DEVAI governance events recorded',
    `locally in \`${options.repository}\`. It is rebuildable from sealed local evidence.`,
    '',
    'Comments, labels, and edits on this issue are untrusted output state. They',
    'cannot authorize, route, close, merge, or publish anything in DEVAI.',
    '',
    'Only DEVAI-mediated actions appear here. Editor and shell activity outside',
    'the DEVAI runtime is **not** covered and is never implied to be.',
    '',
    `Adapter: \`github-issues\` v${options.adapterVersion} · disclosure profile: \`public-safe-v1\``,
    '',
  ].join('\n');
}

/** Render one batch as an issue comment carrying its stable hidden marker. */
export function renderBatchComment(batch: ProjectionBatch, projectedAt: string): string {
  const rows = batch.entries.map((entry) => {
    const cells = [
      `\`${entry.event_id}\``,
      entry.role,
      entry.kind,
      entry.status ?? '—',
      entry.mediated ? 'mediated' : '**unmediated**',
      entry.public_safe_summary.replace(/\|/gu, '\\|'),
      entry.commit === null ? '—' : `\`${entry.commit.slice(0, 12)}\``,
      `\`${entry.payload_digest_sha256.slice(0, 12)}\``,
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [
    `<!-- ${batch.marker} -->`,
    `### Batch \`${batch.batch_id}\` · ${batch.reason} · ${String(batch.event_ids.length)} event(s)`,
    '',
    '| Event | Role | Kind | Status | Coverage | Summary | Commit | Payload digest |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...batch.sessions.map(
      (session) =>
        `- Session \`${session.authority_session_id}\` sequence ${String(session.first)}–${String(session.last)}`,
    ),
    '',
    `Segment digests: ${batch.segment_digests_sha256.map((digest) => `\`${digest.slice(0, 12)}\``).join(', ')}`,
    `Batch digest: \`${batch.batch_digest_sha256}\``,
    `Projected at ${projectedAt} by \`github-issues\` v${batch.adapter.adapter_version}.`,
    '',
    'Payload content is withheld by the `public-safe-v1` disclosure profile;',
    'the digests above bind what was withheld.',
    '',
  ].join('\n');
}

function ghJson<T>(transport: GhTransport, args: readonly string[]): T {
  const response = transport(args);
  if (response.status !== 0) {
    throw new ProjectorError(
      'TRACKING_PROJECTION_FAILED',
      classifyGhFailure(response),
      response.stderr.trim().slice(0, 400),
    );
  }
  try {
    return JSON.parse(response.stdout) as T;
  } catch {
    // A success status with an unparseable body is ambiguous: the write may or
    // may not have landed. Reconcile before retrying rather than duplicating.
    throw new ProjectorError(
      'TRACKING_PROJECTION_RESPONSE_MALFORMED',
      'ambiguous-response',
      'response body was not valid JSON',
    );
  }
}

export interface ProjectorContext {
  readonly transport: GhTransport;
  readonly repository: string;
}

interface IssueSearchResult {
  readonly items?: readonly { readonly number?: number }[];
}

/** Locate the round's issue by its durable marker. Never creates one. */
export function findRoundIssue(context: ProjectorContext, round: string): number | undefined {
  const query = `repo:${context.repository} in:body "${roundIssueMarker(round)}"`;
  const result = ghJson<IssueSearchResult>(context.transport, [
    'api',
    '-X',
    'GET',
    'search/issues',
    '-f',
    `q=${query}`,
  ]);
  return result.items?.[0]?.number;
}

export function createRoundIssue(
  context: ProjectorContext,
  options: { readonly round: string; readonly adapterVersion: string },
): number {
  const created = ghJson<{ readonly number?: number }>(context.transport, [
    'api',
    '-X',
    'POST',
    `repos/${context.repository}/issues`,
    '-f',
    `title=DEVAI governed round ${options.round}`,
    '-f',
    `body=${renderIssueBody({ ...options, repository: context.repository })}`,
  ]);
  if (typeof created.number !== 'number') {
    throw new ProjectorError(
      'TRACKING_ISSUE_CREATE_AMBIGUOUS',
      'ambiguous-response',
      'issue creation returned no number',
    );
  }
  return created.number;
}

interface CommentRecord {
  readonly id?: number;
  readonly body?: string;
}

export function findBatchComment(
  context: ProjectorContext,
  issue: number,
  marker: string,
): number | undefined {
  const comments = ghJson<readonly CommentRecord[]>(context.transport, [
    'api',
    '-X',
    'GET',
    `repos/${context.repository}/issues/${String(issue)}/comments`,
    '--paginate',
  ]);
  return comments.find((comment) => (comment.body ?? '').includes(marker))?.id;
}

export interface ProjectBatchResult {
  readonly comment_id: number;
  /** True when the batch was already present and no new comment was written. */
  readonly already_present: boolean;
}

/**
 * Post one batch idempotently.
 *
 * The marker search before the write is what makes a retry after an ambiguous
 * response safe: if a previous attempt landed, the marker is found and no
 * duplicate is created. After an ambiguous write the projector reconciles
 * rather than blindly retrying.
 */
export function projectBatch(
  context: ProjectorContext,
  options: {
    readonly issue: number;
    readonly batch: ProjectionBatch;
    readonly projectedAt: string;
  },
): ProjectBatchResult {
  const existing = findBatchComment(context, options.issue, options.batch.marker);
  if (existing !== undefined) return { comment_id: existing, already_present: true };

  let created: { readonly id?: number };
  try {
    created = ghJson<{ readonly id?: number }>(context.transport, [
      'api',
      '-X',
      'POST',
      `repos/${context.repository}/issues/${String(options.issue)}/comments`,
      '-f',
      `body=${renderBatchComment(options.batch, options.projectedAt)}`,
    ]);
  } catch (error) {
    if (error instanceof ProjectorError && error.classification === 'ambiguous-response') {
      // The write may have landed. Look for the marker before deciding.
      const reconciled = findBatchComment(context, options.issue, options.batch.marker);
      if (reconciled !== undefined) return { comment_id: reconciled, already_present: true };
    }
    throw error;
  }
  if (typeof created.id !== 'number') {
    const reconciled = findBatchComment(context, options.issue, options.batch.marker);
    if (reconciled !== undefined) return { comment_id: reconciled, already_present: true };
    throw new ProjectorError(
      'TRACKING_COMMENT_CREATE_AMBIGUOUS',
      'ambiguous-response',
      'comment creation returned no id',
    );
  }
  return { comment_id: created.id, already_present: false };
}
