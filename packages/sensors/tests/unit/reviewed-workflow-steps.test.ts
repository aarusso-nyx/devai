// #325: the reviewed-step registry stays exactly the population the workflows need. Every
// entry matches a current step, every committed job has a proved effect, and removing a
// reviewed step's entry makes its job unknown again, so an edited step reads unknown until it
// is reviewed anew.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { senseHarnessCoherence } from '../../src/harness-coherence.js';
import { jobEffectFacts, workflowStepInventory } from '../../src/harness/workflow-parser.js';
import { REVIEWED_WORKFLOW_STEPS } from '../../src/harness/reviewed-workflow-steps.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const PUBLICATION_STEPS = [
  'release.yml#deploy-pages[6]',
  'release.yml#finalize-release[7]',
  'release.yml#finalize-release[8]',
  'site-publish.yml#publish-site[2]',
];

function workflows(): readonly { file: string; text: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith('.yml'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(WORKFLOWS, file), 'utf8') }));
}

describe('reviewed workflow step registry', () => {
  it('has no stale or duplicate entry, and each entry names where it occurs', () => {
    const occurrences = new Map<string, string[]>();
    for (const { file, text } of workflows()) {
      for (const step of workflowStepInventory(text, ROOT)) {
        if (step.sha256 === undefined) continue;
        const list = occurrences.get(step.sha256) ?? [];
        list.push(`${file}#${step.job}[${String(step.index)}]`);
        occurrences.set(step.sha256, list);
      }
    }
    for (const entry of REVIEWED_WORKFLOW_STEPS) {
      expect(occurrences.get(entry.sha256), entry.workflow).toEqual(entry.workflow.split(', '));
    }
    const digests = REVIEWED_WORKFLOW_STEPS.map((entry) => entry.sha256);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('proves the effect of every committed job', () => {
    const unknown = workflows().flatMap(({ file, text }) =>
      [...new Set(workflowStepInventory(text).map((step) => step.job))]
        .filter((job) => jobEffectFacts(text, ROOT, job).effect === 'unknown')
        .map((job) => `${file}#${job}`),
    );
    expect(unknown).toEqual([]);
  });

  it('marks exactly the external release writes as publication', () => {
    const publication = REVIEWED_WORKFLOW_STEPS.filter((entry) => entry.effect === 'publication')
      .flatMap((entry) => entry.workflow.split(', '))
      .sort();
    expect(publication).toEqual(PUBLICATION_STEPS);
  });

  it('reads unknown again for a reviewed step whose bytes change', () => {
    const release = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
    expect(jobEffectFacts(release, ROOT, 'finalize-release').effect).toBe('publication');
    const edited = release.replace('Verify canonical asset set', 'Verify the canonical asset set');
    expect(edited).not.toBe(release);
    expect(jobEffectFacts(edited, ROOT, 'finalize-release').effect).toBe('unknown');
  });

  // #331 review: a reviewed step is bound to the bytes of every repository file it executes.
  it('binds each entry to the current bytes of exactly the files its step executes', () => {
    const filesBySha = new Map<string, readonly string[] | undefined>();
    for (const { text } of workflows()) {
      for (const step of workflowStepInventory(text, ROOT)) {
        if (step.sha256 !== undefined) filesBySha.set(step.sha256, step.files);
      }
    }
    for (const entry of REVIEWED_WORKFLOW_STEPS) {
      expect(
        entry.files.map((file) => file.path),
        entry.workflow,
      ).toEqual(filesBySha.get(entry.sha256));
      for (const file of entry.files) {
        const digest = createHash('sha256')
          .update(readFileSync(join(ROOT, file.path)))
          .digest('hex');
        expect(digest, `${entry.workflow} ${file.path}`).toBe(file.sha256);
      }
    }
    const toolchain = REVIEWED_WORKFLOW_STEPS.find((entry) =>
      entry.workflow.startsWith('pull-request-checks.yml#preflight[1]'),
    );
    expect(toolchain?.files.map((file) => file.path)).toEqual([
      '.github/actions/setup-node-toolchain/action.yml',
    ]);
  });

  it('reads unknown when an executed file changes or is missing', () => {
    const gate = readFileSync(join(WORKFLOWS, 'pull-request-checks.yml'), 'utf8');
    const bound = [
      ...new Set(workflowStepInventory(gate, ROOT).flatMap((step) => step.files ?? [])),
    ];
    const tree = mkdtempSync(join(tmpdir(), 'devai-reviewed-files-'));
    try {
      for (const path of bound) {
        mkdirSync(dirname(join(tree, path)), { recursive: true });
        cpSync(join(ROOT, path), join(tree, path));
      }
      expect(jobEffectFacts(gate, tree, 'preflight').effect).toBe('read-only');
      const action = join(tree, '.github/actions/setup-node-toolchain/action.yml');
      writeFileSync(action, `${readFileSync(action, 'utf8')}# changed\n`);
      expect(jobEffectFacts(gate, tree, 'preflight').effect).toBe('unknown');
      cpSync(join(ROOT, '.github/actions/setup-node-toolchain/action.yml'), action);
      expect(jobEffectFacts(gate, tree, 'preflight').effect).toBe('read-only');
      rmSync(join(tree, 'scripts/process/summarize-check-report.mjs'));
      expect(jobEffectFacts(gate, tree, 'preflight').effect).toBe('unknown');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  // #338 follow-up: an executed script's local imports are executed too. The release build step
  // runs the error-code generator, which imports scripts/error-code-sources.mjs; changing only
  // that module must make the step read unknown until it is re-reviewed.
  it('binds the local modules an executed script imports', () => {
    const release = readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8');
    const build = workflowStepInventory(release, ROOT).find(
      (step) => step.job === 'build-release' && step.index === 4,
    );
    expect(build?.files).toContain('scripts/generate-error-code-reference.mjs');
    expect(build?.files).toContain('scripts/error-code-sources.mjs');
    expect(build?.files?.some((path) => path.split('/').includes('dist'))).toBe(false);

    const bound = [
      ...new Set(workflowStepInventory(release, ROOT).flatMap((step) => step.files ?? [])),
    ];
    const tree = mkdtempSync(join(tmpdir(), 'devai-reviewed-imports-'));
    try {
      for (const path of bound) {
        mkdirSync(dirname(join(tree, path)), { recursive: true });
        cpSync(join(ROOT, path), join(tree, path));
      }
      for (const path of ['pnpm-workspace.yaml']) cpSync(join(ROOT, path), join(tree, path));
      expect(jobEffectFacts(release, tree, 'build-release').effect).not.toBe('unknown');
      const scanner = join(tree, 'scripts/error-code-sources.mjs');
      writeFileSync(scanner, `${readFileSync(scanner, 'utf8')}// changed\n`);
      expect(jobEffectFacts(release, tree, 'build-release').effect).toBe('unknown');
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  // #331 final review: package scripts are followed through npm pre/post hooks and nested
  // runs, and an incomplete resolution leaves the step without a file set, so it reads unknown.
  it('follows npm lifecycle scripts and fails closed on an incomplete resolution', () => {
    const tree = mkdtempSync(join(tmpdir(), 'devai-executed-files-'));
    const put = (path: string, text: string): void => {
      mkdirSync(dirname(join(tree, path)), { recursive: true });
      writeFileSync(join(tree, path), text);
    };
    const files = (run: string) =>
      workflowStepInventory(`jobs:\n  build:\n    steps:\n      - run: ${run}\n`, tree)[0]?.files;
    try {
      put(
        'site/package.json',
        JSON.stringify({
          scripts: {
            prebuild: 'npm run sync',
            sync: 'node scripts/sync.mjs',
            build: 'node scripts/build.mjs',
            postbuild: 'node scripts/after.mjs',
          },
        }),
      );
      expect(files('npm --prefix site run build')).toEqual([
        'site/package.json',
        'site/scripts/after.mjs',
        'site/scripts/build.mjs',
        'site/scripts/sync.mjs',
      ]);
      expect(files('npm --prefix site run missing')).toBeUndefined();
      expect(files('npm --prefix absent run build')).toBeUndefined();
      expect(files('pnpm --filter site build')).toBeUndefined();
      expect(files('npx something')).toBeUndefined();
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('binds the documentation sync script the site build reaches through prebuild', () => {
    const site = REVIEWED_WORKFLOW_STEPS.find((entry) =>
      entry.workflow.startsWith('site-publish.yml#prepare-site[3]'),
    );
    expect(site?.files.map((file) => file.path)).toContain('docs/site/scripts/sync-docs.mjs');
  });

  it('reads F5:T3 PASS on the committed workflows', () => {
    const reading = senseHarnessCoherence({ repoRoot: ROOT, now: '2026-10-06T12:00:00.000Z' });
    expect(reading.findings?.filter((finding) => finding.severity !== 'info')).toEqual([]);
    expect(reading.status).toBe('pass');
  });
});
