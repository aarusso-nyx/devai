// ADR-REL-0030: the release workflow's job graph, environments, stop counts and
// credential consumers, pinned to the "After" matrix in
// docs/dev/operations/release-discipline.md (Approval stops and credential
// matrix). The assertions read the parsed workflow YAML the way
// release-prerequisites-job.contract.test.ts does; the scripts/check-workflows.mjs
// pins are covered by the check-workflows contract tests.
//
// Red until the implementing task merges the jobs: the workflow still carries
// promote-assets, rehearsal-summary and verify-linux-adopter and has no
// control-commit-summary job.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly environment?: string | { readonly name: string; readonly url?: string };
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly concurrency?: unknown;
  readonly steps?: readonly Step[];
}
interface Workflow {
  readonly on: {
    readonly push?: { readonly tags?: readonly string[] };
    readonly workflow_dispatch?: { readonly inputs?: Record<string, unknown> };
  };
  readonly permissions: Record<string, string>;
  readonly concurrency: { readonly group: string };
  readonly env: Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

const WORKFLOW_PATH = '.github/workflows/release.yml';
const workflow = parse(readFileSync(resolve(ROOT, WORKFLOW_PATH), 'utf8')) as Workflow;
const jobs = workflow.jobs;

const LEDGER_SECRETS = [
  'DEVAI_LEDGER_ENVELOPE_B64',
  'DEVAI_LEDGER_RESULTS_TGZ_B64',
  'DEVAI_LEDGER_ARTIFACTS_TGZ_B64',
  'DEVAI_LEDGER_TASK_POLICY_B64',
  'DEVAI_LEDGER_TRUST_STORE_B64',
  'DEVAI_LEDGER_TOOLCHAIN_B64',
  'DEVAI_LEDGER_ENVIRONMENT_B64',
  'DEVAI_RELEASE_SIGNERS_B64',
  'DEVAI_EVIDENCE_READ_TOKEN',
];
const LEDGER_VARIABLES = [
  'DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256',
  'DEVAI_LEDGER_POLICY_DIGEST',
  'DEVAI_LEDGER_TRANSPORT',
  'DEVAI_LEDGER_BUNDLE_SHA256',
];
const PAGES_VARIABLES = ['DEVAI_PAGES_MIGRATION_AUDIT_JSON', 'DEVAI_PAGES_MIGRATION_AUDIT_SHA256'];
const CONTROL = 'DEVAI_PROCESS_CONTROL_COMMIT';

function job(name: string): Job {
  const found = jobs[name];
  expect(found, `release.yml job "${name}" must exist`).toBeDefined();
  return found as Job;
}
function needsOf(name: string): string[] {
  const needs = job(name).needs;
  return needs === undefined ? [] : typeof needs === 'string' ? [needs] : [...needs];
}
function environmentName(name: string): string | undefined {
  const environment = job(name).environment;
  return typeof environment === 'string' ? environment : environment?.name;
}
function source(name: string): string {
  return JSON.stringify(job(name));
}
function distinct(text: string, pattern: RegExp): string[] {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1] as string))].sort();
}
const secretsRead = (name: string): string[] =>
  distinct(source(name), /secrets\.([A-Za-z0-9_]+)/g).filter((item) => item !== 'GITHUB_TOKEN');
const variablesRead = (name: string): string[] => distinct(source(name), /vars\.([A-Za-z0-9_]+)/g);
const usesGithubToken = (name: string): boolean =>
  /secrets\.GITHUB_TOKEN|github\.token/.test(source(name));
const stepNames = (name: string): string[] =>
  (job(name).steps ?? []).map((step) => step.name ?? '');
const stepByName = (name: string, stepName: string): Step => {
  const step = (job(name).steps ?? []).find((item) => item.name === stepName);
  expect(step, `${name} must have the step "${stepName}"`).toBeDefined();
  return step as Step;
};

type Mode = 'tag' | 'rehearsal' | 'publication' | 'publication-pages';
const MODES: Record<Mode, { event: string; publish: boolean; publishPages: boolean }> = {
  tag: { event: 'push', publish: false, publishPages: false },
  rehearsal: { event: 'workflow_dispatch', publish: false, publishPages: false },
  publication: { event: 'workflow_dispatch', publish: true, publishPages: false },
  'publication-pages': { event: 'workflow_dispatch', publish: true, publishPages: true },
};

