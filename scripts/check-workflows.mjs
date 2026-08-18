#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const LEDGER_WORKFLOW_FILE = 'devai-ledger-verify.yml';
export const RELEASE_WORKFLOW_FILE = 'release.yml';
export const VERIFIER_REPOSITORY = 'devai-nyx/devai-verifier';
export const VERIFIER_COMMIT = '5f71d43a3d55b07fe866ea2df139dfaacc84f7db';
export const LEDGER_ENVIRONMENT = 'devai-ledger-verification';
export const CHECKOUT_COMMIT = '3d3c42e5aac5ba805825da76410c181273ba90b1';
export const SETUP_NODE_COMMIT = '820762786026740c76f36085b0efc47a31fe5020';
// v4.1.0 is an annotated tag: this is the immutable tag object accepted by
// Actions, not its peeled commit. Keep both identities explicit so the checker
// does not falsely demand a repin from the authentic object to its commit.
export const PNPM_SETUP_TAG_OBJECT = '7088e561eb65bb68695d245aa206f005ef30921d';
export const PNPM_SETUP_PEELED_COMMIT = 'a7487c7e89a18df4991f7f222e4898a00d66ddda';
export const UPLOAD_ARTIFACT_COMMIT = 'ea165f8d65b6e75b540449e92b4886f43607fa02';
export const DOWNLOAD_ARTIFACT_COMMIT = 'd3f86a106a0bac45b974a628896c90dbdf5c8093';
export const CONFIGURE_PAGES_COMMIT = '983d7736d9b0ae728b81ab479565c72886d7745b';
export const UPLOAD_PAGES_COMMIT = '7b1f4a764d45c48632c6b24a0339c27f5614fb0b';
export const DEPLOY_PAGES_COMMIT = 'd6db90164ac5ed86f2b6aed7e0febac5b3c0c03e';
export const CANDIDATE_SHA_EXPRESSION = '${{ github.event.pull_request.head.sha || github.sha }}';
export const RELEASE_TAG_EXPRESSION =
  "${{ github.event_name == 'workflow_dispatch' && inputs.release_tag || github.ref_name }}";

const OLD_WORKFLOW_MARKERS = [
  'cold-sentinel',
  'round-gates',
  'reusable-evidence-gate',
  'devai-gates',
];
const PRODUCT_EXECUTION = [
  /\bpnpm\b/u,
  /\bnpm\s+(?:run|test|exec)\b/u,
  /\byarn\b/u,
  /\bbun\s+(?:run|test)\b/u,
  /\bvitest\b/u,
  /\bjest\b/u,
  /\bpytest\b/u,
  /\bcoverage\b/iu,
  /\btsc\b/u,
  /\beslint\b/u,
  /\bprettier\b/u,
  /\b(?:make|gradle|mvn)\s+(?:build|test|check)\b/iu,
];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function workflowFiles(root) {
  const directory = join(root, '.github/workflows');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort();
}

function finding(code, file, detail) {
  return { code, file, detail };
}

export function checkWorkflowTree(root = process.cwd()) {
  const findings = [];
  const files = workflowFiles(root);
  const expected = [LEDGER_WORKFLOW_FILE, RELEASE_WORKFLOW_FILE].sort();
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    findings.push(
      finding(
        'CI_WORKFLOW_SET_INVALID',
        '.github/workflows',
        `expected exactly ${expected.join(', ')}; found ${files.join(', ') || 'none'}`,
      ),
    );
  }
  for (const file of files) {
    const path = join(root, '.github/workflows', file);
    const source = readFileSync(path, 'utf8');
    checkWorkflow(file, source, findings);
  }
  return { ok: findings.length === 0, files, findings };
}

