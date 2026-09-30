// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017, INV-DEVAI-020
// Inspector acceptance for ADR-CHK-0005 (IA-001 to IA-006): every check member declares
// where it applies; a framework-only member reports a structured not-applicable result
// in an adopter, executes and still fails on the framework, and never absorbs a failure.
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { cac } from 'cac';
import { afterEach, aroundEach, describe, expect, it } from 'vitest';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { executeCheckMember } from '../../src/commands/check/adapters.js';
import {
  aggregateCheckResults,
  resolveCheckPlan,
  runCheckPlan,
  type CheckMemberResult,
  type CheckRunReport,
} from '../../src/commands/check/contracts.js';
import { checkCmd } from '../../src/commands/check/facade.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const RECEIPT = '.devai/config/adopter-policy-binding.json';
const ADOPTER_POLICY_ID = 'acme.devai-adoption';
const KIND_EVIDENCE = {
  source: RECEIPT,
  pointer: '/policy_id',
  value: ADOPTER_POLICY_ID,
} as const;

interface PolicyEntry {
  readonly id: string;
  readonly applicability: string;
}

const POLICY = JSON.parse(readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8')) as {
  readonly member_definitions: readonly PolicyEntry[];
  readonly selector_definitions: readonly PolicyEntry[];
};
const SELF_DECLARED = [...POLICY.member_definitions, ...POLICY.selector_definitions]
  .filter((entry) => entry.applicability === 'self')
  .map((entry) => entry.id);

const roots: string[] = [];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalStdout = process.stdout.write;
const originalStderr = process.stderr.write;

aroundEach((run) => withAuthorityHostTestScope(run));

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `devai-applicability-${label}-`));
  roots.push(root);
  return root;
}

function put(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function putJson(root: string, path: string, value: unknown): void {
  put(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function copy(root: string, path: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  cpSync(join(ROOT, path), join(root, path), { recursive: true });
}

function receipt(policyId: unknown): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    policy_id: policyId,
    policy_version: '1.0.0',
    source_path: 'law/policy/adopter-policy.json',
    source_digest_sha256: '0'.repeat(64),
    materialized: {},
    retired_keys: [],
  };
}

/** A minimal adopter: a binding receipt naming its own policy, domains, and no population. */
function adopterFixture(): string {
  const root = temporaryRoot('adopter');
  putJson(root, RECEIPT, receipt(ADOPTER_POLICY_ID));
  copy(root, '.devai/config/domains.json');
  mkdirSync(join(root, 'law/invariants'), { recursive: true });
  return root;
}

/** A DEVAI self fixture: the framework's own binding receipt plus the named inputs. */
function selfFixture(paths: readonly string[]): string {
  const root = temporaryRoot('self');
  copy(root, RECEIPT);
  for (const path of paths) copy(root, path);
  return root;
}

function snapshot(root: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        files[`${relative(root, path)}/`] = 'directory';
        walk(path);
      } else {
        files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
      }
    }
  };
  walk(root);
  return files;
}

type Outcome =
  | { readonly thrown: string; readonly report?: undefined }
  | { readonly thrown?: undefined; readonly report: CheckRunReport };

