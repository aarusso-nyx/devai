// #325: the reviewed-step registry stays exactly the population the workflows need. Every
// entry matches a current step, every committed job has a proved effect, and removing a
// reviewed step's entry makes its job unknown again, so an edited step reads unknown until it
// is reviewed anew.
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { attestedRcVerificationWorkflow } from '../../../cli/src/services/ci-scaffold/index.js';
import { buildGithubActionsAdapterPlan } from '../../../cli/src/services/github-actions-adapter/index.js';
import { senseHarnessCoherence } from '../../src/harness-coherence.js';
import { jobEffectFacts, workflowStepInventory } from '../../src/harness/workflow-parser.js';
import { REVIEWED_WORKFLOW_STEPS } from '../../src/harness/reviewed-workflow-steps.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const PUBLICATION_STEPS = [
  // #390: the RC verifier's check-run POST, the observation's build-provenance attestation and
  // its dedicated audit-ref push write external surfaces of the adopter repository.
  'generated:devai-local-rc-verify.yml#verify-attested-rc[11]',
  'generated:devai-main-observation.yml#observe[12]',
  'generated:devai-main-observation.yml#observe[9]',
  'release.yml#deploy-pages[6]',
  'release.yml#finalize-release[7]',
  'release.yml#finalize-release[8]',
  'site-publish.yml#publish-site[2]',
];

