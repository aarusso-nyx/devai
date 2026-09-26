#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

export const LEDGER_WORKFLOW_FILE = 'devai-ledger-verify.yml';
export const RELEASE_WORKFLOW_FILE = 'release.yml';
// Required own-repository non-attesting preflight lane. Contract:
// docs/dev/operations/remote-preflight-contract.md
export const PREFLIGHT_WORKFLOW_FILE = 'pull-request-checks.yml';
// Toolchain identity is owned by the adopter manifest (ADR-CHK-0002). The
// exported pin constants below are derived from this repository's manifest at
// load time; checkWorkflowTree(root) compares each workflow against the
// manifest under root, falling back to this repository's manifest when root
// carries none.
export const TOOLCHAIN_MANIFEST_RELATIVE_PATH = '.devai/config/toolchain.json';
const DEFAULT_TOOLCHAIN_MANIFEST_PATH = fileURLToPath(
  new URL(`../${TOOLCHAIN_MANIFEST_RELATIVE_PATH}`, import.meta.url),
);
// ADR-SEC-0001: every secret a workflow job references must be declared by the
// credential manifest for that workflow and job, and every workflow consumer the
// manifest declares must be referenced. Action and command consumers are exempt.
export const CREDENTIAL_MANIFEST_RELATIVE_PATH = 'law/policy/credential-requirements.json';
const DEFAULT_CREDENTIAL_MANIFEST_PATH = fileURLToPath(
  new URL(`../${CREDENTIAL_MANIFEST_RELATIVE_PATH}`, import.meta.url),
);
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/u;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u;

/**
 * Reads and structurally validates a toolchain manifest. Only the fields the
 * checker consumes are validated here; the full contract is
 * law/schemas/toolchain-manifest.schema.json.
 */