async function dispatch(
  repoRoot: string,
  selection: Readonly<{ only?: string; suite?: string }>,
  options: Readonly<Record<string, unknown>> = {},
): Promise<Outcome> {
  try {
    const plan = resolveCheckPlan(repoRoot, selection);
    const report = await runCheckPlan(plan, (member) =>
      executeCheckMember(member, { repoRoot, ...options }),
    );
    return { report };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

async function only(
  repoRoot: string,
  member: string,
  options: Readonly<Record<string, unknown>> = {},
): Promise<CheckMemberResult> {
  const outcome = await dispatch(repoRoot, { only: member }, options);
  if (outcome.report === undefined) throw new Error(`dispatch threw: ${outcome.thrown}`);
  const [result] = outcome.report.results;
  if (result === undefined) throw new Error(`no result for ${member}`);
  return result;
}

/** Every named code a failure surfaces: the result code and the leading token of each message. */
function failureCodes(outcome: Outcome): readonly string[] {
  const leading = (text: string | undefined): readonly string[] => {
    const match = text === undefined ? null : /^([A-Z][A-Z0-9_]+)/u.exec(text);
    return match?.[1] === undefined ? [] : [match[1]];
  };
  if (outcome.report === undefined) return leading(outcome.thrown);
  return outcome.report.results.flatMap((result) => [
    ...(result.code === undefined ? [] : [result.code]),
    ...leading(result.message),
  ]);
}

function expectNamedFailure(outcome: Outcome, code: string): void {
  expect(failureCodes(outcome)).toContain(code);
  if (outcome.report !== undefined) {
    expect(outcome.report.ok).toBe(false);
    for (const result of outcome.report.results) {
      expect(['fail', 'error']).toContain(result.status);
    }
  }
}

function expectNotApplicable(
  result: CheckMemberResult,
  member: string,
  applicability = 'self',
): void {
  expect(result).toMatchObject({
    id: member,
    status: 'na',
    code: 'CHECK_MEMBER_NOT_APPLICABLE',
    duration_ms: 0,
  });
  expect(result.value).toEqual({
    member,
    applicability,
    repository_kind: 'adopter',
    kind_evidence: KIND_EVIDENCE,
    input_source: 'none',
    reason: expect.stringMatching(/\S/u),
  });
  expect(JSON.stringify(result)).not.toContain('ENOENT');
}

async function invokeFacade(args: readonly string[]) {
  const cli = cac('devai-check-applicability');
  checkCmd.register(cli);
  let stdout = '';
  let stderr = '';
  process.argv = ['node', 'devai', 'check', ...args];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    cli.parse(process.argv, { run: false });
    await cli.runMatchedCommand();
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
  return { stdout, stderr, exit: process.exitCode ?? 0 };
}

describe('IA-001 the framework executes its self checks and a broken input still fails', () => {
  it.each(['action-coverage', 'action-effects', 'cli-reference'])(
    'executes %s substantively on the DEVAI source repository',
    async (member) => {
      const result = await only(ROOT, member);
      expect(result.status).toBe('pass');
      expect(result.code).toBeUndefined();
      expect(result.value).toBeDefined();
    },
    120_000,
  );

  it('fails action-coverage on a self fixture whose invariants drop one action claim', async () => {
    const root = selfFixture(['.devai/config/domains.json', 'law/invariants']);
    expect((await only(root, 'action-coverage')).status).toBe('pass');

    const directory = join(root, 'law/invariants');
    let dropped: string | undefined;
    for (const name of readdirSync(directory).sort()) {
      if (!name.endsWith('.json')) continue;
      const path = join(directory, name);
      const invariant = JSON.parse(readFileSync(path, 'utf8')) as {
        measurable_via?: string[];
      };
      if (invariant.measurable_via === undefined) continue;
      invariant.measurable_via = invariant.measurable_via.filter((claim) => {
        if (dropped !== undefined && claim !== dropped) return true;
        dropped = claim;
        return false;
      });
      writeFileSync(path, `${JSON.stringify(invariant, null, 2)}\n`);
    }
    if (dropped === undefined) throw new Error('the framework invariants claim no action');

    const result = await only(root, 'action-coverage');
    expect(result.status).toBe('fail');
    expect(result.value).toMatchObject({ ok: false, scope: 'self', unclaimed: [dropped] });
  }, 60_000);

  it('fails action-effects on a self fixture whose subprocess registry is emptied', async () => {
    const root = selfFixture(['law/policy/subprocess-effects.json']);
    putJson(root, 'tests/config/tsconfig.effects.json', {
      extends: join(ROOT, 'tests/config/tsconfig.effects.json'),
    });
    const control = await only(root, 'action-effects');
    expect(control.status).toBe('pass');

    const registryPath = join(root, 'law/policy/subprocess-effects.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    putJson(root, 'law/policy/subprocess-effects.json', { ...registry, templates: [] });

    const broken = await only(root, 'action-effects');
    expect(broken.status).toBe('fail');
    expect(broken.value).toMatchObject({ ok: false, enforcement_error: expect.any(String) });
  }, 120_000);

  const CLI_REFERENCE_SOURCES = [
    'law/policy/documentation-information-architecture.json',
    'law/policy/check-suites.json',
    'law/policy/sense-presets.json',
    'law/policy/round-execution.json',
    'law/policy/model-runtime-registry.json',
    'law/policy/sensor-registry.json',
    'law/schemas/task.schema.json',
    'law/schemas/action-registry.schema.json',
  ];

  it('fails cli-reference on a self fixture with a broken catalogue entry', async () => {
    const root = selfFixture(CLI_REFERENCE_SOURCES);
    expect((await only(root, 'cli-reference')).status).toBe('pass');

    const presets = JSON.parse(
      readFileSync(join(root, 'law/policy/sense-presets.json'), 'utf8'),
    ) as { presets: Array<Record<string, unknown>> };
    const [first, ...rest] = presets.presets;
    putJson(root, 'law/policy/sense-presets.json', {
      ...presets,
      presets: [{ ...first, name: undefined }, ...rest],
    });

    const outcome = await dispatch(root, { only: 'cli-reference' });
    expectNamedFailure(outcome, 'CHECK_SERVICE_ERROR');
    expect(outcome.report?.results[0]?.message).toContain('CHECK_DESCRIPTOR_SENSE_PRESETS_INVALID');
  });

  it('fails cli-reference on a self fixture with a broken CLI reference category', async () => {
    const root = selfFixture(CLI_REFERENCE_SOURCES);
    const path = 'law/policy/documentation-information-architecture.json';
    const architecture = JSON.parse(readFileSync(join(root, path), 'utf8')) as {
      categories: unknown[];
    };
    putJson(root, path, {
      ...architecture,
      categories: [
        ...architecture.categories,
        { category_id: 'not-a-reference-category', canonical_source: 'law/policy/none.json' },
      ],
    });

    const outcome = await dispatch(root, { only: 'cli-reference' });
    expectNamedFailure(outcome, 'CHECK_SERVICE_ERROR');
    expect(outcome.report?.results[0]?.message).toContain('CHECK_DESCRIPTOR_CATEGORY_UNKNOWN');
  });
});

describe('IA-002 and IA-006 a self member in an adopter is structurally not applicable', () => {
  it('declares exactly the framework-only members as self', () => {
    expect([...SELF_DECLARED].sort()).toEqual([
      'action-effects',
      'campaign',
      'cli-reference',
      'prompt-overlays',
      'scorecard-page',
    ]);
  });

  it.each(SELF_DECLARED)(
    'reports %s as not applicable in an adopter without ENOENT or a created file',
    async (member) => {
      const root = adopterFixture();
      const before = snapshot(root);
      const plan = resolveCheckPlan(root, { only: member });
      const result = await only(root, member);
      expectNotApplicable(result, member);
      expect(result.effect).toBe(plan.members[0]?.effect);
      expect(result.binding).toEqual(plan.members[0]?.binding);
      expect(snapshot(root)).toEqual(before);
    },
    60_000,
  );

  it('classifies by the binding receipt even when the adopter carries framework directories', async () => {
    const root = adopterFixture();
    put(root, 'packages/cli/src/bin.ts', 'export {};\n');
    mkdirSync(join(root, 'examples/redox-pack-fixture'), { recursive: true });
    mkdirSync(join(root, 'law/policy'), { recursive: true });
    mkdirSync(join(root, 'tests/config'), { recursive: true });

    expectNotApplicable(await only(root, 'action-effects'), 'action-effects');
    expectNotApplicable(await only(root, 'cli-reference'), 'cli-reference');
    const coverage = await only(root, 'action-coverage');
    expect(coverage.status).not.toBe('na');
    expect(coverage.value).toMatchObject({ scope: 'adopter' });
  });

  it('renders the not-applicable member line in human output', async () => {
    const root = adopterFixture();
    const result = await invokeFacade(['--only', 'action-effects', '--repo-root', root, '--human']);
    expect(result.stdout).toContain('\n  NA action-effects (0ms, read)\n');
    expect(result.stdout).toContain('readiness=NA');
    expect(result.stdout).not.toContain('ENOENT');
    expect(result.exit).toBe(0);
  });
});

describe('IA-003 action-coverage evaluates the detected adopter scope', () => {
  it('reports an empty adopter population explicitly, never an empty pass', async () => {
    const root = adopterFixture();
    const outcome = await dispatch(root, { only: 'action-coverage' });
    const report = outcome.report;
    if (report === undefined) throw new Error(`dispatch threw: ${String(outcome.thrown)}`);
    const [result] = report.results;
    expect(result).toMatchObject({
      id: 'action-coverage',
      status: 'review',
      code: 'CHECK_MEMBER_POPULATION_EMPTY',
    });
    expect(result?.value).toEqual({
      member: 'action-coverage',
      applicability: 'both',
      repository_kind: 'adopter',
      kind_evidence: KIND_EVIDENCE,
      input_source: 'repository',
      scope: 'adopter',
      population: 0,
      reason: expect.stringMatching(/\S/u),
    });
    expect(report).toMatchObject({ ok: false, readiness_status: 'review', exit_code: 1 });
    expect(report.counts.pass).toBe(0);
    expect(report.counts.na).toBe(0);
  });

  it('evaluates a real adopter population and fails an unclaimed referenced action', async () => {
    const root = adopterFixture();
    put(root, '.github/workflows/check.yml', 'steps:\n  - run: pnpm exec devai sense inventory\n');
    const outcome = await dispatch(root, { only: 'action-coverage' });
    const result = outcome.report?.results[0];
    expect(result?.status).toBe('fail');
    expect(result?.value).toMatchObject({
      ok: false,
      scope: 'adopter',
      unclaimed: ['sense inventory'],
    });
    expect(outcome.report?.ok).toBe(false);
  });
});

describe('IA-004 an explicit source is validated and never falls back', () => {
  it('validates an explicit schema and instance pair in an adopter', async () => {
    const root = adopterFixture();
    putJson(root, 'inputs/schema.json', {
      type: 'object',
      required: ['ok'],
      properties: { ok: { const: true } },
    });
    putJson(root, 'inputs/valid.json', { ok: true });
    putJson(root, 'inputs/invalid.json', { ok: false });
    const schema = 'inputs/schema.json';
    expect((await only(root, 'schema', { schema, instance: 'inputs/valid.json' })).status).toBe(
      'pass',
    );
    expect((await only(root, 'schema', { schema, instance: 'inputs/invalid.json' })).status).toBe(
      'fail',
    );
  });

  it.each([
    ['schema', { schema: 'inputs/schema.json', instance: 'inputs/missing.json' }],
    ['schema', { schema: 'inputs/missing.schema.json', instance: 'inputs/valid.json' }],
    ['schema', { schema: 'inputs/schema.json', instance: 'inputs/malformed.json' }],
    ['blueprint', { file: 'inputs/missing-blueprint.json' }],
  ] as const)('fails %s on an invalid explicit path %j with a named code', async (member, opts) => {
    const root = adopterFixture();
    putJson(root, 'inputs/schema.json', { type: 'object' });
    putJson(root, 'inputs/valid.json', {});
    put(root, 'inputs/malformed.json', '{broken');
    const outcome = await dispatch(root, { only: member }, opts);
    expectNamedFailure(outcome, 'CHECK_INPUT_PATH_INVALID');
    expect(outcome.report?.results[0]?.status).not.toBe('na');
  });

  it('keeps a missing required repository source a failure, not not-applicable', async () => {
    const root = adopterFixture();
    const outcome = await dispatch(root, { only: 'docs-links' });
    expect(outcome.report?.results[0]?.status).toBe('error');
    expect(outcome.report?.results[0]?.message).toContain('CHECK_DOCS_DIR_MISSING');
  });

  it('keeps a check-suites policy error a failure', async () => {
    const root = adopterFixture();
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8'),
    ) as Record<string, unknown>;
    putJson(root, 'law/policy/check-suites.json', { ...policy, ordering: 'coalesced' });
    const outcome = await dispatch(root, { only: 'action-effects' });
    expectNamedFailure(outcome, 'CHECK_POLICY_INVALID');
  });

  it('rejects a malformed selector declaration as a policy error', async () => {
    const root = adopterFixture();
    const policy = JSON.parse(readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8')) as {
      selector_definitions: PolicyEntry[];
    } & Record<string, unknown>;
    putJson(root, 'law/policy/check-suites.json', {
      ...policy,
      selector_definitions: policy.selector_definitions.map((entry) =>
        entry.id === 'action-effects' ? { ...entry, applicability: 'everywhere' } : entry,
      ),
    });
    const outcome = await dispatch(root, { only: 'action-effects' });
    expectNamedFailure(outcome, 'CHECK_POLICY_SELECTORS_INVALID');
  });

  it('rejects a dispatched selector or member without an applicability declaration', async () => {
    const policy = JSON.parse(readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8')) as {
      selector_definitions: PolicyEntry[];
      member_definitions: Array<Record<string, unknown>>;
    } & Record<string, unknown>;

    const undeclaredSelector = adopterFixture();
    putJson(undeclaredSelector, 'law/policy/check-suites.json', {
      ...policy,
      selector_definitions: policy.selector_definitions.filter(
        (entry) => entry.id !== 'action-effects',
      ),
    });
    const selector = await dispatch(undeclaredSelector, { only: 'action-effects' });
    expectNamedFailure(selector, 'CHECK_MEMBER_APPLICABILITY_UNDECLARED');

    const undeclaredMember = adopterFixture();
    putJson(undeclaredMember, 'law/policy/check-suites.json', {
      ...policy,
      member_definitions: policy.member_definitions.map((entry) => {
        if (entry['id'] !== 'campaign') return entry;
        const { applicability: _dropped, ...rest } = entry;
        return rest;
      }),
    });
    const member = await dispatch(undeclaredMember, { only: 'campaign' });
    expectNamedFailure(member, 'CHECK_MEMBER_APPLICABILITY_UNDECLARED');
  });
});

describe('the repository kind fails closed without a readable binding receipt', () => {
  it.each([
    ['absent', undefined],
    ['unparsable', '{broken'],
    ['non-string policy_id', `${JSON.stringify(receipt(42))}\n`],
  ] as const)('fails a self member when the receipt is %s', async (_label, content) => {
    const root = adopterFixture();
    rmSync(join(root, RECEIPT));
    if (content !== undefined) put(root, RECEIPT, content);
    const before = snapshot(root);
    for (const member of ['action-effects', 'cli-reference']) {
      const outcome = await dispatch(root, { only: member });
      expectNamedFailure(outcome, 'CHECK_REPOSITORY_KIND_INVALID');
      expect(outcome.report?.results[0]?.status).not.toBe('na');
      expect(JSON.stringify(outcome)).not.toContain('ENOENT');
    }
    expect(snapshot(root)).toEqual(before);
  });
});

describe('IA-005 classification parity, aggregate status, and byte stability', () => {
  it('classifies a self member identically through a suite and through --only', async () => {
    const root = adopterFixture();
    const policy = JSON.parse(readFileSync(join(ROOT, 'law/policy/check-suites.json'), 'utf8')) as {
      suites: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    putJson(root, 'law/policy/check-suites.json', {
      ...policy,
      suites: policy.suites.map((suite) =>
        suite['name'] === 'quick' ? { ...suite, members: ['campaign', 'scorecard-page'] } : suite,
      ),
    });

    const suite = await dispatch(root, { suite: 'quick' });
    const report = suite.report;
    if (report === undefined) throw new Error(`dispatch threw: ${String(suite.thrown)}`);
    const campaign = await only(root, 'campaign');
    const scorecard = await only(root, 'scorecard-page');
    expect(report.results).toEqual([campaign, scorecard]);
    expectNotApplicable(campaign, 'campaign');
    expectNotApplicable(scorecard, 'scorecard-page');
    expect(report).toMatchObject({
      ok: false,
      readiness_status: 'na',
      execution_status: 'pass',
      exit_code: 0,
    });
    expect(report.counts).toEqual({ pass: 0, review: 0, fail: 0, unknown: 0, na: 2, error: 0 });

    const human = await invokeFacade(['--suite', 'quick', '--repo-root', root, '--human']);
    expect(human.stdout).toContain('  NA campaign (0ms, read)\n');
    expect(human.stdout).toContain('  NA scorecard-page (0ms, read)\n');
    expect(human.exit).toBe(0);
  });

  it('keeps not-applicable distinct in the aggregate: all-na is not ok, pass plus na is', () => {
    const base = { effect: 'read', binding: { kind: 'runtime-gate' }, duration_ms: 0 } as const;
    const na: CheckMemberResult = { ...base, id: 'a', status: 'na' };
    const pass: CheckMemberResult = { ...base, id: 'b', status: 'pass' };
    const review: CheckMemberResult = {
      ...base,
      id: 'c',
      status: 'review',
      code: 'CHECK_MEMBER_POPULATION_EMPTY',
    };
    expect(aggregateCheckResults([na, na])).toMatchObject({
      readiness_status: 'na',
      exit_code: 0,
      counts: { na: 2, pass: 0 },
    });
    expect(aggregateCheckResults([pass, na])).toMatchObject({
      readiness_status: 'pass',
      exit_code: 0,
      counts: { na: 1, pass: 1 },
    });
    expect(aggregateCheckResults([pass, review])).toMatchObject({
      readiness_status: 'review',
      exit_code: 1,
    });
  });

  it('reports the same adopter classification byte for byte on two runs', async () => {
    const root = adopterFixture();
    const run = async () => {
      const outputs: string[] = [];
      for (const member of ['action-effects', 'cli-reference', 'action-coverage']) {
        const outcome = await dispatch(root, { only: member });
        const report = outcome.report;
        if (report === undefined) throw new Error(`dispatch threw: ${String(outcome.thrown)}`);
        const [result] = report.results;
        if (result === undefined) throw new Error(`no result for ${member}`);
        // action-coverage executes, so only its classification is compared, not its wall time.
        const stable =
          member === 'action-coverage'
            ? { ...report, results: [{ ...result, duration_ms: 0 }] }
            : report;
        outputs.push(JSON.stringify(stable));
      }
      return outputs.join('\n');
    };
    const first = await run();
    const second = await run();
    expect(second).toBe(first);
    expect(first).toContain('"status":"na"');
  });
});