/** The two jobs DEVAI generates into an adopter, by workflow file (#390). */
const GENERATED_JOBS = {
  'devai-local-rc-verify.yml': 'verify-attested-rc',
  'devai-main-observation.yml': 'observe',
} as const;
const adopterTrees: string[] = [];
afterAll(() => {
  for (const tree of adopterTrees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

/**
 * An adopter tree as the generated workflows see it: a GitHub origin, and a package manifest
 * whose lifecycle scripts the observation install must not run.
 */
function adopterTree(): string {
  const tree = mkdtempSync(join(tmpdir(), 'devai-generated-adopter-'));
  adopterTrees.push(tree);
  mkdirSync(join(tree, '.git'));
  writeFileSync(
    join(tree, '.git/config'),
    '[remote "origin"]\n\turl = https://github.com/example/adopter.git\n',
  );
  mkdirSync(join(tree, 'scripts'));
  writeFileSync(
    join(tree, 'package.json'),
    JSON.stringify({ scripts: { postinstall: 'node scripts/postinstall.mjs' } }),
  );
  writeFileSync(join(tree, 'scripts/postinstall.mjs'), 'export const postinstall = 1;\n');
  return tree;
}

/** The generated workflows, rebuilt from their generators. */
function generatedWorkflows(
  tree: string,
): readonly { file: keyof typeof GENERATED_JOBS; text: string }[] {
  return [
    { file: 'devai-local-rc-verify.yml', text: attestedRcVerificationWorkflow() },
    {
      file: 'devai-main-observation.yml',
      text: buildGithubActionsAdapterPlan(tree, '2.3.2').workflowBytes,
    },
  ];
}

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
    // #390: the generated adopter workflows' steps are occurrences too.
    const tree = adopterTree();
    for (const { file, text } of generatedWorkflows(tree)) {
      for (const step of workflowStepInventory(text, tree)) {
        if (step.sha256 === undefined) continue;
        const list = occurrences.get(step.sha256) ?? [];
        list.push(`generated:${file}#${step.job}[${String(step.index)}]`);
        occurrences.set(step.sha256, list);
      }
    }
    for (const entry of REVIEWED_WORKFLOW_STEPS) {
      expect([...(occurrences.get(entry.sha256) ?? [])].sort(), entry.workflow).toEqual(
        entry.workflow.split(', ').sort(),
      );
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

  // #390: the generated adopter workflows are proved by step digest, never by file name.
  it('proves both generated jobs publication in an adopter tree', () => {
    const tree = adopterTree();
    for (const { file, text } of generatedWorkflows(tree)) {
      expect(jobEffectFacts(text, tree, GENERATED_JOBS[file]).effect, file).toBe('publication');
    }
    // Every generated step has its own entry, with no adopter file pinned.
    for (const { file, text } of generatedWorkflows(tree)) {
      for (const step of workflowStepInventory(text, tree)) {
        const entry = REVIEWED_WORKFLOW_STEPS.find((candidate) => candidate.sha256 === step.sha256);
        const occurrence = `generated:${file}#${step.job}[${String(step.index)}]`;
        expect(entry?.workflow.split(', '), occurrence).toContain(occurrence);
        expect(step.files, occurrence).toEqual([]);
      }
    }
  });

  it('reads a generated job unknown again when one of its steps is edited', () => {
    const tree = adopterTree();
    const [rc, observation] = generatedWorkflows(tree);
    const editedRc = (rc?.text ?? '').replace(
      'Bind candidate and protected evidence tag',
      'Bind the candidate and protected evidence tag',
    );
    expect(editedRc).not.toBe(rc?.text);
    expect(jobEffectFacts(editedRc, tree, 'verify-attested-rc').effect).toBe('unknown');
    const editedObservation = (observation?.text ?? '').replace(
      'Verify bound posture',
      'Verify the bound posture',
    );
    expect(editedObservation).not.toBe(observation?.text);
    expect(jobEffectFacts(editedObservation, tree, 'observe').effect).toBe('unknown');
  });

  it('reads the observation job unknown when its install runs lifecycle scripts again', () => {
    const tree = adopterTree();
    const observation = generatedWorkflows(tree)[1]?.text ?? '';
    expect(observation).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    const scripted = observation.replace(
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm install --frozen-lockfile',
    );
    expect(jobEffectFacts(scripted, tree, 'observe').effect).toBe('unknown');
  });

  it.each(['.pnpmfile.cjs', 'pnpmfile.cjs', '.pnpmfile.js'])(
    'reads the observation job unknown with the pnpm hook file %s in the adopter tree',
    (hook) => {
      const tree = adopterTree();
      const observation = generatedWorkflows(tree)[1]?.text ?? '';
      expect(jobEffectFacts(observation, tree, 'observe').effect).toBe('publication');
      writeFileSync(join(tree, hook), 'module.exports = { hooks: {} };\n');
      expect(jobEffectFacts(observation, tree, 'observe').effect).toBe('unknown');
    },
  );

  // #395 review: a hook path pnpm may still load fails closed whatever its form; only its
  // absence lets the --ignore-scripts install bind nothing.
  describe.each(['.pnpmfile.cjs', 'pnpmfile.cjs', '.pnpmfile.js'])(
    'the pnpm hook path %s present but unreadable or escaping',
    (hook) => {
      const observe = (tree: string) =>
        jobEffectFacts(generatedWorkflows(tree)[1]?.text ?? '', tree, 'observe').effect;

      it('reads unknown for a symlink to an existing file outside the candidate root', () => {
        const tree = adopterTree();
        const outside = mkdtempSync(join(tmpdir(), 'devai-hook-outside-'));
        adopterTrees.push(outside);
        writeFileSync(join(outside, 'hook.cjs'), 'module.exports = { hooks: {} };\n');
        expect(observe(tree)).toBe('publication');
        symlinkSync(join(outside, 'hook.cjs'), join(tree, hook));
        expect(observe(tree)).toBe('unknown');
      });

      it('reads unknown for a dangling symlink', () => {
        const tree = adopterTree();
        symlinkSync(join(tree, 'missing-hook.cjs'), join(tree, hook));
        expect(observe(tree)).toBe('unknown');
      });

      it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'reads unknown for an unreadable file',
        () => {
          const tree = adopterTree();
          const path = join(tree, hook);
          writeFileSync(path, 'module.exports = { hooks: {} };\n');
          chmodSync(path, 0o000);
          try {
            expect(observe(tree)).toBe('unknown');
          } finally {
            chmodSync(path, 0o644);
          }
        },
      );

      it('reads unknown for a directory at the hook path', () => {
        const tree = adopterTree();
        mkdirSync(join(tree, hook));
        writeFileSync(join(tree, hook, 'index.js'), 'module.exports = { hooks: {} };\n');
        expect(observe(tree)).toBe('unknown');
      });
    },
  );

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
    // A generated step executes no adopter repository file, so its entry pins none (#390).
    const tree = adopterTree();
    for (const { text } of generatedWorkflows(tree)) {
      for (const step of workflowStepInventory(text, tree)) {
        if (step.sha256 !== undefined) filesBySha.set(step.sha256, step.files);
      }
    }
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
    // ADR-CHK-0007 rule 11: the toolchain step is shared by both partition jobs.
    const toolchain = REVIEWED_WORKFLOW_STEPS.find((entry) =>
      entry.workflow.startsWith('pull-request-checks.yml#gate-cli[1]'),
    );
    expect(toolchain?.workflow).toContain('pull-request-checks.yml#gate-rest[1]');
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
      // ADR-CHK-0007 rule 11: the two partition jobs and the aggregator each prove read-only.
      const jobs = ['gate-cli', 'gate-rest', 'gate'] as const;
      const effects = () =>
        Object.fromEntries(jobs.map((job) => [job, jobEffectFacts(gate, tree, job).effect]));
      expect(effects()).toEqual({
        'gate-cli': 'read-only',
        'gate-rest': 'read-only',
        gate: 'read-only',
      });
      // Every job sets up its toolchain through the composite action.
      const action = join(tree, '.github/actions/setup-node-toolchain/action.yml');
      writeFileSync(action, `${readFileSync(action, 'utf8')}# changed\n`);
      expect(effects()).toEqual({ 'gate-cli': 'unknown', 'gate-rest': 'unknown', gate: 'unknown' });
      cpSync(join(ROOT, '.github/actions/setup-node-toolchain/action.yml'), action);
      expect(effects()).toEqual({
        'gate-cli': 'read-only',
        'gate-rest': 'read-only',
        gate: 'read-only',
      });
      // Only the partition jobs summarize a failing report.
      const summarize = join(tree, 'scripts/process/summarize-check-report.mjs');
      rmSync(summarize);
      expect(effects()).toEqual({
        'gate-cli': 'unknown',
        'gate-rest': 'unknown',
        gate: 'read-only',
      });
      cpSync(join(ROOT, 'scripts/process/summarize-check-report.mjs'), summarize);
      // Only the aggregator runs the aggregator script.
      rmSync(join(tree, 'scripts/aggregate-gate-partitions.mjs'));
      expect(effects()).toEqual({
        'gate-cli': 'read-only',
        'gate-rest': 'read-only',
        gate: 'unknown',
      });
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

  // #344 review: a computed dynamic import can load any module, so an executed script that has
  // one leaves the step incomplete unless the reviewed entry declares the files that cover it.
  it('fails closed on a computed import unless declared covers pin what it loads', () => {
    const tree = mkdtempSync(join(tmpdir(), 'devai-computed-imports-'));
    const put = (path: string, text: string): void => {
      mkdirSync(dirname(join(tree, path)), { recursive: true });
      writeFileSync(join(tree, path), text);
    };
    const step = 'jobs:\n  build:\n    steps:\n      - run: node scripts/load.mjs\n';
    const files = (covers?: readonly string[]) =>
      workflowStepInventory(step, tree, covers === undefined ? undefined : () => covers)[0]?.files;
    try {
      put(
        'scripts/load.mjs',
        "const target = process.env.GATE ?? '../src/gate.ts';\nawait import(new URL(target, import.meta.url).href);\n",
      );
      put('src/gate.ts', 'export const gate = 1;\n');
      // No declaration: the file set is incomplete, so no reviewed entry can match it.
      expect(files()).toBeUndefined();
      // Declared covers: the loaded module joins the executed set, so its digest is pinned.
      expect(files(['src/gate.ts'])).toEqual(['scripts/load.mjs', 'src/gate.ts']);
      // A declared cover that does not exist fails closed too.
      expect(files(['src/missing.ts'])).toBeUndefined();
      // A literal dynamic import is followed like a static one and needs no declaration.
      put('scripts/load.mjs', "await import('../src/gate.ts');\n");
      expect(files()).toEqual(['scripts/load.mjs', 'src/gate.ts']);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });

  it('pins the CI invariant gate the site-preparation step loads through a computed import', () => {
    const publish = readFileSync(join(WORKFLOWS, 'site-publish.yml'), 'utf8');
    const prepare = workflowStepInventory(publish, ROOT).find(
      (step) => step.job === 'prepare-site' && step.index === 4,
    );
    expect(prepare?.files).toContain('scripts/process/verify-site-preparation-artifact.mjs');
    expect(prepare?.files).toContain('packages/sensors/src/ci-invariant-gate.ts');

    const bound = [
      ...new Set(workflowStepInventory(publish, ROOT).flatMap((step) => step.files ?? [])),
    ];
    const tree = mkdtempSync(join(tmpdir(), 'devai-reviewed-computed-'));
    try {
      for (const path of bound) {
        mkdirSync(dirname(join(tree, path)), { recursive: true });
        cpSync(join(ROOT, path), join(tree, path));
      }
      expect(jobEffectFacts(publish, tree, 'prepare-site').effect).not.toBe('unknown');
      const gate = join(tree, 'packages/sensors/src/ci-invariant-gate.ts');
      writeFileSync(gate, `${readFileSync(gate, 'utf8')}// changed\n`);
      expect(jobEffectFacts(publish, tree, 'prepare-site').effect).toBe('unknown');
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
