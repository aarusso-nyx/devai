// ADR-CHK-0003, Inspector Adversarial Acceptance IA-001 and IA-002 (workflow
// side): the pull-request workflow restores the check-runner bootstrap from a
// cache keyed by the digest of the TypeScript inputs it compiles, compiles
// only on a cache miss, runs the affected plan in one step (never from the
// release gate script), and carries no path filter a candidate could edit to
// suppress checks. Under ADR-CHK-0007 rule 11 the plan is split across the
// gate-cli and gate-rest partition jobs, so each of them holds that shape.
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
const AFFECTED_CHECK_LINE =
  /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\b[^\n;&|]*\s--affected\b/u;
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

/** ADR-CHK-0007 rule 11: the two partition jobs and the flag each passes with test:cli. */
const PARTITION_JOBS = ['gate-cli', 'gate-rest'] as const;
const PARTITION_FLAG = {
  'gate-cli': '--partition-include',
  'gate-rest': '--partition-exclude',
} as const;

function jobSteps(job: string): readonly Step[] {
  return workflow.jobs?.[job]?.steps ?? [];
}

function cacheStepsOf(steps: readonly Step[]): readonly Step[] {
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

  it('leaves the affected plan out of the pull-request release gate script', () => {
    // The gate stays in the workflow for the commit range, the bump floor, and
    // the release-profile preflight; only its code, not its comments, is read.
    const code = readFileSync(GATE_SCRIPT, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    expect(code, 'the gate script invokes no --affected plan').not.toMatch(/--affected\b/u);
  });

  it('runs the affected plan in the two partition jobs and nowhere else', () => {
    const running = Object.entries(workflow.jobs ?? {})
      .filter(([, job]) =>
        (job.steps ?? []).some((step) => [...(step.run ?? '').matchAll(AFFECTED_CHECK)].length > 0),
      )
      .map(([name]) => name)
      .sort();
    expect(running).toEqual([...PARTITION_JOBS]);
  });
});

describe.each(PARTITION_JOBS)(
  'the %s partition job (ADR-CHK-0003, ADR-CHK-0007 rule 11)',
  (job) => {
    const steps = jobSteps(job);
    const cacheSteps = (): readonly Step[] => cacheStepsOf(steps);

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

    it('runs its share of the affected plan in exactly one step', () => {
      const affected = steps.filter(
        (step) => [...(step.run ?? '').matchAll(AFFECTED_CHECK)].length,
      );
      expect(
        affected.map((step) => step.name ?? step.id ?? ''),
        'workflow steps that run check --affected',
      ).toHaveLength(1);
      const commands = [...(affected[0]?.run ?? '').matchAll(AFFECTED_CHECK)].map(
        (match) => match[0],
      );
      expect(commands).toHaveLength(1);
      const run = affected[0]?.run ?? '';
      const command = run.slice(run.search(AFFECTED_CHECK_LINE)).split('\n')[0] ?? '';
      expect(command, 'the affected check runs').toMatch(/\s--run\b/u);
      expect(command, `the ${job} partition`).toMatch(
        new RegExp(`\\s${PARTITION_FLAG[job]}(?:\\s+|=)test:cli(?:\\s|$)`, 'u'),
      );
      const other = job === 'gate-cli' ? PARTITION_FLAG['gate-rest'] : PARTITION_FLAG['gate-cli'];
      expect(command, 'never both partition flags').not.toContain(other);
    });

    it('still runs the preflight probes', () => {
      const preflight = steps.filter((step) =>
        /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\b[^\n;&|]*\s--preflight\b/u.test(
          step.run ?? '',
        ),
      );
      expect(preflight).toHaveLength(1);
    });
  },
);

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
const jobsByKey = (fullWorkflow.jobs ?? {}) as Readonly<Record<string, Job>>;
const gateJobs = Object.values(jobsByKey).filter((job) => job.name === 'devai-release-gate');
/** The aggregator: the one job that carries the required check name (ADR-CHK-0007 rule 11). */
const gateJob = gateJobs[0];

