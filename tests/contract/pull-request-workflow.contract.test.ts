// ADR-CHK-0003, Inspector Adversarial Acceptance IA-001 and IA-002 (workflow
// side): the pull-request workflow restores the check-runner bootstrap from a
// cache keyed by the digest of the TypeScript inputs it compiles, compiles
// only on a cache miss, runs the affected plan in one step (never from the
// release gate script), and carries no path filter a candidate could edit to
// suppress checks.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, parseDocument } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKFLOW = join(ROOT, '.github/workflows/pull-request-checks.yml');
const BOOTSTRAP_OUTPUT = '.devai/state/pr-bootstrap';
const PINNED_CACHE_ACTION = /^actions\/cache(?:\/restore)?@[0-9a-f]{40}$/u;
const BOOTSTRAP_COMPILE = /\brelease:bootstrap\b|scripts\/process\/bootstrap-check-runner\.mjs/u;
const BOOTSTRAP_CLI = /pr-bootstrap\/cli\/bin\.js/u;
const AFFECTED_CHECK = /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\b[^\n;&|]*\s--affected\b/gu;
const GATE_SCRIPT = join(ROOT, 'scripts/run-pr-release-gate.mjs');

type Step = Readonly<{
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Readonly<Record<string, unknown>>;
  env?: Readonly<Record<string, unknown>>;
}>;
type Workflow = Readonly<{
  on?: Readonly<Record<string, unknown>>;
  jobs?: Readonly<Record<string, Readonly<{ steps?: readonly Step[] }>>>;
}>;

const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
const steps: readonly Step[] = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);

function cacheSteps(): readonly Step[] {
  return steps.filter(
    (step) =>
      typeof step.uses === 'string' &&
      /^actions\/cache\b/u.test(step.uses) &&
      String(step.with?.path ?? '').includes(BOOTSTRAP_OUTPUT),
  );
}

function stepText(step: Step): string {
  return [step.if ?? '', step.run ?? '', JSON.stringify(step.env ?? {})].join('\n');
}