function checkWorkflow(file, source, findings) {
  for (const marker of OLD_WORKFLOW_MARKERS) {
    if (file.includes(marker) || source.includes(marker)) {
      findings.push(finding('CI_OBSOLETE_WORKFLOW_PRESENT', file, marker));
    }
  }

  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      findings.push(finding('CI_WORKFLOW_YAML_INVALID', file, error.message));
    }
    return;
  }
  const workflow = object(document.toJS());

  if (file === RELEASE_WORKFLOW_FILE) {
    checkReleaseWorkflow(file, workflow, source, findings);
    return;
  }
  if (file !== LEDGER_WORKFLOW_FILE) {
    findings.push(finding('CI_WORKFLOW_UNRECOGNIZED', file, 'workflow is outside the RC set'));
    return;
  }

  const triggers = object(workflow.on);
  const triggerNames = Object.keys(triggers).sort();
  const expectedTriggers = ['pull_request_target', 'push', 'workflow_dispatch'];
  if (
    triggerNames.length !== expectedTriggers.length ||
    triggerNames.some((name, index) => name !== expectedTriggers[index])
  ) {
    findings.push(
      finding(
        'CI_WORKFLOW_TRUST_BOUNDARY_INVALID',
        file,
        'workflow must use trusted-base pull_request_target, push, and workflow_dispatch only',
      ),
    );
  }

  const permissions = object(workflow.permissions);
  if (Object.keys(permissions).length !== 1 || permissions.contents !== 'read') {
    findings.push(
      finding('CI_WORKFLOW_PERMISSIONS_INVALID', file, 'only contents: read is permitted'),
    );
  }
  if (object(workflow.env).CANDIDATE_SHA !== CANDIDATE_SHA_EXPRESSION) {
    findings.push(
      finding(
        'CI_CANDIDATE_SHA_UNBOUND',
        file,
        'CANDIDATE_SHA must select pull-request head SHA or github.sha exactly',
      ),
    );
  }

  const jobs = object(workflow.jobs);
  if (Object.keys(jobs).length !== 1 || jobs['verify-ledger'] === undefined) {
    findings.push(
      finding('CI_LEDGER_JOB_SET_INVALID', file, 'exactly one verify-ledger job is required'),
    );
  }
  const job = object(jobs['verify-ledger']);
  if (job.environment !== LEDGER_ENVIRONMENT) {
    findings.push(
      finding(
        'CI_LEDGER_ENVIRONMENT_MISSING',
        file,
        `verify-ledger must use protected environment ${LEDGER_ENVIRONMENT}`,
      ),
    );
  }
  const steps = Array.isArray(job.steps) ? job.steps.map(object) : [];
  if (steps.length === 0) {
    findings.push(finding('CI_LEDGER_STEPS_MISSING', file, 'verify-ledger has no steps'));
    return;
  }

  for (const [index, step] of steps.entries()) {
    const location = `jobs.verify-ledger.steps[${String(index)}]`;
    const uses = typeof step.uses === 'string' ? step.uses : '';
    if (uses.startsWith('./')) {
      findings.push(
        finding('CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN', file, `${location} uses ${uses}`),
      );
    } else if (uses !== '' && !/@[0-9a-f]{40}$/u.test(uses)) {
      findings.push(finding('CI_ACTION_REFERENCE_MUTABLE', file, `${location} uses ${uses}`));
    }
    if (
      (uses.startsWith('actions/checkout@') && uses !== `actions/checkout@${CHECKOUT_COMMIT}`) ||
      (uses.startsWith('actions/setup-node@') && uses !== `actions/setup-node@${SETUP_NODE_COMMIT}`)
    ) {
      findings.push(finding('CI_ACTION_PIN_MISMATCH', file, `${location} uses ${uses}`));
    }
    const run = typeof step.run === 'string' ? step.run : '';
    if (PRODUCT_EXECUTION.some((pattern) => pattern.test(run))) {
      findings.push(
        finding('CI_PRODUCT_EXECUTION_FORBIDDEN', file, `${location} runs product tooling`),
      );
    }
    if (
      /(?:scripts|packages|candidate)\/[A-Za-z0-9_./-]*(?:verify|verifier)/iu.test(run) ||
      (/\bnode\s+[^\n]*(?:verify|verifier)/iu.test(run) &&
        !run.includes('node .devai-verifier/src/cli.js'))
    ) {
      findings.push(
        finding('CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN', file, `${location} invokes local code`),
      );
    }
  }

  const checkouts = steps.filter((step) =>
    typeof step.uses === 'string' ? step.uses.startsWith('actions/checkout@') : false,
  );
  const candidateCheckout = checkouts.find((step) => object(step.with).path === 'candidate');
  if (
    candidateCheckout === undefined ||
    object(candidateCheckout.with).ref !== '${{ env.CANDIDATE_SHA }}' ||
    object(candidateCheckout.with).repository !== undefined ||
    object(candidateCheckout.with)['persist-credentials'] !== false
  ) {
    findings.push(
      finding('CI_CANDIDATE_CHECKOUT_UNBOUND', file, 'candidate checkout must use exact SHA'),
    );
  }
  const verifierCheckout = checkouts.find(
    (step) => object(step.with).repository === VERIFIER_REPOSITORY,
  );
  if (verifierCheckout === undefined) {
    findings.push(
      finding('CI_VERIFIER_CHECKOUT_MISSING', file, `missing ${VERIFIER_REPOSITORY} checkout`),
    );
  } else {
    const withValues = object(verifierCheckout.with);
    if (withValues.ref !== VERIFIER_COMMIT) {
      findings.push(
        finding(
          /^[0-9a-f]{40}$/u.test(String(withValues.ref ?? ''))
            ? 'CI_VERIFIER_PIN_MISMATCH'
            : 'CI_VERIFIER_REF_MUTABLE',
          file,
          `verifier ref must be ${VERIFIER_COMMIT}`,
        ),
      );
    }
    if (withValues.path !== '.devai-verifier' || withValues['persist-credentials'] !== false) {
      findings.push(
        finding(
          'CI_VERIFIER_CHECKOUT_INVALID',
          file,
          'verifier must use isolated credential-free path',
        ),
      );
    }
  }

  const serialized = JSON.stringify(workflow);
  const externalInputs = [
    'secrets.DEVAI_LEDGER_ENVELOPE_B64',
    'secrets.DEVAI_LEDGER_RESULTS_TGZ_B64',
    'secrets.DEVAI_LEDGER_ARTIFACTS_TGZ_B64',
    'secrets.DEVAI_LEDGER_TASK_POLICY_B64',
    'secrets.DEVAI_LEDGER_TRUST_STORE_B64',
    'secrets.DEVAI_LEDGER_TOOLCHAIN_B64',
    'secrets.DEVAI_LEDGER_ENVIRONMENT_B64',
    'vars.DEVAI_LEDGER_POLICY_DIGEST',
  ];
  for (const input of externalInputs) {
    if (!serialized.includes(input)) {
      findings.push(finding('CI_EXTERNAL_CONTROL_INPUT_MISSING', file, input));
    }
  }
  if (
    /(?:record\/|\.devai\/state|candidate\/)[^"'\s]*(?:receipt|result|policy|trust|ledger)/iu.test(
      serialized,
    )
  ) {
    findings.push(
      finding(
        'CI_CANDIDATE_CONTROL_INPUT_FORBIDDEN',
        file,
        'verification authority must not come from candidate files',
      ),
    );
  }

  const verifierRun = steps
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .find((run) => run.includes('node .devai-verifier/src/cli.js'));
  if (verifierRun === undefined) {
    findings.push(
      finding('CI_VERIFIER_INVOCATION_MISSING', file, 'pinned verifier CLI is not invoked'),
    );
  } else {
    for (const binding of [
      '--repository "${{ github.repository }}"',
      '--commit "$CANDIDATE_SHA"',
      '--tree "${{ steps.candidate.outputs.tree }}"',
      '--policy-digest "$POLICY_DIGEST"',
      '--artifacts-dir "$control/artifacts"',
      '--binding "${{ steps.candidate.outputs.binding }}"',
    ]) {
      if (!verifierRun.includes(binding)) {
        findings.push(finding('CI_VERIFIER_BINDING_MISSING', file, binding));
      }
    }
    for (const bindingMode of ['echo "binding=exact-tree"', 'echo "binding=exact-commit"']) {
      if (!source.includes(bindingMode)) {
        findings.push(finding('CI_VERIFIER_BINDING_MODE_INVALID', file, bindingMode));
      }
    }
  }
  const policyBuilderRun = steps
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .find((run) => run.includes('node .devai-verifier/src/build-policy-cli.js'));
  if (policyBuilderRun === undefined) {
    findings.push(
      finding(
        'CI_EXPECTED_POLICY_RECONSTRUCTION_MISSING',
        file,
        'pinned external policy builder is not invoked',
      ),
    );
  } else {
    for (const binding of [
      '--repo candidate',
      '--descriptor candidate/test-tasks.json',
      '--profile rc',
      '--schema-version 1.1.0',
      '--commit "$CANDIDATE_SHA"',
      '--tree "${{ steps.candidate.outputs.tree }}"',
      '--toolchain "$control/toolchain.json"',
      '--environment "$control/environment.json"',
      'cmp "$control/expected-task-policy.json" "$control/task-policy.json"',
    ]) {
      if (!policyBuilderRun.includes(binding)) {
        findings.push(finding('CI_EXPECTED_POLICY_BINDING_MISSING', file, binding));
      }
    }
  }
}