/** The shell environment a step sees: workflow, job, then step env, each interpolated. */
function stepEnvironment(
  job: Job | undefined,
  step: Step,
  context: Context,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const scope of [fullWorkflow.env, job?.env, step.env]) {
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
function boundBases(
  jobKey: string,
  context: Context,
): Readonly<{ base: string[]; gate: string[] }> {
  const base: string[] = [];
  const gate: string[] = [];
  const job = jobsByKey[jobKey];
  for (const step of job?.steps ?? []) {
    if (typeof step.run !== 'string') continue;
    const environment = stepEnvironment(job, step, context);
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

function checkoutStep(jobKey: string): Step | undefined {
  return jobsByKey[jobKey]?.steps?.find(
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
    // The aggregator and both partition jobs, with every step, run under both events.
    const running = [gateJob, ...PARTITION_JOBS.map((key) => jobsByKey[key])];
    for (const context of [pullRequestContext(), mergeGroupContext(QUEUE[0])]) {
      const event = (context.github as Readonly<{ event_name: string }>).event_name;
      for (const job of running) {
        expect(job, 'the job exists').toBeDefined();
        expect(condition(job?.if, context), `job ${job?.name ?? ''} runs under ${event}`).toBe(
          true,
        );
        for (const step of job?.steps ?? []) {
          expect(
            condition(step.if, context),
            `step "${step.name ?? step.id ?? ''}" runs under ${event}`,
          ).toBe(true);
        }
      }
    }
  });

  it.each(PARTITION_JOBS)(
    'checks out the event candidate in %s: the queue head under merge_group',
    (job) => {
      const ref = checkoutStep(job)?.with?.ref;
      expect(interpolate(ref, pullRequestContext())).toBe(PR.head);
      for (const entry of QUEUE) {
        expect(interpolate(ref, mergeGroupContext(entry)), 'the merge_group head_sha').toBe(
          entry.head,
        );
      }
    },
  );

  it.each(PARTITION_JOBS)(
    'passes the event base to both --base arguments of %s: merge_group.base_sha under merge_group (IA-003)',
    (job) => {
      const pull = boundBases(job, pullRequestContext());
      expect(pull.base, 'the preflight and the affected check each take --base').toHaveLength(2);
      expect(pull.base).toEqual([PR.base, PR.base]);
      for (const entry of QUEUE) {
        expect(boundBases(job, mergeGroupContext(entry)).base).toEqual([entry.base, entry.base]);
      }
    },
  );

  it('passes the event base to release:pr-gate, run once in gate-rest only', () => {
    expect(boundBases('gate-rest', pullRequestContext()).gate).toEqual([PR.base]);
    expect(boundBases('gate-cli', pullRequestContext()).gate).toEqual([]);
    for (const entry of QUEUE) {
      expect(boundBases('gate-rest', mergeGroupContext(entry)).gate).toEqual([entry.base]);
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

  it.each(PARTITION_JOBS)('fetches full history in %s under both events', (job) => {
    const depth = checkoutStep(job)?.with?.['fetch-depth'];
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

// ADR-CHK-0007 rule 11, Inspector Adversarial Acceptance IA-011 (workflow side): two
// partition jobs split the affected plan on test:cli, and the aggregator that carries the
// required check name needs both, runs under always(), reads only their reports and
// results, and executes no check node.

type GateJob = Job &
  Readonly<{
    needs?: string | readonly string[];
    permissions?: Readonly<Record<string, unknown>> | string;
  }>;
const RAW_JOBS = (fullWorkflow.jobs ?? {}) as Readonly<Record<string, GateJob>>;
const AGGREGATOR_KEY = Object.keys(RAW_JOBS).find(
  (key) => RAW_JOBS[key]?.name === 'devai-release-gate',
);
const PINNED_UPLOAD = /^actions\/upload-artifact@[0-9a-f]{40}$/u;
const PINNED_DOWNLOAD = /^actions\/download-artifact@[0-9a-f]{40}$/u;
const REPORT_ARTIFACT = {
  'gate-cli': 'devai-gate-report-cli',
  'gate-rest': 'devai-gate-report-rest',
};
const PRODUCERS = [
  /\bsense\s+run\s+trace_resolution\b/u,
  /\baudit\s+scorecard\b/u,
  /\bcheck\s+--only\s+blueprint\b/u,
  /\bsense\s+inventory\s+--slice\s+pack\b/u,
];
const CHECK_INVOCATION = /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\b/u;

function runText(jobKey: string): string {
  return (RAW_JOBS[jobKey]?.steps ?? []).map((step) => step.run ?? '').join('\n');
}

function aggregator(): GateJob {
  const job = AGGREGATOR_KEY === undefined ? undefined : RAW_JOBS[AGGREGATOR_KEY];
  if (job === undefined) throw new Error('no job carries the check name devai-release-gate');
  return job;
}

describe('three gate jobs (ADR-CHK-0007 rule 11)', () => {
  it('declares exactly the two partition jobs and the aggregator', () => {
    expect(AGGREGATOR_KEY).toBeDefined();
    expect(Object.keys(RAW_JOBS).sort()).toEqual([...PARTITION_JOBS, AGGREGATOR_KEY ?? ''].sort());
    for (const job of PARTITION_JOBS) {
      expect(RAW_JOBS[job]?.name, `${job} never carries the required check name`).not.toBe(
        'devai-release-gate',
      );
    }
  });

  it('makes the aggregator need both partition jobs and run under always()', () => {
    const needs = aggregator().needs;
    expect([...(typeof needs === 'string' ? [needs] : (needs ?? []))].sort()).toEqual([
      ...PARTITION_JOBS,
    ]);
    expect(String(aggregator().if ?? '')).toMatch(/\balways\(\s*\)/u);
  });

  it('runs the aggregator script on both reports and both job results', () => {
    const run = runText(AGGREGATOR_KEY ?? '');
    expect(run).toMatch(/\bnode\s+scripts\/aggregate-gate-partitions\.mjs\b/u);
    expect(run).toMatch(/--include-result\s+["']?\$\{\{\s*needs\.gate-cli\.result\s*\}\}/u);
    expect(run).toMatch(/--exclude-result\s+["']?\$\{\{\s*needs\.gate-rest\.result\s*\}\}/u);
    expect(run).toMatch(/--include-report\s+\S/u);
    expect(run).toMatch(/--exclude-report\s+\S/u);
  });

  it('downloads the two report artifacts into the aggregator with one pinned step', () => {
    const downloads = (aggregator().steps ?? []).filter(
      (step) => typeof step.uses === 'string' && /^actions\/download-artifact@/u.test(step.uses),
    );
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.uses).toMatch(PINNED_DOWNLOAD);
    // One pattern matches exactly the two report artifacts and nothing else.
    const pattern = String(downloads[0]?.with?.pattern ?? '');
    expect(pattern).toBe('devai-gate-report-*');
    for (const name of Object.values(REPORT_ARTIFACT)) {
      expect(name.startsWith(pattern.replace(/\*$/u, ''))).toBe(true);
    }
  });

  it('runs one step in the aggregator, and that step calls only the aggregator script', () => {
    const runs = (aggregator().steps ?? []).filter((step) => typeof step.run === 'string');
    expect(runs).toHaveLength(1);
    const commands = (runs[0]?.run ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !/^set\s+-/u.test(line));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.join(' ')).toMatch(/^node\s+scripts\/aggregate-gate-partitions\.mjs\b/u);
    expect(commands.join(' ').match(/\bnode\s/gu)).toHaveLength(1);
  });

  it('keeps the aggregator from executing check nodes or holding write permissions', () => {
    const run = runText(AGGREGATOR_KEY ?? '');
    expect(run, 'no check invocation').not.toMatch(CHECK_INVOCATION);
    expect(run, 'no bootstrap').not.toMatch(BOOTSTRAP_COMPILE);
    expect(run, 'no release gate script').not.toMatch(/\brelease:pr-gate\b/u);
    const permissions = aggregator().permissions;
    if (permissions !== undefined) {
      expect(typeof permissions, 'explicit scopes, never read-all or write-all').toBe('object');
      for (const [scope, level] of Object.entries(permissions as Record<string, unknown>)) {
        expect(['contents', 'actions'], `scope ${scope}`).toContain(scope);
        expect(level, `scope ${scope}`).toBe('read');
      }
    }
  });

  it.each(PARTITION_JOBS)('runs the preflight probes in %s and uploads its report', (job) => {
    expect(runText(job)).toMatch(
      /(?:pr-bootstrap\/cli\/bin\.js|\bdevai)\s+check\b[^\n;&|]*\s--preflight\b[^\n;&|]*\s--run\b/u,
    );
    const uploads = (RAW_JOBS[job]?.steps ?? []).filter(
      (step) => typeof step.uses === 'string' && /^actions\/upload-artifact@/u.test(step.uses),
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.uses).toMatch(PINNED_UPLOAD);
    expect(uploads[0]?.with?.name).toBe(REPORT_ARTIFACT[job]);
  });

  it('runs the gate invariant producers and release:pr-gate in gate-rest only', () => {
    const rest = runText('gate-rest');
    const cli = runText('gate-cli');
    for (const producer of PRODUCERS) {
      expect(rest, `gate-rest runs ${String(producer)}`).toMatch(producer);
      expect(cli, `gate-cli never runs ${String(producer)}`).not.toMatch(producer);
    }
    expect(rest).toMatch(/\brelease:pr-gate\b/u);
    expect(cli).not.toMatch(/\brelease:pr-gate\b/u);
    // release:pr-gate precedes the excluding affected check.
    expect(rest.search(/\brelease:pr-gate\b/u)).toBeLessThan(rest.search(AFFECTED_CHECK_LINE));
  });

  it('checks both partition jobs out at the same candidate with the same base binding', () => {
    const [cli, rest] = PARTITION_JOBS.map((job) => RAW_JOBS[job]);
    expect(checkoutStep('gate-cli')?.with?.ref).toEqual(checkoutStep('gate-rest')?.with?.ref);
    const base = (job: GateJob | undefined) => job?.env?.DEVAI_PREFLIGHT_BASE;
    expect(base(cli)).toBeDefined();
    expect(base(cli)).toEqual(base(rest));
  });
});

describe('workflow checker pins the three gate jobs (ADR-CHK-0007 IA-011)', () => {
  function mutateText(root: string, edit: (source: string) => string): void {
    const path = join(root, '.github/workflows', PREFLIGHT_FILE);
    const before = readFileSync(path, 'utf8');
    const after = edit(before);
    expect(after, 'the mutation changed the workflow').not.toBe(before);
    writeFileSync(path, after);
  }

  const aggregatorKey = (): string => {
    if (AGGREGATOR_KEY === undefined) throw new Error('no aggregator job');
    return AGGREGATOR_KEY;
  };

  it.each([
    [
      'the aggregator job is removed',
      (root: string) => {
        mutateWorkflow(root, (document) => {
          document.deleteIn(['jobs', aggregatorKey()]);
        });
      },
    ],
    [
      'the aggregator needs only gate-cli',
      (root: string) => {
        mutateWorkflow(root, (document) => {
          document.setIn(['jobs', aggregatorKey(), 'needs'], ['gate-cli']);
        });
      },
    ],
    [
      'the aggregator needs only gate-rest',
      (root: string) => {
        mutateWorkflow(root, (document) => {
          document.setIn(['jobs', aggregatorKey(), 'needs'], ['gate-rest']);
        });
      },
    ],
    [
      'the always() condition is removed',
      (root: string) => {
        mutateWorkflow(root, (document) => {
          document.deleteIn(['jobs', aggregatorKey(), 'if']);
        });
      },
    ],
    [
      'the always() condition becomes success()',
      (root: string) => {
        mutateWorkflow(root, (document) => {
          document.setIn(['jobs', aggregatorKey(), 'if'], '${{ success() }}');
        });
      },
    ],
    [
      'the check name is changed',
      (root: string) => {
        mutateWorkflow(root, (document) => {
          document.setIn(['jobs', aggregatorKey(), 'name'], 'devai-release-gate-aggregate');
        });
      },
    ],
    [
      'gate-cli is removed',
      (root: string) => {
        mutateWorkflow(root, (document) => {
          document.deleteIn(['jobs', 'gate-cli']);
          document.setIn(['jobs', aggregatorKey(), 'needs'], ['gate-rest']);
        });
      },
    ],
    [
      'gate-cli loses --partition-include test:cli',
      (root: string) => {
        mutateText(root, (source) => source.replace(/\s--partition-include(?:\s+|=)test:cli/u, ''));
      },
    ],
    [
      'gate-rest loses --partition-exclude test:cli',
      (root: string) => {
        mutateText(root, (source) => source.replace(/\s--partition-exclude(?:\s+|=)test:cli/u, ''));
      },
    ],
  ])('fails when %s', (_label, mutate) => {
    const root = workflowTree();
    mutate(root);
    expect(checkWorkflowTree(root).ok).toBe(false);
    expect(preflightFindings(root)).not.toEqual([]);
  });
});