/** Evaluates a job-level `if` for the three inputs the release guards use. */
function jobRuns(name: string, mode: Mode): boolean {
  const condition = job(name).if;
  if (condition === undefined) return true;
  const expression = condition
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .replace(/==/g, '===');
  const context = MODES[mode];
  return Boolean(
    new Function('github', 'inputs', `return (${expression});`)(
      { event_name: context.event },
      { publish: context.publish, publish_pages: context.publishPages },
    ),
  );
}
function stopsFor(mode: Mode): string[] {
  return Object.keys(jobs)
    .filter((name) => environmentName(name) !== undefined && jobRuns(name, mode))
    .filter((name) => environmentName(name) !== 'github-pages')
    .map((name) => `${name}@${environmentName(name)}`)
    .sort();
}

describe('release workflow job set and graph (ADR-REL-0030)', () => {
  it('declares exactly the five merged jobs', () => {
    expect(Object.keys(jobs).sort()).toEqual([
      'build-release',
      'control-commit-summary',
      'deploy-pages',
      'finalize-release',
      'verify-ledger',
    ]);
    for (const removed of ['promote-assets', 'rehearsal-summary', 'verify-linux-adopter']) {
      expect(jobs[removed], `${removed} must no longer be a job`).toBeUndefined();
    }
  });

  it('makes control-commit-summary the first job and orders the needs graph', () => {
    expect(Object.keys(jobs)[0]).toBe('control-commit-summary');
    expect(needsOf('control-commit-summary')).toEqual([]);
    expect(needsOf('verify-ledger')).toEqual(['control-commit-summary']);
    expect(needsOf('build-release')).toEqual(['verify-ledger']);
    expect(needsOf('finalize-release')).toEqual(['verify-ledger']);
    expect(needsOf('deploy-pages')).toEqual(['finalize-release', 'verify-ledger']);
  });

  it('keeps the trigger, dispatch inputs, permissions, concurrency and env block', () => {
    expect(workflow.on.push?.tags).toEqual(['v*']);
    expect(Object.keys(workflow.on.workflow_dispatch?.inputs ?? {}).sort()).toEqual(
      [
        'candidate_commit',
        'publish',
        'publish_pages',
        'release_tag',
        'rehearsal_attempt',
        'rehearsal_run_id',
      ].sort(),
    );
    const publish = workflow.on.workflow_dispatch?.inputs?.publish as {
      type?: string;
      default?: unknown;
    };
    expect(publish.type).toBe('boolean');
    expect(publish.default).toBe(false);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency.group).toBe(
      "devai-release-${{ github.event_name == 'workflow_dispatch' && inputs.release_tag || github.ref_name }}",
    );
    expect(Object.keys(workflow.env).sort()).toEqual(
      ['CANDIDATE_REF', 'EXPECTED_ACTION_COUNT', 'PACKAGE_NAME', 'RELEASE_TAG'].sort(),
    );
  });
});

describe('control-commit-summary', () => {
  it('has no environment, no guard, no secret, read-only permissions and no checkout', () => {
    const summary = job('control-commit-summary');
    expect(summary.environment).toBeUndefined();
    expect(summary.if).toBeUndefined();
    expect(summary.permissions).toEqual({ contents: 'read' });
    expect(secretsRead('control-commit-summary')).toEqual([]);
    expect(usesGithubToken('control-commit-summary')).toBe(false);
    expect(
      (summary.steps ?? []).some((step) => step.uses?.startsWith('actions/checkout') === true),
    ).toBe(false);
  });

  it('reads the control commit variable, requires a 40-hex sha and appends it to the step summary', () => {
    expect(variablesRead('control-commit-summary')).toEqual([CONTROL]);
    const steps = job('control-commit-summary').steps ?? [];
    expect(steps).toHaveLength(1);
    const step = steps[0] as Step;
    expect(step.env?.CONTROL_COMMIT).toBe('${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }}');
    const run = step.run ?? '';
    expect(run).toContain('^[a-f0-9]{40}$');
    expect(run).toMatch(
      /DEVAI_PROCESS_CONTROL_COMMIT=\$CONTROL_COMMIT|DEVAI_PROCESS_CONTROL_COMMIT=\$\{CONTROL_COMMIT\}/,
    );
    expect(run).toContain('$GITHUB_STEP_SUMMARY');
    expect(run).toContain('set -euo pipefail');
  });
});