function checkReleaseWorkflow(file, workflow, source, findings) {
  const triggers = object(workflow.on);
  const push = object(triggers.push);
  const dispatch = object(triggers.workflow_dispatch);
  const dispatchInputs = object(dispatch.inputs);
  const releaseTagInput = object(dispatchInputs.release_tag);
  const publishInput = object(dispatchInputs.publish);
  if (
    JSON.stringify(Object.keys(triggers).sort()) !==
      JSON.stringify(['push', 'workflow_dispatch']) ||
    !Array.isArray(push.tags) ||
    push.tags.length !== 1 ||
    push.tags[0] !== 'v*' ||
    JSON.stringify(Object.keys(dispatchInputs).sort()) !==
      JSON.stringify(['publish', 'release_tag']) ||
    releaseTagInput.required !== true ||
    releaseTagInput.type !== 'string' ||
    publishInput.required !== false ||
    publishInput.default !== false ||
    publishInput.type !== 'boolean'
  ) {
    findings.push(
      finding(
        'RELEASE_TRIGGER_INVALID',
        file,
        'release must accept version-tag rehearsal plus exact-tag publication inputs',
      ),
    );
  }
  const permissions = object(workflow.permissions);
  if (Object.keys(permissions).length !== 1 || permissions.contents !== 'read') {
    findings.push(
      finding('RELEASE_BASE_PERMISSIONS_INVALID', file, 'workflow base must be contents: read'),
    );
  }
  const environment = object(workflow.env);
  if (
    environment.PACKAGE_NAME !== '@aarusso-nyx/devai' ||
    environment.EXPECTED_ACTION_COUNT !== 43 ||
    environment.PACKAGE_VERSION !== undefined ||
    environment.RELEASE_TAG !== RELEASE_TAG_EXPRESSION ||
    environment.VERIFIER_COMMIT !== VERIFIER_COMMIT
  ) {
    findings.push(
      finding('RELEASE_IDENTITY_INVALID', file, 'package, action catalog, tag, or verifier drift'),
    );
  }

  const jobs = object(workflow.jobs);
  const expectedJobs = [
    'build-release',
    'deploy-pages',
    'finalize-release',
    'rehearsal-summary',
    'verify-ledger',
  ];
  if (JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(expectedJobs)) {
    findings.push(finding('RELEASE_JOB_SET_INVALID', file, Object.keys(jobs).sort().join(',')));
  }
  const verify = object(jobs['verify-ledger']);
  const build = object(jobs['build-release']);
  const finalize = object(jobs['finalize-release']);
  const pages = object(jobs['deploy-pages']);
  const rehearsal = object(jobs['rehearsal-summary']);
  if (verify.environment !== LEDGER_ENVIRONMENT) {
    findings.push(finding('RELEASE_LEDGER_ENVIRONMENT_INVALID', file, String(verify.environment)));
  }
  if (build.environment !== 'devai-rc-release') {
    findings.push(finding('RELEASE_BUILD_ENVIRONMENT_INVALID', file, String(build.environment)));
  }
  if (finalize.environment !== 'devai-rc-publication') {
    findings.push(
      finding('RELEASE_FINALIZATION_ENVIRONMENT_INVALID', file, String(finalize.environment)),
    );
  }
  if (object(pages.environment).name !== 'github-pages') {
    findings.push(finding('RELEASE_PAGES_ENVIRONMENT_INVALID', file, 'github-pages'));
  }
  const publishCondition = "${{ github.event_name == 'workflow_dispatch' && inputs.publish }}";
  const rehearsalCondition =
    "${{ github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && !inputs.publish) }}";
  if (finalize.if !== publishCondition || pages.if !== publishCondition) {
    findings.push(
      finding(
        'RELEASE_REHEARSAL_PUBLICATION_GUARD_MISSING',
        file,
        'finalize-release and deploy-pages must require an explicit publishing dispatch',
      ),
    );
  }
  if (
    rehearsal.if !== rehearsalCondition ||
    JSON.stringify(rehearsal.needs) !== JSON.stringify(['verify-ledger', 'build-release']) ||
    JSON.stringify(object(rehearsal.permissions)) !== JSON.stringify({ contents: 'read' })
  ) {
    findings.push(
      finding(
        'RELEASE_REHEARSAL_JOB_INVALID',
        file,
        'tag pushes and non-publishing dispatches must end in a read-only rehearsal summary after the exact build',
      ),
    );
  }

  const immutablePins = new Map([
    ['actions/checkout', CHECKOUT_COMMIT],
    ['actions/setup-node', SETUP_NODE_COMMIT],
    ['pnpm/action-setup', PNPM_SETUP_TAG_OBJECT],
    ['actions/upload-artifact', UPLOAD_ARTIFACT_COMMIT],
    ['actions/download-artifact', DOWNLOAD_ARTIFACT_COMMIT],
    ['actions/configure-pages', CONFIGURE_PAGES_COMMIT],
    ['actions/upload-pages-artifact', UPLOAD_PAGES_COMMIT],
    ['actions/deploy-pages', DEPLOY_PAGES_COMMIT],
  ]);
  const steps = Object.entries(jobs).flatMap(([jobName, value]) =>
    (Array.isArray(object(value).steps) ? object(value).steps : []).map((step, index) => ({
      jobName,
      index,
      step: object(step),
    })),
  );
  for (const { jobName, index, step } of steps) {
    const uses = typeof step.uses === 'string' ? step.uses : '';
    if (uses === '') continue;
    const match = /^([^@]+)@(.+)$/u.exec(uses);
    const expected = match === null ? undefined : immutablePins.get(match[1]);
    if (match === null || !/^[0-9a-f]{40}$/u.test(match[2])) {
      findings.push(
        finding('CI_ACTION_REFERENCE_MUTABLE', file, `${jobName}.steps[${index}] uses ${uses}`),
      );
    } else if (expected === undefined || match[2] !== expected) {
      findings.push(
        finding('CI_ACTION_PIN_MISMATCH', file, `${jobName}.steps[${index}] uses ${uses}`),
      );
    }
  }

  const requiredMarkers = [
    'node .devai-verifier/src/cli.js',
    'node .devai-verifier/src/build-policy-cli.js',
    '--schema-version 1.1.0',
    'cmp "$control/expected-task-policy.json" "$control/task-policy.json"',
    'secrets.DEVAI_LEDGER_TOOLCHAIN_B64',
    'secrets.DEVAI_LEDGER_ENVIRONMENT_B64',
    'secrets.DEVAI_LEDGER_ARTIFACTS_TGZ_B64',
    'secrets.DEVAI_RELEASE_SIGNERS_B64',
    'pnpm install --frozen-lockfile',
    'pnpm run build',
    'pnpm run release:closure',
    'run pack:smoke',
    'stage-release-package.mjs',
    'release-channel.mjs',
    'RELEASE_IS_PRERELEASE',
    'npm --prefix "$sbom_root/package" install --omit=dev --ignore-scripts --no-audit --no-fund',
    'cyclonedx-npm',
    'npm publish',
    '--tag "$PACKAGE_DIST_TAG"',
    'dist-tags.$PACKAGE_DIST_TAG',
    'npm dist-tag add',
    'sha256sum --check SHA256SUMS',
    'gh release create',
    'git -C candidate verify-tag',
    '--binding exact-tree',
    'actions/deploy-pages@',
    'https://aarusso-nyx.github.io/devai/',
    'The exact release build and artifact assembly completed without publication.',
  ];
  for (const marker of requiredMarkers) {
    if (!source.includes(marker)) findings.push(finding('RELEASE_CONTROL_MISSING', file, marker));
  }
  for (const forbidden of ['test:coverage', 'vitest run', 'pnpm test', 'npm test']) {
    if (source.includes(forbidden)) {
      findings.push(finding('RELEASE_TEST_REEXECUTION_FORBIDDEN', file, forbidden));
    }
  }
  if (source.includes('--package-lock-only')) {
    findings.push(
      finding(
        'RELEASE_SBOM_LOCKFILE_ONLY_FORBIDDEN',
        file,
        'SBOM generation requires installed public runtime dependencies',
      ),
    );
  }
  const verifierCheckout = source.includes(`repository: ${VERIFIER_REPOSITORY}`);
  const verifierPin = source.includes(`ref: ${VERIFIER_COMMIT}`);
  if (!verifierCheckout || !verifierPin) {
    findings.push(finding('RELEASE_VERIFIER_BINDING_INVALID', file, VERIFIER_COMMIT));
  }
  if (!source.includes('test "$(git cat-file -t "$RELEASE_TAG")" = tag')) {
    findings.push(finding('RELEASE_ANNOTATED_TAG_CHECK_MISSING', file, 'git cat-file -t'));
  }
  if (
    !source.includes('git -C candidate config gpg.format ssh') ||
    !source.includes('git -C candidate config gpg.ssh.allowedSignersFile')
  ) {
    findings.push(
      finding(
        'RELEASE_TAG_TRUST_MISSING',
        file,
        'signed tags must verify against protected SSH allowed signers',
      ),
    );
  }
  const pnpmStep = steps.find(({ step }) =>
    typeof step.uses === 'string' ? step.uses.startsWith('pnpm/action-setup@') : false,
  );
  if (pnpmStep === undefined) {
    findings.push(finding('RELEASE_PNPM_SETUP_MISSING', file, PNPM_SETUP_TAG_OBJECT));
  } else if (object(pnpmStep.step.with).version !== undefined) {
    findings.push(
      finding(
        'RELEASE_PNPM_VERSION_CONFLICT',
        file,
        'packageManager is canonical; remove with.version',
      ),
    );
  }
  if (source.includes('--clobber')) {
    findings.push(finding('RELEASE_ASSET_CLOBBER_FORBIDDEN', file, '--clobber'));
  }
  if (!source.includes('if npm view "$PACKAGE_NAME@$PACKAGE_VERSION"')) {
    findings.push(finding('RELEASE_IDEMPOTENT_PUBLISH_MISSING', file, 'npm view exact version'));
  }
}

function printResult(result) {
  if (result.ok) {
    process.stdout.write('workflow contract: PASS\n');
    return;
  }
  for (const item of result.findings) {
    process.stderr.write(`${item.code}: ${item.file}: ${item.detail}\n`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  printResult(checkWorkflowTree(process.cwd()));
}