describe('pull-request workflow shape (ADR-CHK-0003)', () => {
  it('carries no path filter on the pull_request trigger (IA-002)', () => {
    const trigger = (workflow.on?.pull_request ?? {}) as Readonly<Record<string, unknown>>;
    expect(Object.keys(trigger)).not.toContain('paths');
    expect(Object.keys(trigger)).not.toContain('paths-ignore');
  });

  it('restores the bootstrap output from a pinned cache step (IA-001)', () => {
    const caches = cacheSteps();
    expect(caches, `a cache step whose path holds ${BOOTSTRAP_OUTPUT}`).toHaveLength(1);
    expect(caches[0]?.uses ?? '').toMatch(PINNED_CACHE_ACTION);
    expect(caches[0]?.id, 'the cache step has an id its hit output is read by').toMatch(/\S/u);
  });

  it('keys the bootstrap cache by the digest of the TypeScript inputs', () => {
    const key = String(cacheSteps()[0]?.with?.key ?? '');
    expect(key, 'the cache key digests files').toMatch(/hashFiles\(/u);
    const hashed = [...key.matchAll(/hashFiles\(([^)]*)\)/gu)].map((match) => match[1] ?? '');
    expect(
      hashed.some((argument) => /\.ts\b|\.tsx?['"*]|tsconfig/u.test(argument)),
      `hashFiles covers TypeScript sources or tsconfig inputs: ${key}`,
    ).toBe(true);
  });

  it('restores the cache before the bootstrap is compiled or invoked', () => {
    const cacheIndex = steps.findIndex((step) => cacheSteps().includes(step));
    const firstUse = steps.findIndex((step) => {
      const run = step.run ?? '';
      return BOOTSTRAP_COMPILE.test(run) || BOOTSTRAP_CLI.test(run);
    });
    expect(cacheIndex, 'the cache step exists').toBeGreaterThanOrEqual(0);
    expect(firstUse, 'a step compiles or invokes the bootstrap').toBeGreaterThanOrEqual(0);
    expect(cacheIndex).toBeLessThan(firstUse);
  });

  it('compiles the bootstrap only on a cache miss', () => {
    const cacheId = cacheSteps()[0]?.id;
    expect(cacheId, 'the cache step has an id').toBeDefined();
    const compiling = steps.filter((step) => BOOTSTRAP_COMPILE.test(step.run ?? ''));
    expect(compiling, 'a step compiles the bootstrap').not.toEqual([]);
    const hitOutput = new RegExp(
      `steps\\.${String(cacheId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.outputs\\.cache-hit`,
      'u',
    );
    for (const step of compiling) {
      expect(stepText(step), `step "${step.name ?? ''}" is conditioned on the cache hit`).toMatch(
        hitOutput,
      );
    }
  });

  it('runs the affected plan in exactly one workflow step', () => {
    const affected = steps.filter((step) => [...(step.run ?? '').matchAll(AFFECTED_CHECK)].length);
    expect(
      affected.map((step) => step.name ?? step.id ?? ''),
      'workflow steps that run check --affected',
    ).toHaveLength(1);
    expect([...(affected[0]?.run ?? '').matchAll(AFFECTED_CHECK)]).toHaveLength(1);
  });

  it('leaves the affected plan out of the pull-request release gate script', () => {
    // The gate stays in the workflow for the commit range, the bump floor, and
    // the release-profile preflight; only its code, not its comments, is read.
    const code = readFileSync(GATE_SCRIPT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    expect(code, 'the gate script invokes no --affected plan').not.toMatch(/--affected\b/u);
  });

  it('still runs the preflight probes', () => {
    const preflight = steps.filter((step) =>
      /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\b[^\n;&|]*\s--preflight\b/u.test(
        step.run ?? '',
      ),
    );
    expect(preflight).toHaveLength(1);
  });
});

// ADR-CHK-0004, Inspector Adversarial Acceptance IA-003 and IA-004: the gate
// triggers on pull_request and merge_group, binds each event to its own
// candidate and base (docs/dev/operations/remote-preflight-contract.md, Queue
// admission), keeps the one check name, keys concurrency per queue entry so no
// entry cancels another, and fetches full history under both events. The
// workflow's expressions are evaluated under a synthetic context of each event,
// so the tests pin the bound values rather than one spelling of them.

type Context = Readonly<Record<string, unknown>>;

const WORKFLOW_NAME = 'Pull request preflight';
const PR = {
  number: 42,
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  merge: 'c'.repeat(40),
} as const;
const QUEUE = [
  { head: '1'.repeat(40), base: '2'.repeat(40) },
  { head: '3'.repeat(40), base: '1'.repeat(40) },
] as const;

function githubContext(event: 'pull_request' | 'merge_group', payload: Context, sha: string) {
  return {
    github: { event_name: event, workflow: WORKFLOW_NAME, sha, event: payload },
    runner: { os: 'Linux' },
    steps: {},
    env: {},
  } as const;
}

function pullRequestContext(head: string = PR.head): Context {
  return githubContext(
    'pull_request',
    {
      number: PR.number,
      pull_request: { number: PR.number, head: { sha: head }, base: { sha: PR.base } },
    },
    PR.merge,
  );
}

function mergeGroupContext(entry: Readonly<{ head: string; base: string }>): Context {
  return githubContext(
    'merge_group',
    {
      merge_group: {
        head_sha: entry.head,
        base_sha: entry.base,
        head_ref: `refs/heads/gh-readonly-queue/main/pr-7-${entry.base}`,
        base_ref: 'refs/heads/main',
      },
    },
    entry.head,
  );
}

type Token = Readonly<{ kind: 'op' | 'str' | 'num' | 'id'; value: string }>;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /\s*(?:(==|!=|&&|\|\||<=|>=|[!()<>,[\]])|'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_*][A-Za-z0-9_-]*)*))/uy;
  let index = 0;
  while (index < source.length) {
    if (/^\s*$/u.test(source.slice(index))) break;
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (match === null) throw new Error(`unsupported expression syntax at ${source.slice(index)}`);
    index = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: 'op', value: match[1] });
    else if (match[2] !== undefined)
      tokens.push({ kind: 'str', value: match[2].replaceAll("''", "'") });
    else if (match[3] !== undefined) tokens.push({ kind: 'num', value: match[3] });
    else tokens.push({ kind: 'id', value: match[4] ?? '' });
  }
  return tokens;
}

function truthy(value: unknown): boolean {
  return !(value === null || value === undefined || value === false || value === '' || value === 0);
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function loose(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : (value ?? null);
}

/** A GitHub Actions expression evaluator for the subset a workflow binding uses. */
function evaluate(expression: string, context: Context): unknown {
  const tokens = tokenize(expression);
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const take = (value?: string): Token => {
    const token = tokens[position];
    if (token === undefined || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? 'a token'} in ${expression}`);
    }
    position += 1;
    return token;
  };
  const lookup = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (value, key) =>
          value !== null && typeof value === 'object'
            ? (value as Readonly<Record<string, unknown>>)[key]
            : undefined,
        context,
      ) ?? null;
  const call = (name: string, args: readonly unknown[]): unknown => {
    switch (name.toLowerCase()) {
      case 'format':
        return render(args[0]).replace(/\{(\d+)\}/gu, (_all, index: string) =>
          render(args[Number(index) + 1]),
        );
      case 'contains':
        return render(args[0]).toLowerCase().includes(render(args[1]).toLowerCase());
      case 'startswith':
        return render(args[0]).toLowerCase().startsWith(render(args[1]).toLowerCase());
      case 'endswith':
        return render(args[0]).toLowerCase().endsWith(render(args[1]).toLowerCase());
      case 'always':
      case 'success':
        return true;
      case 'failure':
      case 'cancelled':
        return false;
      default:
        throw new Error(`unsupported function ${name} in ${expression}`);
    }
  };
  const primary = (): unknown => {
    const token = take();
    if (token.kind === 'str') return token.value;
    if (token.kind === 'num') return Number(token.value);
    if (token.kind === 'op' && token.value === '(') {
      const value = or();
      take(')');
      return value;
    }
    if (token.kind === 'op' && token.value === '!') return !truthy(primary());
    if (token.kind === 'id') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      if (peek()?.value === '(') {
        take('(');
        const args: unknown[] = [];
        while (peek()?.value !== ')') {
          args.push(or());
          if (peek()?.value === ',') take(',');
        }
        take(')');
        return call(token.value, args);
      }
      return lookup(token.value);
    }
    throw new Error(`unexpected ${token.value} in ${expression}`);
  };
  const equality = (): unknown => {
    let left = primary();
    while (peek()?.value === '==' || peek()?.value === '!=') {
      const operator = take().value;
      const right = primary();
      left = operator === '==' ? loose(left) === loose(right) : loose(left) !== loose(right);
    }
    return left;
  };
  const and = (): unknown => {
    let left = equality();
    while (peek()?.value === '&&') {
      take('&&');
      const right = equality();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  function or(): unknown {
    let left = and();
    while (peek()?.value === '||') {
      take('||');
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  }
  const value = or();
  if (position !== tokens.length) throw new Error(`trailing tokens in ${expression}`);
  return value;
}

/** A workflow value with every ${{ }} interpolated under the context. */
function interpolate(value: unknown, context: Context, empty = ''): string {
  const text = render(value);
  return text.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_all, inner: string) => {
    const rendered = render(evaluate(inner, context));
    return rendered === '' ? empty : rendered;
  });
}

/** An `if:` condition, which GitHub reads as an expression with or without ${{ }}. */
function condition(value: unknown, context: Context): boolean {
  if (value === undefined) return true;
  const text = render(value);
  const whole = /^\s*\$\{\{([\s\S]*?)\}\}\s*$/u.exec(text);
  return truthy(evaluate(whole?.[1] ?? text, context));
}

type Job = Readonly<{
  name?: string;
  if?: string;
  env?: Readonly<Record<string, unknown>>;
  steps?: readonly Step[];
}>;
type FullWorkflow = Workflow &
  Readonly<{
    env?: Readonly<Record<string, unknown>>;
    concurrency?: Readonly<Record<string, unknown>>;
  }>;

const fullWorkflow = workflow as FullWorkflow;
const gateJobs = Object.values(fullWorkflow.jobs ?? {}) as readonly Job[];
const gateJob = gateJobs.find((job) => job.name === 'devai-release-gate');

/** The shell environment a step sees: workflow, job, then step env, each interpolated. */
function stepEnvironment(step: Step, context: Context): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const scope of [fullWorkflow.env, gateJob?.env, step.env]) {
    for (const [name, value] of Object.entries(scope ?? {})) {
      environment[name] = interpolate(value, context);
    }
  }
  return environment;
}

/** Resolves one shell word to its value: a literal, or a variable from the step environment. */
function shellWord(word: string, environment: Readonly<Record<string, string>>): string {
  const unquoted = word.replace(/^(["'])(.*)\1$/u, '$2');
  const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/u.exec(unquoted);
  if (variable === null) return unquoted;
  return environment[variable[1] ?? variable[2] ?? ''] ?? '';
}

/** Every value the workflow passes as --base or as the release:pr-gate argument, per event. */
function boundBases(context: Context): Readonly<{ base: string[]; gate: string[] }> {
  const base: string[] = [];
  const gate: string[] = [];
  for (const step of gateJob?.steps ?? []) {
    if (typeof step.run !== 'string') continue;
    const environment = stepEnvironment(step, context);
    // An expression that renders empty stays one (empty) shell word.
    const run = interpolate(step.run, context, "''");
    for (const match of run.matchAll(/(?:^|\s)--base(?:\s+|=)(\S+)/gu)) {
      base.push(shellWord(match[1] ?? '', environment));
    }
    for (const match of run.matchAll(/\brelease:pr-gate\b(?:\s+--)?\s+(\S+)/gu)) {
      gate.push(shellWord(match[1] ?? '', environment));
    }
  }
  return { base, gate };
}

function checkoutStep(): Step | undefined {
  return gateJob?.steps?.find(
    (step) => typeof step.uses === 'string' && /^actions\/checkout@/u.test(step.uses),
  );
}

describe('merge_group lane of the pull-request workflow (ADR-CHK-0004)', () => {
  it('triggers on exactly pull_request and merge_group, neither carrying a path filter (IA-004)', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['merge_group', 'pull_request']);
    const queue = (workflow.on?.merge_group ?? {}) as Readonly<Record<string, unknown>>;
    expect(Object.keys(queue)).not.toContain('paths');
    expect(Object.keys(queue)).not.toContain('paths-ignore');
    expect(Object.keys(queue)).not.toContain('branches-ignore');
  });

  it('reports the one check name devai-release-gate under both events (IA-003)', () => {
    expect(gateJobs, 'exactly one job, so branch protection needs one required check').toHaveLength(
      1,
    );
    expect(gateJob?.name, 'the job name is the literal check name, not an expression').toBe(
      'devai-release-gate',
    );
    for (const context of [pullRequestContext(), mergeGroupContext(QUEUE[0])]) {
      const event = (context.github as Readonly<{ event_name: string }>).event_name;
      expect(condition(gateJob?.if, context), `the gate job runs under ${event}`).toBe(true);
      for (const step of gateJob?.steps ?? []) {
        expect(
          condition(step.if, context),
          `step "${step.name ?? step.id ?? ''}" runs under ${event}`,
        ).toBe(true);
      }
    }
  });

  it('checks out the event candidate: the queue head under merge_group', () => {
    const ref = checkoutStep()?.with?.ref;
    expect(interpolate(ref, pullRequestContext())).toBe(PR.head);
    for (const entry of QUEUE) {
      expect(interpolate(ref, mergeGroupContext(entry)), 'the merge_group head_sha').toBe(
        entry.head,
      );
    }
  });

  it('passes the event base to both --base arguments: merge_group.base_sha under merge_group (IA-003)', () => {
    const pull = boundBases(pullRequestContext());
    expect(pull.base, 'the preflight and the affected check each take --base').toHaveLength(2);
    expect(pull.base).toEqual([PR.base, PR.base]);
    for (const entry of QUEUE) {
      expect(boundBases(mergeGroupContext(entry)).base).toEqual([entry.base, entry.base]);
    }
  });

  it('passes the event base to release:pr-gate: merge_group.base_sha under merge_group', () => {
    expect(boundBases(pullRequestContext()).gate).toEqual([PR.base]);
    for (const entry of QUEUE) {
      expect(boundBases(mergeGroupContext(entry)).gate).toEqual([entry.base]);
    }
  });

  it('keys concurrency per queue entry so no entry cancels another (IA-004)', () => {
    const concurrency = fullWorkflow.concurrency ?? {};
    expect(concurrency['cancel-in-progress']).toBe(true);
    const group = concurrency.group;
    const pullGroup = interpolate(group, pullRequestContext());
    expect(pullGroup).toContain(WORKFLOW_NAME);
    expect(pullGroup).toMatch(/\bpr\b/u);
    expect(pullGroup).toContain(String(PR.number));
    expect(
      interpolate(group, pullRequestContext('d'.repeat(40))),
      'a new head of the same pull request cancels the previous head',
    ).toBe(pullGroup);
    const queueGroups = QUEUE.map((entry) => interpolate(group, mergeGroupContext(entry)));
    QUEUE.forEach((entry, index) => {
      expect(queueGroups[index]).toContain(WORKFLOW_NAME);
      expect(queueGroups[index]).toMatch(/\bmq\b/u);
      expect(queueGroups[index], 'the entry head sha keys its group').toContain(entry.head);
    });
    expect(new Set(queueGroups).size, 'two queue entries never share a group').toBe(QUEUE.length);
    expect(
      queueGroups,
      'a queue entry never shares a group with a pull-request head',
    ).not.toContain(pullGroup);
  });

  it('fetches full history under both events', () => {
    const depth = checkoutStep()?.with?.['fetch-depth'];
    for (const context of [pullRequestContext(), ...QUEUE.map(mergeGroupContext)]) {
      expect(interpolate(depth, context)).toBe('0');
    }
  });
});

// ADR-CHK-0004, Inspector Adversarial Acceptance IA-004 (checker side): a
// workflow edit that removes the merge_group trigger or lets one queue entry
// cancel another fails scripts/check-workflows.mjs. Each mutation is applied to
// a scratch copy of the workflow tree, so only the mutation can add a finding.

interface WorkflowFinding {
  readonly code: string;
  readonly file: string;
  readonly detail: string;
}
const { checkWorkflowTree } = (await import(
  pathToFileURL(join(ROOT, 'scripts/check-workflows.mjs')).href
)) as { checkWorkflowTree: (root: string) => { ok: boolean; findings: WorkflowFinding[] } };

const PREFLIGHT_FILE = 'pull-request-checks.yml';
const scratchRoots: string[] = [];
afterEach(() =>
  scratchRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function workflowTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'devai-merge-group-check-'));
  scratchRoots.push(root);
  cpSync(join(ROOT, '.github/workflows'), join(root, '.github/workflows'), { recursive: true });
  cpSync(join(ROOT, '.github/actions'), join(root, '.github/actions'), { recursive: true });
  for (const path of ['.devai/config/toolchain.json', 'law/policy/credential-requirements.json']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), readFileSync(join(ROOT, path)));
  }
  return root;
}

/** Edits the preflight workflow through the YAML document, keeping its comments. */
function mutateWorkflow(root: string, edit: (document: ReturnType<typeof parseDocument>) => void) {
  const path = join(root, '.github/workflows', PREFLIGHT_FILE);
  const document = parseDocument(readFileSync(path, 'utf8'));
  edit(document);
  writeFileSync(path, String(document));
}

function preflightFindings(root: string): readonly WorkflowFinding[] {
  return checkWorkflowTree(root).findings.filter((finding) => finding.file === PREFLIGHT_FILE);
}

describe('workflow checker pins the merge_group lane (ADR-CHK-0004 IA-004)', () => {
  it('accepts the committed workflow tree', () => {
    const result = checkWorkflowTree(workflowTree());
    expect(result.findings).toEqual([]);
  });

  it('fails a workflow whose merge_group trigger is removed', () => {
    const root = workflowTree();
    mutateWorkflow(root, (document) => {
      document.deleteIn(['on', 'merge_group']);
    });
    expect(
      Object.keys(
        (parse(readFileSync(join(root, '.github/workflows', PREFLIGHT_FILE), 'utf8')) as Workflow)
          .on ?? {},
      ),
    ).toEqual(['pull_request']);
    expect(
      preflightFindings(root).map((finding) => finding.code),
      'a pull_request-only preflight is refused',
    ).toContain('CI_PREFLIGHT_TRIGGER_INVALID');
  });

  it('fails a workflow that adds a trigger beyond the pair', () => {
    const root = workflowTree();
    mutateWorkflow(root, (document) => {
      document.setIn(['on', 'push'], { branches: ['main'] });
    });
    expect(preflightFindings(root).map((finding) => finding.code)).toContain(
      'CI_PREFLIGHT_TRIGGER_INVALID',
    );
  });

  it('fails a concurrency group under which one queue entry cancels another', () => {
    const root = workflowTree();
    // Keyed by pull-request number alone, every merge_group run renders the same
    // group, so each queue entry cancels the one before it.
    mutateWorkflow(root, (document) => {
      document.setIn(
        ['concurrency', 'group'],
        '${{ github.workflow }}-pr-${{ github.event.pull_request.number }}',
      );
    });
    expect(preflightFindings(root).map((finding) => finding.code)).toContain(
      'CI_PREFLIGHT_CONCURRENCY_INVALID',
    );
  });

  it('fails a queue group that cancels across entries', () => {
    const root = workflowTree();
    mutateWorkflow(root, (document) => {
      document.setIn(['concurrency', 'group'], '${{ github.workflow }}-mq');
    });
    expect(preflightFindings(root).map((finding) => finding.code)).toContain(
      'CI_PREFLIGHT_CONCURRENCY_INVALID',
    );
  });
});