export function loadToolchainManifest(path) {
  if (!existsSync(path)) {
    throw new Error(`DEVAI_TOOLCHAIN_MANIFEST_REQUIRED: ${path}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `DEVAI_TOOLCHAIN_MANIFEST_INVALID: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const invalid = (reason) => new Error(`DEVAI_TOOLCHAIN_MANIFEST_INVALID: ${path}: ${reason}`);
  if (object(manifest).schemaVersion !== '1.0.0') throw invalid('schemaVersion');
  for (const key of ['node', 'pnpm', 'git']) {
    if (!EXACT_VERSION.test(String(object(manifest.runtimes)[key]))) {
      throw invalid(`runtimes.${key}`);
    }
  }
  const actions = object(manifest.actions);
  if (Object.keys(actions).length === 0) throw invalid('actions');
  for (const [key, value] of Object.entries(actions)) {
    const pin = object(value);
    if (
      !GIT_OBJECT_ID.test(String(pin.digest)) ||
      (pin.peeled_commit !== undefined && !GIT_OBJECT_ID.test(String(pin.peeled_commit)))
    ) {
      throw invalid(`actions.${key}`);
    }
  }
  if (typeof object(manifest.verifier).package !== 'string') throw invalid('verifier.package');
  const constants = object(manifest.constants);
  if (
    constants.expected_action_count !== undefined &&
    !Number.isInteger(constants.expected_action_count)
  ) {
    throw invalid('constants.expected_action_count');
  }
  return manifest;
}

function manifestActionDigest(manifest, key) {
  const digest = object(object(manifest.actions)[key]).digest;
  if (typeof digest !== 'string') {
    throw new Error(`DEVAI_TOOLCHAIN_MANIFEST_INVALID: actions.${key} is not declared`);
  }
  return digest;
}

/** The pinned values a check run compares workflows against. */
function toolchainPins(manifest) {
  const pnpmSetup = object(object(manifest.actions)['pnpm/action-setup']);
  return {
    manifest,
    checkout: object(object(manifest.actions)['actions/checkout']).digest,
    setupNode: object(object(manifest.actions)['actions/setup-node']).digest,
    pnpmTagObject: pnpmSetup.digest,
    pnpmPeeledCommit: pnpmSetup.peeled_commit ?? pnpmSetup.digest,
    verifierPackage: manifest.verifier.package,
    ledgerEnvironment: object(manifest.constants).ledger_environment ?? 'devai-ledger-verification',
    expectedActionCount: object(manifest.constants).expected_action_count,
  };
}

const DEFAULT_TOOLCHAIN_MANIFEST = loadToolchainManifest(DEFAULT_TOOLCHAIN_MANIFEST_PATH);
const DEFAULT_PINS = toolchainPins(DEFAULT_TOOLCHAIN_MANIFEST);

export const VERIFIER_PACKAGE = DEFAULT_PINS.verifierPackage;
// Not modeled by the manifest: the trusted verifier policy owns source commits.
export const VERIFIER_SOURCE_COMMIT = '4e202ca3c9aade41f3d3a0286a4e7a37a175790a';
export const NEXT_VERIFIER_SOURCE_COMMIT = '8174749ebcfabab246031281a036032f636b8a39';
export const LEDGER_ENVIRONMENT = DEFAULT_PINS.ledgerEnvironment;
export const CHECKOUT_COMMIT = manifestActionDigest(DEFAULT_TOOLCHAIN_MANIFEST, 'actions/checkout');
export const SETUP_NODE_COMMIT = manifestActionDigest(
  DEFAULT_TOOLCHAIN_MANIFEST,
  'actions/setup-node',
);
// v4.1.0 is an annotated tag: the digest is the immutable tag object accepted
// by Actions, not its peeled commit. The manifest keeps both identities so the
// checker does not falsely demand a repin from the authentic object to its commit.
export const PNPM_SETUP_TAG_OBJECT = manifestActionDigest(
  DEFAULT_TOOLCHAIN_MANIFEST,
  'pnpm/action-setup',
);
export const PNPM_SETUP_PEELED_COMMIT = DEFAULT_PINS.pnpmPeeledCommit;
export const UPLOAD_ARTIFACT_COMMIT = manifestActionDigest(
  DEFAULT_TOOLCHAIN_MANIFEST,
  'actions/upload-artifact',
);
export const DOWNLOAD_ARTIFACT_COMMIT = manifestActionDigest(
  DEFAULT_TOOLCHAIN_MANIFEST,
  'actions/download-artifact',
);
export const CONFIGURE_PAGES_COMMIT = manifestActionDigest(
  DEFAULT_TOOLCHAIN_MANIFEST,
  'actions/configure-pages',
);
export const UPLOAD_PAGES_COMMIT = manifestActionDigest(
  DEFAULT_TOOLCHAIN_MANIFEST,
  'actions/upload-pages-artifact',
);
export const DEPLOY_PAGES_COMMIT = manifestActionDigest(
  DEFAULT_TOOLCHAIN_MANIFEST,
  'actions/deploy-pages',
);
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

// Scripts whose results are bound into a candidate receipt. A preflight lane
// must never reach them: re-running the attested closure remotely costs money
// and proves nothing the receipt does not already claim.
const PREFLIGHT_FORBIDDEN_SCRIPTS = [
  'test:coverage:rc',
  'test:db:rc',
  'test:e2e:rc',
  'test:performance:rc',
  'test:containment:rc',
  'release:closure',
  'authority:materialize',
];
// The cheap local closure, plus the install and build it needs.
const PREFLIGHT_ALLOWED_SCRIPTS = [
  'build',
  'release:bootstrap',
  'format:check',
  'lint',
  'typecheck',
  'release:static-integrity',
  'release:pr-gate',
];
// Tokens that would make a preflight run look like an evidence path. Checked
// against executed content only (run bodies, step names, uses) — never against
// comments, which are documentation and carry no authority.
// The collapsed lane (ADR-CHK-0001): the step ids in order and the commands
// each must carry.
const PREFLIGHT_STEP_ID = 'preflight';
const PREFLIGHT_LANE_STEP_IDS = ['install', PREFLIGHT_STEP_ID, 'affected'];
const PREFLIGHT_BASE = '--base ${{ github.event.pull_request.base.sha }}';
const PREFLIGHT_LANE_COMMANDS = {
  install: ['pnpm install --frozen-lockfile', 'pnpm run release:bootstrap'],
  [PREFLIGHT_STEP_ID]: [`check --preflight --run ${PREFLIGHT_BASE}`],
  affected: [`check --affected --run ${PREFLIGHT_BASE}`, 'pnpm run release:pr-gate'],
};
const PREFLIGHT_EVIDENCE_TOKENS =
  /\b(?:evidence|receipt|attest(?:ation)?|verifier|provenance|ledger|sign(?:ing|ed)?)\b/iu;

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

function rootPins(root, findings) {
  const path = join(root, TOOLCHAIN_MANIFEST_RELATIVE_PATH);
  if (!existsSync(path)) return DEFAULT_PINS;
  try {
    return toolchainPins(loadToolchainManifest(path));
  } catch (error) {
    findings.push(
      finding(
        'CI_TOOLCHAIN_MANIFEST_INVALID',
        TOOLCHAIN_MANIFEST_RELATIVE_PATH,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return DEFAULT_PINS;
  }
}

function workflowSteps(workflow) {
  return Object.entries(object(workflow.jobs)).flatMap(([jobName, value]) =>
    (Array.isArray(object(value).steps) ? object(value).steps : []).map((step, index) => ({
      location: `jobs.${jobName}.steps[${String(index)}]`,
      step: object(step),
    })),
  );
}

/**
 * ADR-CHK-0002: every action reference, node version, and restated repository
 * constant in every workflow must agree with the toolchain manifest. Each
 * divergence names the file, the manifest key, the observed value, and the
 * required value.
 */
function checkToolchainPins(file, workflow, pins, findings) {
  const { manifest } = pins;
  const actions = object(manifest.actions);
  const nodeVersion = manifest.runtimes.node;
  const nodeMajor = nodeVersion.split('.')[0];
  for (const { location, step } of workflowSteps(workflow)) {
    const uses = typeof step.uses === 'string' ? step.uses : '';
    const match = /^([^@/]+\/[^@/]+)(?:\/[^@]*)?@(.+)$/u.exec(uses);
    if (match !== null) {
      const [, key, observed] = match;
      const pin = object(actions[key]);
      if (typeof pin.digest !== 'string') {
        findings.push(
          finding(
            'CI_TOOLCHAIN_ACTION_UNDECLARED',
            file,
            `${location} uses ${key}@${observed}; manifest actions.${key} is not declared`,
          ),
        );
      } else if (observed !== pin.digest && observed !== pin.peeled_commit) {
        findings.push(
          finding(
            'CI_TOOLCHAIN_ACTION_DIVERGENT',
            file,
            `${location} manifest actions.${key}: observed ${observed}, required ${pin.digest}`,
          ),
        );
      }
    }
    const declaredNode = object(step.with)['node-version'];
    if (declaredNode !== undefined) {
      const observed = String(declaredNode).trim();
      const exact = EXACT_VERSION.test(observed);
      const observedMajor = /^v?([0-9]+)/u.exec(observed)?.[1];
      if (exact ? observed !== nodeVersion : observedMajor !== nodeMajor) {
        findings.push(
          finding(
            'CI_TOOLCHAIN_NODE_DIVERGENT',
            file,
            exact
              ? `${location} manifest runtimes.node: observed node ${observed}, required node ${nodeVersion}`
              : `${location} manifest runtimes.node: observed node major ${observedMajor ?? observed}, required node major ${nodeMajor}`,
          ),
        );
      }
    }
    const run = typeof step.run === 'string' ? step.run : '';
    const verifierVersion = /echo "version=([0-9]+\.[0-9]+\.[0-9]+)"/u.exec(run)?.[1];
    // The preflight lane materializes the in-repository vendored verifier, not
    // the trusted package, so only the ledger and release lanes restate
    // manifest verifier.version.
    if (
      file !== PREFLIGHT_WORKFLOW_FILE &&
      step.id === 'verifier-package' &&
      verifierVersion !== undefined &&
      verifierVersion !== manifest.verifier.version
    ) {
      findings.push(
        finding(
          'CI_TOOLCHAIN_VERIFIER_DIVERGENT',
          file,
          `${location} manifest verifier.version: observed ${verifierVersion}, required ${String(manifest.verifier.version)}`,
        ),
      );
    }
  }
  const environment = object(workflow.env);
  if (
    pins.expectedActionCount !== undefined &&
    environment.EXPECTED_ACTION_COUNT !== undefined &&
    environment.EXPECTED_ACTION_COUNT !== pins.expectedActionCount
  ) {
    findings.push(
      finding(
        'CI_TOOLCHAIN_CONSTANT_DIVERGENT',
        file,
        `env.EXPECTED_ACTION_COUNT manifest constants.expected_action_count: observed ${String(environment.EXPECTED_ACTION_COUNT)}, required ${String(pins.expectedActionCount)}`,
      ),
    );
  }
}

export function checkWorkflowTree(root = process.cwd()) {
  const findings = [];
  const pins = rootPins(root, findings);
  const files = workflowFiles(root);
  const required = [LEDGER_WORKFLOW_FILE, RELEASE_WORKFLOW_FILE, PREFLIGHT_WORKFLOW_FILE].sort();
  const permitted = required;
  const missing = required.filter((name) => !files.includes(name));
  const unexpected = files.filter((name) => !permitted.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    findings.push(
      finding(
        'CI_WORKFLOW_SET_INVALID',
        '.github/workflows',
        `required ${required.join(', ')}; optional ${PREFLIGHT_WORKFLOW_FILE}; found ${files.join(', ') || 'none'}`,
      ),
    );
  }
  const sources = new Map();
  for (const file of files) {
    const path = join(root, '.github/workflows', file);
    const source = readFileSync(path, 'utf8');
    sources.set(file, source);
    checkWorkflow(file, source, findings, pins);
  }
  checkCredentialBijection(root, sources, findings);
  return { ok: findings.length === 0, files, findings };
}

function loadCredentialManifest(root, findings) {
  const rootPath = join(root, CREDENTIAL_MANIFEST_RELATIVE_PATH);
  const path = existsSync(rootPath) ? rootPath : DEFAULT_CREDENTIAL_MANIFEST_PATH;
  try {
    const entries = JSON.parse(readFileSync(path, 'utf8')).entries;
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
    return entries.map(object).filter((entry) => typeof entry.id === 'string');
  } catch (error) {
    findings.push(
      finding(
        'CI_CREDENTIAL_MANIFEST_INVALID',
        CREDENTIAL_MANIFEST_RELATIVE_PATH,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return undefined;
  }
}

/** Credential names a workflow fragment references: secrets.NAME, secrets['NAME'], github.token. */
export function credentialReferences(value) {
  const text = JSON.stringify(value) ?? '';
  const names = new Set();
  for (const match of text.matchAll(
    /\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*\\?['"]([A-Za-z_][A-Za-z0-9_]*)\\?['"]\s*\])/gu,
  )) {
    names.add(match[1] ?? match[2]);
  }
  if (/\bgithub\s*\.\s*token\b/u.test(text)) names.add('GITHUB_TOKEN');
  return names;
}

function checkCredentialBijection(root, sources, findings) {
  const entries = loadCredentialManifest(root, findings);
  if (entries === undefined) return;
  const declared = new Set();
  for (const entry of entries) {
    for (const consumer of Array.isArray(entry.consumer) ? entry.consumer.map(object) : []) {
      if (typeof consumer.workflow === 'string' && typeof consumer.job === 'string') {
        declared.add(`${consumer.workflow}#${consumer.job}#${entry.id}`);
      }
    }
  }
  const referenced = new Set();
  for (const [file, source] of sources) {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) continue;
    const workflow = object(document.toJS());
    const workflowPath = `.github/workflows/${file}`;
    const { jobs, ...workflowLevel } = workflow;
    for (const name of credentialReferences(workflowLevel)) {
      findings.push(
        finding(
          'CI_CREDENTIAL_SCOPE_INVALID',
          file,
          `${name} is referenced at workflow level; reference it inside the consuming job`,
        ),
      );
    }
    for (const [job, value] of Object.entries(object(jobs))) {
      for (const name of credentialReferences(value)) {
        referenced.add(`${workflowPath}#${job}#${name}`);
        if (!declared.has(`${workflowPath}#${job}#${name}`)) {
          findings.push(
            finding(
              'CI_CREDENTIAL_UNDECLARED',
              file,
              `jobs.${job} references ${name}, which ${CREDENTIAL_MANIFEST_RELATIVE_PATH} does not declare for ${workflowPath} job ${job}`,
            ),
          );
        }
      }
    }
  }
  for (const key of [...declared].sort()) {
    const [workflowPath, job, name] = key.split('#');
    const file = workflowPath.slice('.github/workflows/'.length);
    if (!sources.has(file) || referenced.has(key)) continue;
    findings.push(
      finding(
        'CI_CREDENTIAL_UNREFERENCED',
        file,
        `${name} is declared for ${workflowPath} job ${job}, which never references it`,
      ),
    );
  }
}

function checkOrdinaryLedgerWorkflow(file, workflow, findings) {
  const job = object(object(workflow.jobs)['verify-ledger']);
  const steps = Array.isArray(job.steps) ? job.steps.map(object) : [];
  const transport = steps.find((step) =>
    String(step.run ?? '').includes('scripts/process/evidence_transport.py materialize'),
  );
  const retiredCeremony = steps.some((step) =>
    /installed_control_transport\.py|installed-export-command\.mjs/u.test(String(step.run ?? '')),
  );
  if (
    retiredCeremony ||
    object(transport?.env).BUNDLE_SCHEMA_VERSION !== '1.0.0' ||
    object(transport?.env).LEDGER_TRANSPORT !== "${{ vars.DEVAI_LEDGER_TRANSPORT || 'legacy' }}"
  ) {
    findings.push(
      finding(
        'CI_MUTATION_CEREMONY_FORBIDDEN',
        file,
        'delivery uses ordinary ledger transport and must not require the retired installed mutation export ceremony',
      ),
    );
  }
}

function checkWorkflow(file, source, findings, pins) {
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
  checkToolchainPins(file, workflow, pins, findings);
  if ([RELEASE_WORKFLOW_FILE, LEDGER_WORKFLOW_FILE].includes(file))
    checkOrdinaryLedgerWorkflow(file, workflow, findings);

  if (file === RELEASE_WORKFLOW_FILE) {
    checkReleaseWorkflow(file, workflow, source, findings, pins);
    return;
  }
  if (file === PREFLIGHT_WORKFLOW_FILE) {
    checkPreflightWorkflow(file, workflow, source, findings, pins);
    return;
  }
  if (file !== LEDGER_WORKFLOW_FILE) {
    findings.push(finding('CI_WORKFLOW_UNRECOGNIZED', file, 'workflow is outside the RC set'));
    return;
  }

  const triggers = object(workflow.on);
  const triggerNames = Object.keys(triggers).sort();
  const expectedTriggers = ['push', 'workflow_dispatch'];
  if (
    triggerNames.length !== expectedTriggers.length ||
    triggerNames.some((name, index) => name !== expectedTriggers[index])
  ) {
    findings.push(
      finding(
        'CI_WORKFLOW_TRUST_BOUNDARY_INVALID',
        file,
        'workflow must use unprivileged pull_request preflight, push, and workflow_dispatch only',
      ),
    );
  }

  const permissions = object(workflow.permissions);
  if (Object.keys(permissions).length !== 1 || permissions.contents !== 'read') {
    findings.push(
      finding('CI_WORKFLOW_PERMISSIONS_INVALID', file, 'only contents: read is permitted'),
    );
  }
  if (object(workflow.env).CANDIDATE_SHA !== '${{ github.sha }}') {
    findings.push(
      finding(
        'CI_CANDIDATE_SHA_UNBOUND',
        file,
        'CANDIDATE_SHA must select pull-request head SHA or github.sha exactly',
      ),
    );
  }

  const jobs = object(workflow.jobs);
  if (JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(['verify-ledger'])) {
    findings.push(
      finding(
        'CI_LEDGER_JOB_SET_INVALID',
        file,
        'candidate-preflight and verify-ledger jobs are required',
      ),
    );
  }
  const job = object(jobs['verify-ledger']);
  if (job.if !== "${{ github.event_name != 'pull_request' }}") {
    findings.push(
      finding(
        'CI_LEDGER_TRUSTED_EVENT_GUARD_MISSING',
        file,
        'protected ledger verification must not run for pull_request events',
      ),
    );
  }
  if (job.environment !== pins.ledgerEnvironment) {
    findings.push(
      finding(
        'CI_LEDGER_ENVIRONMENT_MISSING',
        file,
        `verify-ledger must use protected environment ${pins.ledgerEnvironment}`,
      ),
    );
  }
  const privilegedSteps = Array.isArray(job.steps) ? job.steps.map(object) : [];
  const steps = privilegedSteps;
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
      (uses.startsWith('actions/checkout@') && uses !== `actions/checkout@${pins.checkout}`) ||
      (uses.startsWith('actions/setup-node@') && uses !== `actions/setup-node@${pins.setupNode}`)
    ) {
      findings.push(finding('CI_ACTION_PIN_MISMATCH', file, `${location} uses ${uses}`));
    }
    const run = typeof step.run === 'string' ? step.run : '';
    if (PRODUCT_EXECUTION.some((pattern) => pattern.test(run))) {
      findings.push(
        finding('CI_PRODUCT_EXECUTION_FORBIDDEN', file, `${location} runs product tooling`),
      );
    }
    if (/(?:scripts|packages|candidate)\/[A-Za-z0-9_./-]*(?:verify|verifier)/iu.test(run)) {
      findings.push(
        finding('CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN', file, `${location} invokes local code`),
      );
    }
  }

  const checkouts = steps.filter((step) =>
    typeof step.uses === 'string' ? step.uses.startsWith('actions/checkout@') : false,
  );
  const candidateCheckouts = checkouts.filter((step) => object(step.with).path === 'candidate');
  if (
    candidateCheckouts.length !== 1 ||
    candidateCheckouts.some(
      (candidateCheckout) =>
        object(candidateCheckout.with).ref !== '${{ env.CANDIDATE_SHA }}' ||
        object(candidateCheckout.with).repository !== undefined ||
        object(candidateCheckout.with)['persist-credentials'] !== false,
    )
  ) {
    findings.push(
      finding('CI_CANDIDATE_CHECKOUT_UNBOUND', file, 'candidate checkout must use exact SHA'),
    );
  }
  if (checkouts.some((step) => object(step.with).repository !== undefined)) {
    findings.push(
      finding(
        'CI_EXTERNAL_VERIFIER_CHECKOUT_FORBIDDEN',
        file,
        'only candidate checkout is allowed',
      ),
    );
  }

  const controls = checkouts.filter((step) => object(step.with).path === 'release-control');
  if (
    controls.length !== 1 ||
    object(controls[0].with).ref !== '${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }}' ||
    object(controls[0].with)['persist-credentials'] !== false ||
    !source.includes('[[ "$CONTROL_COMMIT" =~ ^[a-f0-9]{40}$ ]]')
  ) {
    findings.push(
      finding(
        'CI_PROCESS_CONTROL_UNBOUND',
        file,
        'transport requires approved exact control revision',
      ),
    );
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
    'vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256',
    'vars.DEVAI_LEDGER_POLICY_DIGEST',
    'vars.DEVAI_LEDGER_TRANSPORT',
    'vars.DEVAI_LEDGER_BUNDLE_SHA256',
    'secrets.DEVAI_EVIDENCE_READ_TOKEN',
    'vars.DEVAI_PROCESS_CONTROL_COMMIT',
  ];
  for (const input of externalInputs) {
    if (!serialized.includes(input)) {
      findings.push(finding('CI_EXTERNAL_CONTROL_INPUT_MISSING', file, input));
    }
  }
  for (const marker of [
    'trusted_commit="8b600ed16ebd101ff88ecfaac9cc04abcf0ce174"',
    'trusted_tree="d2f60e0602ffc849e9b5b1b52ca54731eca7c8b1"',
    'git -C candidate archive "$trusted_commit"',
    'package_root="$source/packages/cli"',
    'source_root="$package_root/vendor/evidence-verification"',
    'test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"',
    'cp "$source_root/provenance.json" "$verifier_root/provenance.json"',
    'cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"',
    `manifest.name !== '${pins.verifierPackage}'`,
    `provenance.sourceCommit !== '${NEXT_VERIFIER_SOURCE_COMMIT}'`,
    'DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID',
    'DEVAI_VERIFIER_PACKAGE_SPECIAL_FILE_INVALID',
    'DEVAI_EVIDENCE_POLICY=$verifier_root/src/build-policy-cli.js',
    'DEVAI_EVIDENCE_VERIFY=$verifier_root/src/cli.js',
  ]) {
    if (!source.includes(marker)) {
      findings.push(finding('CI_VERIFIER_PACKAGE_BINDING_MISSING', file, marker));
    }
  }
  for (const forbidden of [
    'DEVAI_LEDGER_PACKAGE_TGZ_B64',
    'DEVAI_LEDGER_PACKAGE_SHA256',
    'node candidate/packages/cli/vendor',
  ]) {
    if (source.includes(forbidden)) {
      findings.push(finding('CI_VERIFIER_AUTHORITY_BYPASS_FORBIDDEN', file, forbidden));
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

  const verifierRun = privilegedSteps
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .find((run) => run.includes('node "$DEVAI_EVIDENCE_VERIFY"'));
  if (verifierRun === undefined) {
    findings.push(
      finding(
        'CI_VERIFIER_INVOCATION_MISSING',
        file,
        'protected packaged verifier CLI is not invoked',
      ),
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
  const policyBuilderRun = privilegedSteps
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .find((run) => run.includes('node "$DEVAI_EVIDENCE_POLICY"'));
  if (policyBuilderRun === undefined) {
    findings.push(
      finding(
        'CI_EXPECTED_POLICY_RECONSTRUCTION_MISSING',
        file,
        'protected packaged policy builder is not invoked',
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

/**
 * Non-attesting preflight contract. Two properties are enforced mechanically:
 * the lane is untrusted (no protected inputs it could leak), and it is
 * non-attesting (no path by which its result becomes evidence).
 * See docs/dev/operations/remote-preflight-contract.md.
 */
function checkPreflightWorkflow(file, workflow, source, findings, pins) {
  const triggerNames = Object.keys(object(workflow.on)).sort();
  if (triggerNames.length !== 1 || triggerNames[0] !== 'pull_request') {
    findings.push(
      finding(
        'CI_PREFLIGHT_TRIGGER_INVALID',
        file,
        'preflight must trigger on pull_request only; push, schedule, and workflow_dispatch would reach a protected ref',
      ),
    );
  }

  const permissions = object(workflow.permissions);
  if (Object.keys(permissions).length !== 1 || permissions.contents !== 'read') {
    findings.push(
      finding('CI_WORKFLOW_PERMISSIONS_INVALID', file, 'only contents: read is permitted'),
    );
  }

  const concurrency = object(workflow.concurrency);
  if (
    concurrency['cancel-in-progress'] !== true ||
    concurrency.group !== '${{ github.workflow }}-pr-${{ github.event.pull_request.number }}'
  ) {
    findings.push(
      finding(
        'CI_PREFLIGHT_CONCURRENCY_INVALID',
        file,
        'preflight must declare concurrency with cancel-in-progress: true',
      ),
    );
  }

  // GitHub contexts also support bracket access and whole-context expressions.
  // Dotted-name matching alone permits e.g. toJSON(secrets) to bypass this guard.
  const protectedExpression = [...source.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)].some((match) =>
    /\b(?:secrets|vars)\b/u.test(match[1] ?? ''),
  );
  if (/\b(?:secrets|vars)\s*(?:\.|\[)/u.test(source) || protectedExpression) {
    findings.push(
      finding('CI_PREFLIGHT_SECRET_ACCESS_FORBIDDEN', file, 'preflight must reference no secret'),
    );
  }

  const jobs = object(workflow.jobs);
  if (Object.keys(jobs).length === 0) {
    findings.push(finding('CI_PREFLIGHT_JOBS_MISSING', file, 'preflight has no jobs'));
    return;
  }

  // The preflight step materializes the vendored verifier for the gate and then
  // runs the preflight probe nodes (ADR-CHK-0001).
  const materializer = Object.values(jobs)
    .flatMap((job) => object(job).steps ?? [])
    .find((step) => step.id === PREFLIGHT_STEP_ID);
  for (const marker of [
    'DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID',
    'DEVAI_VERIFIER_PACKAGE_SPECIAL_FILE_INVALID',
    'DEVAI_VERIFIER_PACKAGE_FILE_DIGEST_INVALID',
    'manifest.name',
    'provenance.sourceCommit',
  ]) {
    if (!materializer?.run?.includes(marker))
      findings.push(finding('CI_PREFLIGHT_VERIFIER_MISSING', file, marker));
  }
  if (
    materializer &&
    /node\s+["']?\$DEVAI_EVIDENCE_(?:VERIFY|EXPORT|POLICY|BUNDLE_VERIFY)/u.test(materializer.run)
  ) {
    findings.push(
      finding(
        'CI_PREFLIGHT_NON_ATTESTING_VIOLATION',
        file,
        'materialization cannot execute evidence verification',
      ),
    );
  }
  if (
    JSON.stringify(Object.keys(jobs)) !== JSON.stringify(['preflight']) ||
    jobs.preflight?.name !== 'devai-release-gate' ||
    jobs.preflight?.if !== undefined ||
    (jobs.preflight?.['continue-on-error'] !== undefined &&
      jobs.preflight['continue-on-error'] !== false)
  )
    findings.push(finding('CI_PREFLIGHT_GATE_INVALID', file, 'one required result'));
  // Three run steps, each failing the job on its own: install, the preflight
  // target, and the affected target with the profile gate. The runner report is
  // the aggregate, so no step may be optional or conditional.
  const laneSteps = (Array.isArray(jobs.preflight?.steps) ? jobs.preflight.steps : [])
    .map(object)
    .filter((step) => typeof step.run === 'string');
  if (JSON.stringify(laneSteps.map((step) => step.id)) !== JSON.stringify(PREFLIGHT_LANE_STEP_IDS))
    findings.push(
      finding(
        'CI_PREFLIGHT_GATE_INVALID',
        file,
        `run steps must be exactly ${PREFLIGHT_LANE_STEP_IDS.join(', ')}`,
      ),
    );
  for (const step of laneSteps) {
    if (step['continue-on-error'] !== undefined || step.if !== undefined)
      findings.push(
        finding('CI_PREFLIGHT_GATE_INVALID', file, `step ${String(step.id)} must not be optional`),
      );
  }
  for (const [id, required] of Object.entries(PREFLIGHT_LANE_COMMANDS)) {
    const step = laneSteps.find((candidate) => candidate.id === id);
    for (const text of required) {
      if (!step?.run?.includes(text))
        findings.push(finding('CI_PREFLIGHT_GATE_INVALID', file, `${id} must run ${text}`));
    }
  }
  for (const [name, rawJob] of Object.entries(jobs)) {
    const job = object(rawJob);
    if (
      job.permissions !== undefined &&
      JSON.stringify(job.permissions) !== JSON.stringify({ contents: 'read' })
    )
      findings.push(finding('CI_WORKFLOW_PERMISSIONS_INVALID', file, name));
    if (job.environment !== undefined) {
      findings.push(
        finding(
          'CI_PREFLIGHT_ENVIRONMENT_FORBIDDEN',
          file,
          `jobs.${name} declares an environment; preflight must not reach protected inputs`,
        ),
      );
    }
    if (typeof job['runs-on'] !== 'string' || !job['runs-on'].startsWith('ubuntu-')) {
      findings.push(
        finding('CI_PREFLIGHT_RUNNER_INVALID', file, `jobs.${name} must run on a Linux runner`),
      );
    }
    if (typeof job['timeout-minutes'] !== 'number') {
      findings.push(
        finding('CI_PREFLIGHT_TIMEOUT_MISSING', file, `jobs.${name} must declare timeout-minutes`),
      );
    }

    const steps = Array.isArray(job.steps) ? job.steps.map(object) : [];
    for (const [index, step] of steps.entries()) {
      const location = `jobs.${name}.steps[${String(index)}]`;
      const uses = typeof step.uses === 'string' ? step.uses : '';
      if (uses.startsWith('./')) {
        findings.push(
          finding('CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN', file, `${location} uses ${uses}`),
        );
      } else if (uses !== '' && !/@[0-9a-f]{40}$/u.test(uses)) {
        findings.push(finding('CI_ACTION_REFERENCE_MUTABLE', file, `${location} uses ${uses}`));
      }
      if (
        (uses.startsWith('actions/checkout@') && uses !== `actions/checkout@${pins.checkout}`) ||
        (uses.startsWith('actions/setup-node@') &&
          uses !== `actions/setup-node@${pins.setupNode}`) ||
        (uses.startsWith('pnpm/action-setup@') &&
          uses !== `pnpm/action-setup@${pins.pnpmTagObject}` &&
          uses !== `pnpm/action-setup@${pins.pnpmPeeledCommit}`)
      ) {
        findings.push(finding('CI_ACTION_PIN_MISMATCH', file, `${location} uses ${uses}`));
      }
      if (uses.startsWith('actions/upload-artifact@')) {
        findings.push(
          finding(
            'CI_PREFLIGHT_ARTIFACT_FORBIDDEN',
            file,
            `${location} uploads an artifact; a preflight run leaves nothing behind`,
          ),
        );
      }
      if (
        uses.startsWith('actions/checkout@') &&
        object(step.with)['persist-credentials'] !== false
      ) {
        findings.push(
          finding('CI_PREFLIGHT_CREDENTIALS_PERSISTED', file, `${location} persists credentials`),
        );
      }

      const run = typeof step.run === 'string' ? step.run : '';
      if (run === '') continue;
      const executed = `${typeof step.name === 'string' ? step.name : ''}\n${run}`;
      for (const script of PREFLIGHT_FORBIDDEN_SCRIPTS) {
        if (run.includes(script)) {
          findings.push(
            finding(
              'CI_PREFLIGHT_ATTESTED_CLOSURE_FORBIDDEN',
              file,
              `${location} reaches attested RC script ${script}`,
            ),
          );
        }
      }
      if (
        PREFLIGHT_EVIDENCE_TOKENS.test(
          executed.replaceAll("'verifier-package'", "'package-check'"),
        ) &&
        step.id !== PREFLIGHT_STEP_ID
      ) {
        findings.push(
          finding(
            'CI_PREFLIGHT_NON_ATTESTING_VIOLATION',
            file,
            `${location} executes evidence-path content; preflight must not produce or supplement a receipt`,
          ),
        );
      }
      for (const invocation of run.matchAll(/\bpnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)/gu)) {
        const script = invocation[1];
        if (script === 'install' || PREFLIGHT_ALLOWED_SCRIPTS.includes(script)) continue;
        findings.push(
          finding(
            'CI_PREFLIGHT_SCRIPT_NOT_ALLOWED',
            file,
            `${location} runs pnpm ${script}; permitted: install, ${PREFLIGHT_ALLOWED_SCRIPTS.join(', ')}`,
          ),
        );
      }
    }
  }
}

function checkReleaseWorkflow(file, workflow, source, findings, pins) {
  const triggers = object(workflow.on);
  const push = object(triggers.push);
  const dispatch = object(triggers.workflow_dispatch);
  const dispatchInputs = object(dispatch.inputs);
  const releaseTagInput = object(dispatchInputs.release_tag);
  const publishInput = object(dispatchInputs.publish);
  const publishPagesInput = object(dispatchInputs.publish_pages);
  if (
    JSON.stringify(Object.keys(triggers).sort()) !==
      JSON.stringify(['push', 'workflow_dispatch']) ||
    !Array.isArray(push.tags) ||
    push.tags.length !== 1 ||
    push.tags[0] !== 'v*' ||
    JSON.stringify(Object.keys(dispatchInputs).sort()) !==
      JSON.stringify([
        'candidate_commit',
        'publish',
        'publish_pages',
        'rehearsal_attempt',
        'rehearsal_run_id',
        'release_tag',
      ]) ||
    releaseTagInput.required !== true ||
    releaseTagInput.type !== 'string' ||
    publishInput.required !== false ||
    publishInput.default !== false ||
    publishInput.type !== 'boolean' ||
    publishPagesInput.required !== false ||
    publishPagesInput.default !== false ||
    publishPagesInput.type !== 'boolean'
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
    (pins.expectedActionCount !== undefined &&
      environment.EXPECTED_ACTION_COUNT !== pins.expectedActionCount) ||
    environment.PACKAGE_VERSION !== undefined ||
    environment.RELEASE_TAG !== RELEASE_TAG_EXPRESSION
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
    'promote-assets',
    'rehearsal-summary',
    'verify-ledger',
    'verify-linux-adopter',
  ];
  if (JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(expectedJobs)) {
    findings.push(finding('RELEASE_JOB_SET_INVALID', file, Object.keys(jobs).sort().join(',')));
  }
  const verify = object(jobs['verify-ledger']);
  const build = object(jobs['build-release']);
  const finalize = object(jobs['finalize-release']);
  const pages = object(jobs['deploy-pages']);
  const rehearsal = object(jobs['rehearsal-summary']);
  const linuxAdopter = object(jobs['verify-linux-adopter']);
  if (verify.environment !== pins.ledgerEnvironment) {
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
  const pagesCondition =
    "${{ github.event_name == 'workflow_dispatch' && inputs.publish && inputs.publish_pages }}";
  const rehearsalCondition = "${{ github.event_name == 'workflow_dispatch' && !inputs.publish }}";
  if (finalize.if !== publishCondition || pages.if !== pagesCondition) {
    findings.push(
      finding(
        'RELEASE_REHEARSAL_PUBLICATION_GUARD_MISSING',
        file,
        'finalize-release requires publish:true and deploy-pages additionally requires publish_pages:true',
      ),
    );
  }
  if (
    rehearsal.if !== rehearsalCondition ||
    JSON.stringify(rehearsal.needs) !==
      JSON.stringify(['verify-ledger', 'build-release', 'verify-linux-adopter']) ||
    JSON.stringify(object(rehearsal.permissions)) !== JSON.stringify({ contents: 'read' })
  ) {
    findings.push(
      finding(
        'RELEASE_REHEARSAL_JOB_INVALID',
        file,
        'tag pushes and non-publishing dispatches end in a read-only rehearsal summary after the exact build',
      ),
    );
  }
  if (
    linuxAdopter['runs-on'] !== 'ubuntu-latest' ||
    JSON.stringify(linuxAdopter.needs) !== JSON.stringify('build-release') ||
    JSON.stringify(object(linuxAdopter.permissions)) !== JSON.stringify({ contents: 'read' }) ||
    JSON.stringify(finalize.needs) !== JSON.stringify(['verify-ledger', 'promote-assets']) ||
    JSON.stringify(pages.needs) !== JSON.stringify(['finalize-release', 'promote-assets'])
  ) {
    findings.push(
      finding(
        'RELEASE_LINUX_ADOPTER_JOB_INVALID',
        file,
        'publication must depend on the read-only ubuntu npm adopter quickstart',
      ),
    );
  }

  const promotion = object(jobs['promote-assets']);
  const promotionOutputs = object(promotion.outputs);
  const finalizeSteps = Array.isArray(finalize.steps) ? finalize.steps : [];
  const finalizeAssets = finalizeSteps.find(
    (step) => step.name === 'Download exact release assets',
  );
  if (
    build.if !== rehearsalCondition ||
    linuxAdopter.if !== rehearsalCondition ||
    promotion.if !== publishCondition ||
    promotion.needs !== 'verify-ledger' ||
    promotionOutputs.release_asset_id !== '${{ steps.retain.outputs.artifact-id }}' ||
    finalizeAssets?.with?.['artifact-ids'] !==
      '${{ needs.promote-assets.outputs.release_asset_id }}' ||
    finalizeAssets?.with?.['merge-multiple'] !== true
  ) {
    findings.push(
      finding(
        'RELEASE_PROMOTION_BOUNDARY_INVALID',
        file,
        'build and consumer are rehearsal-only; promotion requires protected verification',
      ),
    );
  }
  for (const name of ['promote-assets', 'finalize-release', 'deploy-pages']) {
    const body = JSON.stringify(jobs[name]);
    if (/pnpm (?:run )?build|stage-release-package|double-pack|npm (?:run )?build/u.test(body))
      findings.push(finding('RELEASE_PROMOTION_REBUILD_FORBIDDEN', file, name));
  }
  for (const name of [
    'verify-ledger',
    'rehearsal-summary',
    'promote-assets',
    'finalize-release',
    'deploy-pages',
  ]) {
    const jobSteps = jobs[name]?.steps ?? [];
    const checkout = jobSteps.find((step) => step.with?.path === 'release-control');
    if (
      checkout?.with?.ref !== '${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }}' ||
      checkout?.with?.['persist-credentials'] !== false ||
      !jobSteps.some((step) => step.run?.includes('[[ "$CONTROL_COMMIT" =~ ^[a-f0-9]{40}$ ]]'))
    )
      findings.push(finding('RELEASE_PROCESS_CONTROL_UNBOUND', file, name));
  }
  const pagesSteps = Array.isArray(pages.steps) ? pages.steps : [];
  const pagesController = pagesSteps.filter((step) => step.id === 'deployment');
  const pagesArtifact = pagesSteps.find((step) => step.id === 'pages-artifact');
  const pagesAssets = pagesSteps.find((step) => step.name === 'Download canonical release assets');
  const pagesRecord = pagesSteps.find(
    (step) => step.name === 'Retain Pages reconciliation identifiers',
  );
  const expectedPagesEnvironment = {
    GH_TOKEN: '${{ github.token }}',
    PAGES_ARTIFACT_ID: '${{ steps.pages-artifact.outputs.artifact_id }}',
    REHEARSAL_RUN: '${{ inputs.rehearsal_run_id }}',
    REHEARSAL_ATTEMPT: '${{ inputs.rehearsal_attempt }}',
    CONTROL_COMMIT: '${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }}',
    PAGES_MIGRATION_AUDIT_JSON: '${{ vars.DEVAI_PAGES_MIGRATION_AUDIT_JSON }}',
    PAGES_MIGRATION_AUDIT_SHA256: '${{ vars.DEVAI_PAGES_MIGRATION_AUDIT_SHA256 }}',
  };
  if (
    pages.concurrency?.group !== 'devai-pages-publication' ||
    pages.concurrency?.['cancel-in-progress'] !== false ||
    pages.permissions?.deployments !== 'write' ||
    pagesController.length !== 1 ||
    pagesController[0].run !==
      'node release-control/scripts/process/publish-pages.mjs release-assets pages-site pages-publication-record' ||
    pagesController[0].if !== undefined ||
    !Object.entries(expectedPagesEnvironment).every(
      ([key, value]) => pagesController[0].env?.[key] === value,
    ) ||
    pagesArtifact?.with?.['retention-days'] !== 30 ||
    pagesArtifact?.with?.name !== 'github-pages-${{ github.run_attempt }}' ||
    pagesAssets?.with?.['artifact-ids'] !==
      '${{ needs.promote-assets.outputs.release_asset_id }}' ||
    pagesAssets?.with?.['merge-multiple'] !== true ||
    pagesRecord?.if !== '${{ always() }}' ||
    pagesRecord?.with?.['retention-days'] !== 30 ||
    pagesRecord?.with?.path !== 'pages-publication-record/*' ||
    pagesSteps.some(
      (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/deploy-pages@'),
    )
  )
    findings.push(
      finding(
        'RELEASE_PAGES_RECOVERY_UNBOUND',
        file,
        'Pages requires serialized durable intent, exact artifact controls and retained recovery records',
      ),
    );
  const immutablePins = new Map(
    Object.entries(object(pins.manifest.actions)).map(([key, pin]) => [key, object(pin).digest]),
  );
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
    'node "$DEVAI_EVIDENCE_VERIFY"',
    'node "$DEVAI_EVIDENCE_POLICY"',
    'vars.DEVAI_LEDGER_VERIFIER_PROVENANCE_SHA256',
    'trusted_commit="8b600ed16ebd101ff88ecfaac9cc04abcf0ce174"',
    'trusted_tree="d2f60e0602ffc849e9b5b1b52ca54731eca7c8b1"',
    'git -C candidate archive "$trusted_commit"',
    'package_root="$source/packages/cli"',
    'source_root="$package_root/vendor/evidence-verification"',
    'test "$actual_provenance_sha256" = "$VERIFIER_PROVENANCE_SHA256"',
    'cp "$source_root/provenance.json" "$verifier_root/provenance.json"',
    'cp -R "$source_root/schemas" "$source_root/src" "$verifier_root/"',
    `manifest.name !== '${pins.verifierPackage}'`,
    `provenance.sourceCommit !== '${NEXT_VERIFIER_SOURCE_COMMIT}'`,
    'DEVAI_VERIFIER_PACKAGE_POPULATION_INVALID',
    'DEVAI_VERIFIER_PACKAGE_SPECIAL_FILE_INVALID',
    '--schema-version 1.1.0',
    'cmp "$control/expected-task-policy.json" "$control/task-policy.json"',
    'secrets.DEVAI_LEDGER_TOOLCHAIN_B64',
    'secrets.DEVAI_LEDGER_ENVIRONMENT_B64',
    'secrets.DEVAI_LEDGER_ARTIFACTS_TGZ_B64',
    'secrets.DEVAI_RELEASE_SIGNERS_B64',
    'pnpm install --frozen-lockfile',
    'pnpm run build',
    'pnpm run release:closure',
    'node packages/cli/scripts/installed-tarball-smoke.mjs --tarball "$tarball" --sha256 "$package_sha256"',
    'stage-release-package.mjs',
    'release-channel.mjs',
    'RELEASE_IS_PRERELEASE',
    'sbom_subject_sha256',
    'Verify npm adopter quickstart on Linux',
    'init bind --target . --tier tier1 --constitution',
    "task.disposition === 'reused'",
    'npm publish',
    '--tag "$PACKAGE_DIST_TAG"',
    'dist-tags.$PACKAGE_DIST_TAG',
    'npm dist-tag add',
    'sha256sum --check SHA256SUMS',
    'gh release create',
    'git -C candidate verify-tag',
    '--binding exact-tree',
    'node release-control/scripts/process/publish-pages.mjs release-assets pages-site pages-publication-record',
    'https://aarusso-nyx.github.io/devai/',
    'All required rehearsal checks passed. No publication occurred.',
    'rehearsal.mjs promote',
    'rehearsal.mjs complete',
    'inputs.rehearsal_run_id',
    'inputs.rehearsal_attempt',
  ];
  for (const marker of requiredMarkers) {
    if (!source.includes(marker)) findings.push(finding('RELEASE_CONTROL_MISSING', file, marker));
  }
  for (const forbidden of [
    'DEVAI_LEDGER_PACKAGE_TGZ_B64',
    'DEVAI_LEDGER_PACKAGE_SHA256',
    'node candidate/packages/cli/vendor',
  ]) {
    if (source.includes(forbidden)) {
      findings.push(finding('RELEASE_VERIFIER_AUTHORITY_BYPASS_FORBIDDEN', file, forbidden));
    }
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
  if (!source.includes('test "$(git -C candidate cat-file -t "$RELEASE_TAG")" = tag')) {
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
    findings.push(finding('RELEASE_PNPM_SETUP_MISSING', file, pins.pnpmTagObject));
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
  if (
    !source.includes('publication-state.mjs registry "$PACKAGE_VERSION"') ||
    !source.includes('publication-state.mjs release "$RELEASE_TAG"')
  ) {
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