describe('verify-ledger', () => {
  it('runs in devai-ledger-verification in every mode with contents and actions read', () => {
    expect(environmentName('verify-ledger')).toBe('devai-ledger-verification');
    expect(job('verify-ledger').if).toBeUndefined();
    expect(job('verify-ledger').permissions).toEqual({ contents: 'read', actions: 'read' });
  });

  it('is the only job that reads the ledger secrets and variables', () => {
    expect(secretsRead('verify-ledger')).toEqual([...LEDGER_SECRETS].sort());
    expect(variablesRead('verify-ledger')).toEqual([...LEDGER_VARIABLES, CONTROL].sort());
    for (const other of [
      'control-commit-summary',
      'build-release',
      'finalize-release',
      'deploy-pages',
    ]) {
      expect(
        secretsRead(other).filter((item) => LEDGER_SECRETS.includes(item)),
        other,
      ).toEqual([]);
      expect(
        variablesRead(other).filter((item) => LEDGER_VARIABLES.includes(item)),
        other,
      ).toEqual([]);
    }
  });

  it('keeps the tag verification: annotated tag, SSH signature and candidate commit', () => {
    const run = stepByName('verify-ledger', 'Bind and verify exact release evidence').run ?? '';
    expect(run).toContain('cat-file -t "$RELEASE_TAG"');
    expect(run).toContain('gpg.format ssh');
    expect(run).toContain('release-allowed-signers');
    expect(run).toContain('verify-tag "$RELEASE_TAG"');
    expect(run).toContain('rev-parse "$RELEASE_TAG^{commit}"');
    expect(
      stepByName('verify-ledger', 'Bind and verify exact release evidence').env?.REQUIRE_TAG,
    ).toBe("${{ github.event_name == 'push' || inputs.publish }}");
  });

  it('absorbs the promotion verification and retention steps behind the publish guard', () => {
    const names = stepNames('verify-ledger');
    expect(names.indexOf('Verify selected rehearsal')).toBeGreaterThan(
      names.indexOf('Bind and verify exact release evidence'),
    );
    expect(names.indexOf('Retain verified promotion assets')).toBe(
      names.indexOf('Verify selected rehearsal') + 1,
    );
    const guard = "${{ github.event_name == 'workflow_dispatch' && inputs.publish }}";
    const verify = stepByName('verify-ledger', 'Verify selected rehearsal');
    expect(verify.if).toBe(guard);
    expect(verify.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(verify.env?.REHEARSAL_RUN).toBe('${{ inputs.rehearsal_run_id }}');
    expect(verify.env?.REHEARSAL_ATTEMPT).toBe('${{ inputs.rehearsal_attempt }}');
    expect(verify.env?.WORKFLOW_COMMIT).toBe('${{ github.workflow_sha }}');
    expect(verify.env?.CONTROL_COMMIT).toBe('${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }}');
    expect(verify.env?.RELEASE_COMMIT).toBe('${{ steps.bindings.outputs.commit }}');
    expect(verify.env?.RELEASE_TREE).toBe('${{ steps.bindings.outputs.tree }}');
    expect(verify.env?.CURRENT_LEDGER).toBe('${{ steps.bindings.outputs.ledger_json }}');
    expect(verify.run).toContain('release-control/scripts/process/rehearsal.mjs promote');
    const retain = stepByName('verify-ledger', 'Retain verified promotion assets');
    expect(retain.id).toBe('retain');
    expect(retain.if).toBe(guard);
    expect(retain.with?.name).toBe('devai-release-assets-${{ github.run_attempt }}');
    expect(retain.with?.path).toBe('release-assets/*');
    expect(retain.with?.['if-no-files-found']).toBe('error');
    expect(retain.with?.['retention-days']).toBe(30);
  });

  it('outputs release_asset_id from the retention step and reads no build command', () => {
    expect(job('verify-ledger').outputs?.release_asset_id).toBe(
      '${{ steps.retain.outputs.artifact-id }}',
    );
    expect(source('verify-ledger')).not.toMatch(/pnpm run build|npm run build|npm pack|pnpm pack/);
  });

  it('holds GITHUB_TOKEN only in the publication steps', () => {
    const tokenSteps = (job('verify-ledger').steps ?? [])
      .filter((step) => /secrets\.GITHUB_TOKEN|github\.token/.test(JSON.stringify(step)))
      .map((step) => step.name);
    expect(tokenSteps).toEqual(['Verify selected rehearsal']);
  });
});

describe('build-release', () => {
  it('is the rehearsal stop in devai-rc-release with contents read only', () => {
    const build = job('build-release');
    expect(environmentName('build-release')).toBe('devai-rc-release');
    expect(build.if).toBe("${{ github.event_name == 'workflow_dispatch' && !inputs.publish }}");
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(secretsRead('build-release')).toEqual([]);
    expect(usesGithubToken('build-release')).toBe(false);
    expect(variablesRead('build-release')).toEqual([CONTROL]);
  });

  it('absorbs Linux adoption and the rehearsal summary in order after the upload', () => {
    const names = stepNames('build-release');
    const ordered = [
      'Upload release candidate assets',
      'Download exact release assets',
      'Exercise fresh npm adoption, execution, and reuse',
      'Check out approved process controls',
      'Bind approved process controls',
      'Record completed rehearsal',
      'Retain rehearsal completion',
    ];
    const positions = ordered.map((name) => names.lastIndexOf(name));
    expect(
      positions.every((position) => position >= 0),
      JSON.stringify(names),
    ).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(stepByName('build-release', 'Upload release candidate assets').id).toBe('upload');
    const download = stepByName('build-release', 'Download exact release assets');
    expect(download.with?.name).toBe('devai-release-assets-${{ github.run_attempt }}');
    expect(download.with?.path).toBe('release-assets');
    const control = stepByName('build-release', 'Check out approved process controls');
    expect(control.with?.ref).toBe('${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }}');
    expect(control.with?.path).toBe('release-control');
    expect(control.with?.['persist-credentials']).toBe(false);
    expect(JSON.stringify(stepByName('build-release', 'Record completed rehearsal'))).toContain(
      'steps.upload.outputs',
    );
    expect(stepByName('build-release', 'Retain rehearsal completion').with?.name).toBe(
      'devai-rehearsal-${{ github.run_attempt }}',
    );
  });
});

describe('finalize-release', () => {
  it('is the publication stop in devai-rc-publication with write permissions', () => {
    const finalize = job('finalize-release');
    expect(environmentName('finalize-release')).toBe('devai-rc-publication');
    expect(finalize.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.publish }}");
    expect(finalize.permissions).toEqual({ contents: 'write', packages: 'write' });
    expect(variablesRead('finalize-release')).toEqual([CONTROL]);
    expect(secretsRead('finalize-release')).toEqual([]);
  });

  it('reads GITHUB_TOKEN as secrets.GITHUB_TOKEN and the retained asset id from verify-ledger', () => {
    expect(source('finalize-release')).toContain('secrets.GITHUB_TOKEN');
    expect(source('finalize-release')).not.toContain('github.token');
    const downloads = (job('finalize-release').steps ?? []).filter((step) =>
      step.uses?.startsWith('actions/download-artifact'),
    );
    expect(downloads.length).toBeGreaterThan(0);
    for (const step of downloads) {
      expect(step.with?.['artifact-ids']).toBe(
        '${{ needs.verify-ledger.outputs.release_asset_id }}',
      );
      expect(step.with?.['merge-multiple']).toBe(true);
    }
    expect(source('finalize-release')).not.toContain('promote-assets');
  });
});

