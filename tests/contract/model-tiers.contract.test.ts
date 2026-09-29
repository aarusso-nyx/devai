import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it } from 'vitest';

// ADR-MDL-0002 (tier map default, override, pin) and ADR-GOV-0023 (review mode).
// Tests of checker behaviour that TASK-0353 builds in scripts/check-campaign.mjs are
// marked EXPECTED-RED until that task lands; schema-shape tests are green now.

interface CampaignCheck {
  readonly ok: boolean;
  readonly id?: string;
  readonly problems: readonly string[];
}
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const checker = (await import(
  pathToFileURL(join(process.cwd(), 'scripts/check-campaign.mjs')).href
)) as { readonly checkCampaign: (root: string, dir: string) => CampaignCheck };
const { checkCampaign } = checker;

const root = resolve(import.meta.dirname, '../..');
const ACTIVE = join(root, 'product/campaigns/CMP-0003-harness-convergence');
const CLOSED = ['CMP-0001-workflow-economy', 'CMP-0002-self-scorecard'];
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const defaults = (): Json => readJson(join(root, 'law/policy/model-tiers.json'));

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** A copy of the active ledger with every started task pinned from the given default. */
function fixture(
  mutate: (plan: Json) => void = () => undefined,
  policy: Json = defaults(),
): string {
  const dir = tempDir('devai-tiers-');
  cpSync(ACTIVE, dir, { recursive: true });
  const path = join(dir, 'campaign.json');
  const plan = readJson(path);
  normalize(plan);
  for (const task of tasksOf(plan)) {
    if (task.status !== 'planned' && task.execution.resolved === undefined) {
      task.execution.resolved = pinFrom(policy);
    }
  }
  mutate(plan);
  writeFileSync(path, JSON.stringify(plan));
  return dir;
}

/**
 * The live ledger moves every wave, so a fixture never depends on its momentary
 * task states: every task that is not merged is planned with no pin and no
 * review, and the review mode is human. A case selects a task by a fixed id and
 * sets the status, pin and review it needs.
 */
function normalize(plan: Json): void {
  plan.review = { mode: 'human' };
  for (const task of tasksOf(plan)) {
    if (task.status === 'merged') continue;
    task.status = 'planned';
    delete task.review;
    delete task.execution.resolved;
  }
}

/** Model-advisory mode; the merged tasks of the ledger carry a recorded review. */
function advisory(plan: Json, verdict = 'pass'): void {
  plan.review = { mode: 'model-advisory' };
  for (const task of tasksOf(plan)) {
    if (task.status === 'merged') task.review = reviewOf(verdict);
  }
}

function reviewOf(verdict = 'pass'): Json {
  return {
    verdict: { verdict },
    reply_sha256: 'b'.repeat(64),
    evaluator: 'claude-cli:opus',
    recorded_at: '2026-09-29T18:00:00Z',
  };
}

function tasksOf(plan: Json): Json[] {
  return plan.rounds.flatMap((round: Json) => round.waves.flatMap((wave: Json) => wave.tasks));
}

function taskOf(plan: Json, id: string): Json {
  const task = tasksOf(plan).find((candidate) => candidate.id === id);
  if (task === undefined) throw new Error(`fixture task ${id} missing`);
  return task;
}

function pinFrom(policy: Json): Json {
  const tiers: Json = {};
  for (const [name, tier] of Object.entries<Json>(policy.tiers)) {
    tiers[name] = {
      rank: tier.rank,
      hosts: Object.fromEntries(
        Object.entries<string>(tier.hosts).map(([host, alias]) => [
          host,
          `${(policy.hosts as Json)[host].runtime}:${alias}`,
        ]),
      ),
      default_effort: tier.default_effort,
    };
  }
  return {
    policy_version: policy.policy_version,
    pinned_at: '2026-09-29T17:07:18Z',
    tiers,
    ceiling: policy.escalation.ceiling,
  };
}

/** A repository root whose law/policy/model-tiers.json is replaced; all else is symlinked. */
function rootWithPolicy(policy: Json): string {
  const mirror = tempDir('devai-tiers-root-');
  for (const name of readdirSync(root)) {
    if (name !== 'law') symlinkSync(join(root, name), join(mirror, name));
  }
  mkdirSync(join(mirror, 'law/policy'), { recursive: true });
  for (const name of readdirSync(join(root, 'law'))) {
    if (name !== 'policy') symlinkSync(join(root, 'law', name), join(mirror, 'law', name));
  }
  for (const name of readdirSync(join(root, 'law/policy'))) {
    if (name !== 'model-tiers.json') {
      symlinkSync(join(root, 'law/policy', name), join(mirror, 'law/policy', name));
    }
  }
  writeFileSync(join(mirror, 'law/policy/model-tiers.json'), JSON.stringify(policy));
  return mirror;
}

function schemaValidator(file: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(readJson(join(root, 'law/schemas', file)));
}

const codes = (result: CampaignCheck): string =>
  result.problems.filter((problem) => problem.length > 0).join('\n');

describe('tier map default (ADR-MDL-0002)', () => {
  it('validates the default policy against its schema', () => {
    const validate = schemaValidator('model-tiers.schema.json');
    expect(validate(defaults()), JSON.stringify(validate.errors)).toBe(true);
  });

  it('declares the four tiers with the architect ceiling and both hosts', () => {
    const policy = defaults();
    expect(Object.keys(policy.tiers)).toEqual(['architect', 'worker-high', 'worker', 'clerk']);
    expect(Object.keys(policy.hosts).sort()).toEqual(['claude', 'codex']);
    expect(policy.escalation.ceiling).toBe('architect');
    expect(policy.resolution.id_form).toBe('runtime:model');
  });

  it('resolves every default alias through a declared host alias list', () => {
    const policy = defaults();
    for (const tier of Object.values<Json>(policy.tiers)) {
      for (const [host, alias] of Object.entries<string>(tier.hosts)) {
        expect(policy.hosts[host].aliases).toContain(alias);
      }
    }
  });
});

describe('campaign schema admits the override and review shapes', () => {
  const validate = schemaValidator('campaign.schema.json');
  const base = (): Json => readJson(join(ACTIVE, 'campaign.json'));

  it('accepts a campaign whose models block overrides only the worker tier', () => {
    const plan = base();
    plan.models = { schemaVersion: '1.0.0', tiers: { worker: { claude: 'haiku' } } };
    expect(validate(plan), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a campaign with no models block and a review mode of either value', () => {
    for (const mode of ['human', 'model-advisory']) {
      const plan = base();
      delete plan.models;
      plan.review = { mode };
      expect(validate(plan), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('rejects an empty tier override, an unknown review mode, and an unknown host', () => {
    const empty = base();
    empty.models = { schemaVersion: '1.0.0', tiers: { worker: {} } };
    expect(validate(empty)).toBe(false);
    const mode = base();
    mode.review = { mode: 'model-authoritative' };
    expect(validate(mode)).toBe(false);
    const host = base();
    host.models.hosts = ['claude', 'gemini'];
    expect(validate(host)).toBe(false);
  });

  it('rejects a verdict outside pass, review, fail, unknown', () => {
    const plan = base();
    plan.review = { mode: 'model-advisory' };
    taskOf(plan, 'TASK-0352').review = {
      verdict: { verdict: 'approve' },
      reply_sha256: 'a'.repeat(64),
      evaluator: 'claude-cli:fable',
      recorded_at: '2026-09-29T18:00:00Z',
    };
    expect(validate(plan)).toBe(false);
    taskOf(plan, 'TASK-0352').review.verdict.verdict = 'pass';
    expect(validate(plan), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a pin whose model id is not in the runtime:model form', () => {
    const plan = base();
    taskOf(plan, 'TASK-0352').execution.resolved.tiers.worker.hosts.claude = 'sonnet';
    expect(validate(plan)).toBe(false);
  });
});

describe('closed campaigns validate unchanged', () => {
  it.each(CLOSED)('%s keeps its display-name models block and passes the check', (name) => {
    const dir = join(root, 'product/campaigns', name);
    const plan = readJson(join(dir, 'campaign.json'));
    expect(plan.status).toBe('closed');
    expect(plan.models.tiers.architect.claude).toMatch(/\d/u);
    const result = checkCampaign(root, dir);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('tier resolution through the merged map (EXPECTED-RED until TASK-0353)', () => {
  it('accepts a campaign whose only override is the worker tier', () => {
    const dir = fixture((plan) => {
      plan.models = { schemaVersion: '1.0.0', tiers: { worker: { claude: 'haiku' } } };
    });
    const result = checkCampaign(root, dir);
    expect(result.problems).toEqual([]);
  });

  it('accepts a campaign with no models block at all', () => {
    const dir = fixture((plan) => {
      delete plan.models;
    });
    expect(checkCampaign(root, dir).problems).toEqual([]);
  });

  it('names unknown-tier for an override tier the default does not declare', () => {
    const dir = fixture((plan) => {
      plan.models = { schemaVersion: '1.0.0', tiers: { wizard: { claude: 'haiku' } } };
    });
    const result = checkCampaign(root, dir);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('unknown-tier');
  });

  it('names unknown-model-alias for an alias the host does not declare', () => {
    const dir = fixture((plan) => {
      plan.models = { schemaVersion: '1.0.0', tiers: { worker: { claude: 'gpt-6-sol' } } };
    });
    const result = checkCampaign(root, dir);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('unknown-model-alias');
  });

  it('names unknown-host when the default does not declare a host the campaign uses', () => {
    const policy = defaults();
    delete policy.hosts.codex;
    for (const tier of Object.values<Json>(policy.tiers)) delete tier.hosts.codex;
    const dir = fixture(() => undefined, policy);
    const result = checkCampaign(rootWithPolicy(policy), dir);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('unknown-host');
  });

  it('names unknown-host for a pin that carries a host the default does not declare', () => {
    const dir = fixture((plan) => {
      const task = taskOf(plan, 'TASK-0352');
      task.status = 'in_progress';
      task.execution.resolved = pinFrom(defaults());
      task.execution.resolved.tiers.worker.hosts.gemini = 'gemini-cli:pro';
    });
    const result = checkCampaign(root, dir);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('unknown-host');
  });

  it('names unknown-model-alias when an active ledger carries closed-ledger display names', () => {
    // Closed ledgers keep "Fable 5.1" and are exempt (tested above); an active ledger is not.
    const closed = readJson(join(root, 'product/campaigns', CLOSED[0] ?? '', 'campaign.json'));
    const dir = fixture((plan) => {
      plan.models = closed.models;
    });
    expect(codes(checkCampaign(root, dir))).toContain('unknown-model-alias');
  });
});

describe('pin at task start (EXPECTED-RED until TASK-0353)', () => {
  it.each(['in_progress', 'pre_merge'])(
    'names resolution-not-pinned for a %s task without execution.resolved',
    (status) => {
      const dir = fixture((plan) => {
        const task = taskOf(plan, 'TASK-0352');
        task.status = status;
        delete task.execution.resolved;
      });
      const result = checkCampaign(root, dir);
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain('resolution-not-pinned');
      expect(codes(result)).toContain('TASK-0352');
    },
  );

  it('does not require a pin on a planned task', () => {
    const dir = fixture();
    expect(checkCampaign(root, dir).problems).toEqual([]);
  });

  it('keeps a started task on its pinned map after the default changes', () => {
    const changed = defaults();
    changed.policy_version = '1.1.0';
    changed.tiers.worker.hosts.claude = 'haiku';
    changed.tiers.worker.default_effort = 'low';
    const dir = fixture((plan) => {
      const task = taskOf(plan, 'TASK-0352');
      task.status = 'in_progress';
      // pinned under 1.0.0, before the default changed
      task.execution.resolved = pinFrom(defaults());
    }, defaults());
    const result = checkCampaign(rootWithPolicy(changed), dir);
    expect(result.problems).toEqual([]);
    const pinned = taskOf(readJson(join(dir, 'campaign.json')), 'TASK-0352').execution.resolved;
    expect(pinned.policy_version).toBe('1.0.0');
    expect(pinned.tiers.worker.hosts.claude).toBe('claude-cli:sonnet');
  });

  it('pins a task started after the change on the new default only', () => {
    const changed = defaults();
    changed.policy_version = '1.1.0';
    changed.tiers.worker.hosts.claude = 'haiku';
    const pin = pinFrom(changed);
    expect(pin.policy_version).toBe('1.1.0');
    expect(pin.tiers.worker.hosts.claude).toBe('claude-cli:haiku');
    const dir = fixture((plan) => {
      const task = taskOf(plan, 'TASK-0352');
      task.status = 'in_progress';
      task.execution.resolved = pin;
    }, changed);
    expect(checkCampaign(rootWithPolicy(changed), dir).problems).toEqual([]);
  });
});

describe('review mode gating (EXPECTED-RED until TASK-0353)', () => {
  it('refuses a pre_merge task under model-advisory without a recorded review', () => {
    const dir = fixture((plan) => {
      advisory(plan);
      taskOf(plan, 'TASK-0352').status = 'pre_merge';
    });
    const result = checkCampaign(root, dir);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('review-verdict-missing');
    expect(codes(result)).toContain('TASK-0352');
  });

  it('refuses a merged task under model-advisory without a recorded review', () => {
    const dir = fixture((plan) => {
      advisory(plan);
      taskOf(plan, 'TASK-0352').status = 'merged';
    });
    const result = checkCampaign(root, dir);
    expect(codes(result)).toContain('review-verdict-missing');
  });

  it('admits a pre_merge task under model-advisory with a recorded review', () => {
    const dir = fixture((plan) => {
      advisory(plan);
      const task = taskOf(plan, 'TASK-0352');
      task.status = 'pre_merge';
      task.review = reviewOf();
    });
    const result = checkCampaign(root, dir);
    expect(codes(result)).not.toContain('review-verdict');
  });

  it('records a fail verdict as advice: it does not by itself satisfy or block the shape', () => {
    const dir = fixture((plan) => {
      advisory(plan);
      const task = taskOf(plan, 'TASK-0352');
      task.status = 'pre_merge';
      task.review = reviewOf('fail');
    });
    expect(codes(checkCampaign(root, dir))).not.toContain('review-verdict-missing');
  });

  it('does not require a review block under human mode or absent mode', () => {
    for (const mode of ['human', undefined]) {
      const dir = fixture((plan) => {
        if (mode === undefined) delete plan.review;
        else plan.review = { mode };
        taskOf(plan, 'TASK-0352').status = 'pre_merge';
      });
      expect(codes(checkCampaign(root, dir))).not.toContain('review-verdict-missing');
    }
  });
});