describe('deploy-pages', () => {
  it('keeps the github-pages environment, guard, concurrency and permissions', () => {
    const deploy = job('deploy-pages');
    const environment = deploy.environment as { name: string; url: string };
    expect(environment.name).toBe('github-pages');
    expect(environment.url).toBe('${{ steps.deployment.outputs.page_url }}');
    expect(deploy.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.publish && inputs.publish_pages }}",
    );
    expect(JSON.stringify(deploy.concurrency)).toContain('devai-pages-publication');
    expect(deploy.permissions).toEqual({
      contents: 'read',
      pages: 'write',
      deployments: 'write',
      'id-token': 'write',
    });
  });

  it('reads the audit variables and github.token, and the asset id from verify-ledger', () => {
    expect(variablesRead('deploy-pages')).toEqual([...PAGES_VARIABLES, CONTROL].sort());
    expect(secretsRead('deploy-pages')).toEqual([]);
    expect(source('deploy-pages')).toContain('github.token');
    expect(source('deploy-pages')).not.toContain('secrets.GITHUB_TOKEN');
    const download = stepByName('deploy-pages', 'Download canonical release assets');
    expect(download.with?.['artifact-ids']).toBe(
      '${{ needs.verify-ledger.outputs.release_asset_id }}',
    );
    expect(source('deploy-pages')).not.toContain('promote-assets');
  });

  it('is the only job that reads the Pages audit variables', () => {
    for (const other of [
      'control-commit-summary',
      'verify-ledger',
      'build-release',
      'finalize-release',
    ]) {
      expect(
        variablesRead(other).filter((item) => PAGES_VARIABLES.includes(item)),
        other,
      ).toEqual([]);
    }
  });
});

describe('environments and stops', () => {
  it('binds one environment to each gated job and none to the others', () => {
    expect(
      Object.fromEntries(
        Object.keys(jobs)
          .sort()
          .map((name) => [name, environmentName(name) ?? null]),
      ),
    ).toEqual({
      'build-release': 'devai-rc-release',
      'control-commit-summary': null,
      'deploy-pages': 'github-pages',
      'finalize-release': 'devai-rc-publication',
      'verify-ledger': 'devai-ledger-verification',
    });
    const gated = ['build-release', 'finalize-release', 'verify-ledger'].map((name) =>
      environmentName(name),
    );
    expect(new Set(gated).size).toBe(3);
  });

  it('stops a rehearsal exactly twice', () => {
    expect(stopsFor('rehearsal')).toEqual([
      'build-release@devai-rc-release',
      'verify-ledger@devai-ledger-verification',
    ]);
  });

  it('stops a publication exactly twice with or without publish_pages', () => {
    const expected = [
      'finalize-release@devai-rc-publication',
      'verify-ledger@devai-ledger-verification',
    ];
    expect(stopsFor('publication')).toEqual(expected);
    expect(stopsFor('publication-pages')).toEqual(expected);
    expect(jobRuns('deploy-pages', 'publication')).toBe(false);
    expect(jobRuns('deploy-pages', 'publication-pages')).toBe(true);
  });

  it('stops a tag push once, at the ledger verification', () => {
    expect(stopsFor('tag')).toEqual(['verify-ledger@devai-ledger-verification']);
  });
});

describe('GITHUB_TOKEN consumers', () => {
  it('match law/policy/credential-requirements.json', () => {
    const policy = JSON.parse(
      readFileSync(resolve(ROOT, 'law/policy/credential-requirements.json'), 'utf8'),
    ) as {
      entries: { id: string; consumer: { workflow: string; job: string }[] }[];
    };
    const entry = policy.entries.find((item) => item.id === 'GITHUB_TOKEN');
    expect(entry, 'GITHUB_TOKEN entry').toBeDefined();
    const consumers = (entry?.consumer ?? [])
      .filter((item) => item.workflow === WORKFLOW_PATH)
      .map((item) => item.job)
      .sort();
    expect(consumers).toEqual(['deploy-pages', 'finalize-release', 'verify-ledger']);
    const actual = Object.keys(jobs)
      .filter((name) => usesGithubToken(name))
      .sort();
    expect(actual).toEqual(consumers);
  });
});
