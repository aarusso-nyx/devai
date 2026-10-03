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
// ADR-REL-0029: the site-only Pages publication lane, dispatched from main.
export const SITE_WORKFLOW_FILE = 'site-publish.yml';
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
// TASK-0254: the one recognized local composite action. It wraps only
// post-checkout pnpm/Node setup (never the first checkout of a job — GitHub
// Actions cannot resolve a local action before the repository containing it
// has been checked out), and its own action.yml is pin-validated the same
// way inline workflow steps are, by checkCompositeActionPins below. Any
// other local ("./...") action reference stays forbidden.
const SHARED_SETUP_ACTION = './.github/actions/setup-node-toolchain';
const COMPOSITE_ACTIONS_RELATIVE_DIR = '.github/actions';

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
const PREFLIGHT_LANE_STEP_IDS = ['install', PREFLIGHT_STEP_ID, 'affected', 'soft-gate'];
// ADR-MDL-0004: the provider-free soft gate runs exactly these parsed command lines.
const SOFT_GATE_RUN_LINES = [
  'set -euo pipefail',
  'node .devai/state/pr-bootstrap/cli/bin.js check --only trace --format json > "$RUNNER_TEMP/devai-trace.json"',
  'node .devai/state/pr-bootstrap/cli/bin.js check --only test-trace --format json > "$RUNNER_TEMP/devai-test-trace.json"',
  'node .devai/state/pr-bootstrap/cli/bin.js audit scorecard --repo-root . --at "$(git rev-parse HEAD)" --format json > "$RUNNER_TEMP/devai-scorecard.json"',
  'node scripts/process/check-ci-invariant-gate.mjs --fetch-script scripts/process/fetch-ci-invariant-evidence.mjs --preflight "$RUNNER_TEMP/devai-preflight.json" --affected "$RUNNER_TEMP/devai-affected.json" --trace "$RUNNER_TEMP/devai-trace.json" --test-trace "$RUNNER_TEMP/devai-test-trace.json" --scorecard "$RUNNER_TEMP/devai-scorecard.json"',
];
// Per-event bindings (ADR-CHK-0004, remote-preflight-contract.md Queue
// admission): the merge_group head and base under merge_group, the pull
// request head and base otherwise; the job binds the base once and every base
// argument reads it.
const PREFLIGHT_TRIGGERS = ['merge_group', 'pull_request'];
const PREFLIGHT_TRIGGER_FILTERS = ['paths', 'paths-ignore', 'branches', 'branches-ignore'];
const PREFLIGHT_CANDIDATE_REF =
  "${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}";
const PREFLIGHT_BASE_VARIABLE = 'DEVAI_PREFLIGHT_BASE';
const PREFLIGHT_BASE_BINDING =
  "${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.pull_request.base.sha }}";
// One group per queue entry, keyed by its head sha, and one per pull request, so
// no queue entry cancels another and a new head of a pull request cancels the
// previous one.
const PREFLIGHT_CONCURRENCY_GROUP =
  "${{ github.event_name == 'merge_group' && format('{0}-mq-{1}', github.workflow, github.event.merge_group.head_sha) || format('{0}-pr-{1}', github.workflow, github.event.pull_request.number) }}";
const PREFLIGHT_BASE = `--base "$${PREFLIGHT_BASE_VARIABLE}"`;
const PREFLIGHT_LANE_COMMANDS = {
  install: ['pnpm install --frozen-lockfile', 'pnpm run release:bootstrap'],
  [PREFLIGHT_STEP_ID]: [`check --preflight --run ${PREFLIGHT_BASE}`],
  affected: [
    `check --affected --run ${PREFLIGHT_BASE}`,
    `pnpm run release:pr-gate -- "$${PREFLIGHT_BASE_VARIABLE}"`,
  ],
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
 * required value. Shared by workflow files (via checkToolchainPins) and by
 * the composite action file under .github/actions/ (via
 * checkCompositeActionPins), so a pin drift is caught identically wherever
 * the step now lives (TASK-0254).
 */
function validateActionStepPins(file, location, step, pins, findings) {
  const { manifest } = pins;
  const actions = object(manifest.actions);
  const nodeVersion = manifest.runtimes.node;
  const nodeMajor = nodeVersion.split('.')[0];
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

function checkToolchainPins(file, workflow, pins, findings) {
  for (const { location, step } of workflowSteps(workflow)) {
    validateActionStepPins(file, location, step, pins, findings);
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

/**
 * TASK-0254: validates every composite action under .github/actions/ the same
 * way checkToolchainPins validates inline workflow steps, and forbids a
 * composite from referencing further local ("./...") actions (no recursive
 * indirection around the pin check).
 */
function checkCompositeActionPins(root, pins, findings) {
  const directory = join(root, COMPOSITE_ACTIONS_RELATIVE_DIR);
  if (!existsSync(directory)) return;
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const relDir = `${COMPOSITE_ACTIONS_RELATIVE_DIR}/${name}`;
    const ymlPath = join(root, relDir, 'action.yml');
    const yamlPath = join(root, relDir, 'action.yaml');
    const actualPath = existsSync(ymlPath) ? ymlPath : existsSync(yamlPath) ? yamlPath : null;
    if (actualPath === null) {
      findings.push(
        finding('CI_COMPOSITE_ACTION_MISSING', relDir, 'action.yml or action.yaml not found'),
      );
      continue;
    }
    const file = `${relDir}/${actualPath === ymlPath ? 'action.yml' : 'action.yaml'}`;
    const source = readFileSync(actualPath, 'utf8');
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      for (const error of document.errors) {
        findings.push(finding('CI_WORKFLOW_YAML_INVALID', file, error.message));
      }
      continue;
    }
    const action = object(document.toJS());
    if (object(action.runs).using !== 'composite') {
      findings.push(finding('CI_COMPOSITE_ACTION_INVALID', file, 'runs.using must be composite'));
      continue;
    }
    const steps = Array.isArray(object(action.runs).steps) ? object(action.runs).steps : [];
    steps.forEach((rawStep, index) => {
      const step = object(rawStep);
      const location = `runs.steps[${String(index)}]`;
      validateActionStepPins(file, location, step, pins, findings);
      const uses = typeof step.uses === 'string' ? step.uses : '';
      if (uses.startsWith('./')) {
        findings.push(
          finding(
            'CI_COMPOSITE_ACTION_LOCAL_USE_FORBIDDEN',
            file,
            `${location} uses ${uses}; a composite action must not reference another local action`,
          ),
        );
      } else if (uses !== '' && !/@[0-9a-f]{40}$/u.test(uses)) {
        findings.push(finding('CI_ACTION_REFERENCE_MUTABLE', file, `${location} uses ${uses}`));
      }
    });
  }
}

// ADR-GOV-0021: each workflow page carries a metadata block (the first fenced yaml block after the
// marker) naming its workflow file, triggers, and jobs; it is compared with the file, never the prose.
export const WORKFLOW_PAGES_DIRECTORY = 'docs/dev/operations/workflows';
const WORKFLOW_METADATA_MARKER = '<!-- devai:workflow-metadata -->';

function keyList(value) {
  return Object.keys(object(value));
}

function checkWorkflowPageMetadata(root, sources, findings) {
  for (const [file, source] of sources) {
    const stem = file.replace(/\.ya?ml$/u, '');
    const pagePath = `${WORKFLOW_PAGES_DIRECTORY}/${stem}.md`;
    const absolute = join(root, pagePath);
    if (!existsSync(absolute)) continue; // the docs-ia page-set gate owns a missing page
    const drift = (detail) =>
      findings.push(finding('DOCS_WORKFLOW_METADATA_DRIFT', pagePath, detail));
    const page = readFileSync(absolute, 'utf8');
    const marker = page.indexOf(WORKFLOW_METADATA_MARKER);
    const block =
      marker < 0
        ? null
        : /^\s*```ya?ml\r?\n([\s\S]*?)\r?\n```/u.exec(
            page.slice(marker + WORKFLOW_METADATA_MARKER.length),
          )?.[1];
    if (block === null || block === undefined) {
      drift(`${pagePath} has no metadata block after ${WORKFLOW_METADATA_MARKER}`);
      continue;
    }
    const metadataDocument = parseDocument(block, { uniqueKeys: true });
    const workflowDocument = parseDocument(source);
    if (metadataDocument.errors.length > 0 || workflowDocument.errors.length > 0) {
      if (metadataDocument.errors.length > 0)
        drift(`metadata block is not valid YAML: ${metadataDocument.errors[0].message}`);
      continue; // an invalid workflow file is reported by checkWorkflow
    }
    const metadata = object(metadataDocument.toJS());
    const workflow = object(workflowDocument.toJS());
    // YAML 1.1 loaders read a bare `on` as true; the yaml package keeps the string key.
    const actualTriggers = keyList(workflow.on ?? workflow[true]);
    const actualJobs = keyList(workflow.jobs);
    if (metadata.workflow !== `.github/workflows/${file}`) {
      drift(`workflow is ${JSON.stringify(metadata.workflow)}; expected .github/workflows/${file}`);
    }
    for (const [key, actual] of [
      ['triggers', actualTriggers],
      ['jobs', actualJobs],
    ]) {
      const listed = Array.isArray(metadata[key]) ? metadata[key].map(String) : [];
      if (listed.join('\n') === actual.join('\n')) continue;
      const absent = actual.filter((name) => !listed.includes(name));
      const extra = listed.filter((name) => !actual.includes(name));
      const parts = [
        ...absent.map((name) => `${key.slice(0, -1)} ${name} is in ${file} but not on the page`),
        ...extra.map((name) => `${key.slice(0, -1)} ${name} is on the page but not in ${file}`),
      ];
      if (parts.length === 0) parts.push(`${key} order differs: file has ${actual.join(', ')}`);
      drift(parts.join('; '));
    }
  }
}

export function checkWorkflowTree(root = process.cwd()) {
  const findings = [];
  const pins = rootPins(root, findings);
  const files = workflowFiles(root);
  const required = [
    LEDGER_WORKFLOW_FILE,
    RELEASE_WORKFLOW_FILE,
    PREFLIGHT_WORKFLOW_FILE,
    SITE_WORKFLOW_FILE,
  ].sort();
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
  checkWorkflowPageMetadata(root, sources, findings);
  checkCredentialBijection(root, sources, findings);
  checkCompositeActionPins(root, pins, findings);
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
  if (text.includes('vars.DEVAI_SOFT_GATE_TRUST_JSON')) names.add('DEVAI_SOFT_GATE_TRUST_JSON');

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
      const refs = credentialReferences(value);
      // actions/checkout without an explicit token input authenticates with the job token
      // implicitly. That use satisfies a declared GITHUB_TOKEN consumer for any job; it is
      // derived from the steps and the manifest, never from a workflow or job name.
      const implicitCheckoutToken =
        Array.isArray(value?.steps) &&
        value.steps.some(
          (step) =>
            String(object(step).uses ?? '').startsWith('actions/checkout@') &&
            object(object(step).with).token === undefined,
        );
      if (implicitCheckoutToken && declared.has(`${workflowPath}#${job}#GITHUB_TOKEN`))
        refs.add('GITHUB_TOKEN');
      for (const name of refs) {
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
  if (file === SITE_WORKFLOW_FILE) {
    checkSiteWorkflow(file, workflow, source, findings);
    return;
  }
  if (file !== LEDGER_WORKFLOW_FILE) {
    findings.push(finding('CI_WORKFLOW_UNRECOGNIZED', file, 'workflow is outside the RC set'));
    return;
  }

  const triggers = object(workflow.on);
  const triggerNames = Object.keys(triggers).sort();
  // Ledger verification runs only on manual dispatch: a push trigger left one run
  // waiting on the protected environment per merge to main (issue #153).
  const expectedTriggers = ['workflow_dispatch'];
  if (
    triggerNames.length !== expectedTriggers.length ||
    triggerNames.some((name, index) => name !== expectedTriggers[index])
  ) {
    findings.push(
      finding(
        'CI_WORKFLOW_TRUST_BOUNDARY_INVALID',
        file,
        'workflow must use workflow_dispatch only',
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
    if (uses === SHARED_SETUP_ACTION) {
      // Recognized, pin-validated by checkCompositeActionPins; never candidate code.
    } else if (uses.startsWith('./')) {
      findings.push(
        finding('CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN', file, `${location} uses ${uses}`),
      );
    } else if (uses !== '' && !/@[0-9a-f]{40}$/u.test(uses)) {
      findings.push(finding('CI_ACTION_REFERENCE_MUTABLE', file, `${location} uses ${uses}`));
    }
    if (
      uses !== SHARED_SETUP_ACTION &&
      ((uses.startsWith('actions/checkout@') && uses !== `actions/checkout@${pins.checkout}`) ||
        (uses.startsWith('actions/setup-node@') && uses !== `actions/setup-node@${pins.setupNode}`))
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
  const triggers = object(workflow.on);
  const triggerNames = Object.keys(triggers).sort();
  if (JSON.stringify(triggerNames) !== JSON.stringify(PREFLIGHT_TRIGGERS)) {
    findings.push(
      finding(
        'CI_PREFLIGHT_TRIGGER_INVALID',
        file,
        'preflight must trigger on exactly pull_request and merge_group; push, schedule, and workflow_dispatch would reach a protected ref',
      ),
    );
  }
  for (const name of PREFLIGHT_TRIGGERS) {
    const filters = Object.keys(object(triggers[name])).filter((key) =>
      PREFLIGHT_TRIGGER_FILTERS.includes(key),
    );
    if (filters.length > 0)
      findings.push(
        finding(
          'CI_PREFLIGHT_TRIGGER_INVALID',
          file,
          `${name} must carry no ${filters.join(', ')} filter; a filter lets a candidate suppress the gate`,
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
    concurrency.group !== PREFLIGHT_CONCURRENCY_GROUP
  ) {
    findings.push(
      finding(
        'CI_PREFLIGHT_CONCURRENCY_INVALID',
        file,
        `preflight must declare concurrency group ${PREFLIGHT_CONCURRENCY_GROUP} with cancel-in-progress: true, so one queue entry never cancels another`,
      ),
    );
  }

  // Exactly one independently controlled public metadata seam; all other protected reads refuse.
  const softSteps =
    object(workflow.jobs).preflight?.steps?.filter((step) => step.id === 'soft-gate') ?? [];
  const trustExpression = '${{ vars.DEVAI_SOFT_GATE_TRUST_JSON }}';
  const trustLine = `DEVAI_SOFT_GATE_TRUST_JSON: ${trustExpression}`;
  const soft = object(softSteps[0]);
  const validTrust =
    softSteps.length === 1 &&
    JSON.stringify(Object.keys(soft).sort()) ===
      JSON.stringify(['env', 'id', 'name', 'run', 'shell']) &&
    soft.shell === 'bash' &&
    JSON.stringify(object(soft.env)) ===
      JSON.stringify({ DEVAI_SOFT_GATE_TRUST_JSON: trustExpression }) &&
    JSON.stringify(runLines(soft)) === JSON.stringify(SOFT_GATE_RUN_LINES);
  // Raw-source scan: an implicit expression (e.g. `if: vars.X`) or bracket access is a read
  // even outside `${{ }}`. Only the single exact trust env line is removed before scanning.
  const trustLines = source.split('\n').filter((line) => line.trim() === trustLine);
  const remainder = source
    .split('\n')
    .filter((line) => line.trim() !== trustLine)
    .join('\n');
  const protectedExpression = [...remainder.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)].some((match) =>
    /\b(?:secrets|vars)\b/u.test(match[1] ?? ''),
  );
  if (
    !validTrust ||
    trustLines.length !== 1 ||
    source.split(trustExpression).length !== 2 ||
    /\b(?:secrets|vars)\s*(?:\.|\[)/u.test(remainder) ||
    protectedExpression
  )
    findings.push(
      finding(
        'CI_PREFLIGHT_SECRET_ACCESS_FORBIDDEN',
        file,
        'only one exact soft-gate env vars.DEVAI_SOFT_GATE_TRUST_JSON public trust read is permitted; every secret/other vars read refuses',
      ),
    );

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
  if (object(jobs.preflight?.env)[PREFLIGHT_BASE_VARIABLE] !== PREFLIGHT_BASE_BINDING)
    findings.push(
      finding(
        'CI_PREFLIGHT_GATE_INVALID',
        file,
        `jobs.preflight.env.${PREFLIGHT_BASE_VARIABLE} must be ${PREFLIGHT_BASE_BINDING}`,
      ),
    );
  const checkout = (Array.isArray(jobs.preflight?.steps) ? jobs.preflight.steps : [])
    .map(object)
    .find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  if (
    object(checkout?.with).ref !== PREFLIGHT_CANDIDATE_REF ||
    String(object(checkout?.with)['fetch-depth']) !== '0'
  )
    findings.push(
      finding(
        'CI_PREFLIGHT_GATE_INVALID',
        file,
        `the checkout must take ref ${PREFLIGHT_CANDIDATE_REF} with fetch-depth: 0`,
      ),
    );
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
      if (uses === SHARED_SETUP_ACTION) {
        // Recognized, pin-validated by checkCompositeActionPins.
      } else if (uses.startsWith('./')) {
        findings.push(
          finding('CI_CANDIDATE_LOCAL_VERIFIER_FORBIDDEN', file, `${location} uses ${uses}`),
        );
      } else if (uses !== '' && !/@[0-9a-f]{40}$/u.test(uses)) {
        findings.push(finding('CI_ACTION_REFERENCE_MUTABLE', file, `${location} uses ${uses}`));
      }
      if (
        uses !== SHARED_SETUP_ACTION &&
        ((uses.startsWith('actions/checkout@') && uses !== `actions/checkout@${pins.checkout}`) ||
          (uses.startsWith('actions/setup-node@') &&
            uses !== `actions/setup-node@${pins.setupNode}`) ||
          (uses.startsWith('pnpm/action-setup@') &&
            uses !== `pnpm/action-setup@${pins.pnpmTagObject}` &&
            uses !== `pnpm/action-setup@${pins.pnpmPeeledCommit}`))
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
        step.id !== PREFLIGHT_STEP_ID &&
        step.id !== 'soft-gate'
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

const SITE_JOB = 'publish-site';
const SITE_MAIN_CONDITION =
  "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' }}";
const SITE_BUILD_LINES = [
  'npm --prefix docs/site ci',
  'npm --prefix docs/site run security:check',
  'npm --prefix docs/site run typecheck',
  'npm --prefix docs/site run build',
  'node scripts/process/verify-pages-bytes.mjs local docs/site/build',
];
const SITE_PUBLISH_COMMAND =
  'node scripts/process/publish-site.mjs docs/site/build site-publication-record';
const SITE_PUBLISH_ENVIRONMENT = {
  GH_TOKEN: '${{ github.token }}',
  PAGES_ARTIFACT_ID: '${{ needs.prepare-site.outputs.artifact_id }}',
  SOURCE_TREE: '${{ needs.prepare-site.outputs.source_tree }}',
  SITE_SHA256: '${{ needs.prepare-site.outputs.site_sha256 }}',
};
// ADR-REL-0034: the deployment step verifies the exact prepared artifact, then publishes it.
const SITE_VERIFY_COMMAND =
  'node scripts/process/verify-site-preparation-artifact.mjs fetch docs/site/build';
const SITE_SOURCE_GUARD_LINES = [
  'test "$GITHUB_REF" = refs/heads/main',
  'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
];
const SITE_LIVE_VERIFY_LINE = 'node scripts/process/verify-pages-bytes.mjs live docs/site/build';

function runLines(step) {
  return String(step.run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * ADR-REL-0029: the site-only Pages lane builds the documentation site from
 * the dispatched main commit and publishes it through the same single-writer
 * journal and concurrency group as the release deploy. It takes no input, reads
 * no secret or variable, and never uses the upstream deploy action.
 */
function checkSiteWorkflow(file, workflow, source, findings) {
  const triggers = object(workflow.on);
  if (
    JSON.stringify(Object.keys(triggers)) !== JSON.stringify(['workflow_dispatch']) ||
    Object.keys(object(triggers.workflow_dispatch)).length !== 0
  ) {
    findings.push(
      finding(
        'SITE_WORKFLOW_TRIGGER_INVALID',
        file,
        'site publication accepts workflow_dispatch only, with no inputs',
      ),
    );
  }
  const permissions = object(workflow.permissions);
  if (Object.keys(permissions).length !== 1 || permissions.contents !== 'read') {
    findings.push(
      finding('CI_WORKFLOW_PERMISSIONS_INVALID', file, 'only contents: read is permitted'),
    );
  }
  const concurrency = object(object(workflow.jobs)['publish-site']?.concurrency);
  if (
    workflow.concurrency !== undefined ||
    Object.keys(concurrency).length !== 2 ||
    concurrency.group !== 'devai-pages-publication' ||
    concurrency['cancel-in-progress'] !== false
  ) {
    findings.push(
      finding(
        'SITE_WORKFLOW_CONCURRENCY_INVALID',
        file,
        'site publication must share group devai-pages-publication with cancel-in-progress: false',
      ),
    );
  }
  const jobs = object(workflow.jobs);
  if (JSON.stringify(Object.keys(jobs)) !== JSON.stringify(['prepare-site', SITE_JOB])) {
    findings.push(
      finding(
        'SITE_WORKFLOW_JOB_SET_INVALID',
        file,
        `exactly prepare-site and ${SITE_JOB} are permitted`,
      ),
    );
  }
  const job = object(jobs[SITE_JOB]);
  const prepare = object(jobs['prepare-site']);
  const preparation = Array.isArray(prepare.steps) ? prepare.steps.map(object) : [];
  const pc = object(prepare.concurrency);
  if (
    prepare.if !== SITE_MAIN_CONDITION ||
    prepare.environment !== undefined ||
    JSON.stringify(prepare.permissions) !== JSON.stringify({ contents: 'read' }) ||
    pc['cancel-in-progress'] !== true ||
    typeof pc.group !== 'string' ||
    !pc.group.includes('github.ref') ||
    pc.group.toLowerCase() === concurrency.group?.toLowerCase() ||
    job.needs !== 'prepare-site'
  )
    findings.push(
      finding(
        'SITE_WORKFLOW_CONCURRENCY_INVALID',
        file,
        'prepare-site must be read-only/main-guarded with separate ref-scoped cancellable lock; publication requires preparation success',
      ),
    );
  if (
    preparation.some((step) =>
      /publish-site|publishPages|deploy-pages|produce-ci-invariant-evidence/u.test(
        String(step.run ?? step.uses ?? ''),
      ),
    ) ||
    (job.steps ?? []).some((step) =>
      /npm[^\n]*(?:ci|build)|pnpm[^\n]*(?:install|build)/u.test(String(step.run ?? '')),
    )
  )
    findings.push(
      finding(
        'SITE_WORKFLOW_BUILD_REQUIRED',
        file,
        'all build work belongs to read-only preparation only',
      ),
    );
  const steps = Array.isArray(job.steps) ? job.steps.map(object) : [];
  // Every job of the lane is main-guarded and binds its own checkout to the dispatched main
  // commit; the guard is not specific to one job. The tree identity is bound once in
  // preparation and carried to publication by the verified artifact custody.
  const identity = preparation.find((step) => step.id === 'source');
  const identityLines = identity === undefined ? [] : runLines(identity);
  const mainGuarded =
    SITE_SOURCE_GUARD_LINES.every((line) => identityLines.includes(line)) &&
    [
      [prepare, preparation],
      [job, steps],
    ].every(([guarded, jobSteps]) => {
      const checkouts = jobSteps.filter(
        (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
      );
      return (
        guarded.if === SITE_MAIN_CONDITION &&
        checkouts.length === 1 &&
        object(checkouts[0].with).ref === '${{ github.sha }}' &&
        object(checkouts[0].with)['persist-credentials'] === false &&
        object(checkouts[0].with).repository === undefined
      );
    });
  if (!mainGuarded) {
    findings.push(
      finding(
        'SITE_WORKFLOW_MAIN_GUARD_MISSING',
        file,
        'prepare-site and publish-site must run only for a main dispatch and bind the checkout to github.sha',
      ),
    );
  }
  const environment = object(job.environment);
  if (
    environment.name !== 'github-pages' ||
    environment.url !== '${{ steps.deployment.outputs.page_url }}' ||
    JSON.stringify(object(job.permissions)) !==
      JSON.stringify({
        contents: 'read',
        pages: 'write',
        deployments: 'write',
        'id-token': 'write',
      })
  ) {
    findings.push(
      finding(
        'SITE_WORKFLOW_ENVIRONMENT_INVALID',
        file,
        'publish-site must use environment github-pages with contents read and pages, deployments, id-token write',
      ),
    );
  }
  const buildStep = preparation.find((step) =>
    runLines(step).includes('npm --prefix docs/site run build'),
  );
  const buildLines = buildStep === undefined ? [] : runLines(buildStep);
  const buildIndexes = SITE_BUILD_LINES.map((line) => buildLines.indexOf(line));
  if (
    buildIndexes.some((index) => index < 0) ||
    buildIndexes.some((index, position) => position > 0 && index <= buildIndexes[position - 1])
  ) {
    findings.push(
      finding(
        'SITE_WORKFLOW_BUILD_REQUIRED',
        file,
        `the site build step must run in order: ${SITE_BUILD_LINES.join('; ')}`,
      ),
    );
  }
  const deployment = steps.filter((step) => step.id === 'deployment');
  const pagesArtifact = preparation.find((step) => step.id === 'pages-artifact');
  const retain = steps.find((step) => step.name === 'Retain site publication identifiers');
  const liveVerify = steps.find((step) => step.name === 'Verify live documentation');
  const deploymentEnvironment = object(deployment[0]?.env);
  if (
    deployment.length !== 1 ||
    JSON.stringify(runLines(deployment[0])) !==
      JSON.stringify(['set -euo pipefail', SITE_VERIFY_COMMAND, SITE_PUBLISH_COMMAND]) ||
    deployment[0].if !== undefined ||
    JSON.stringify(Object.keys(deploymentEnvironment).sort()) !==
      JSON.stringify(Object.keys(SITE_PUBLISH_ENVIRONMENT).sort()) ||
    !Object.entries(SITE_PUBLISH_ENVIRONMENT).every(
      ([key, value]) => deploymentEnvironment[key] === value,
    ) ||
    typeof pagesArtifact?.uses !== 'string' ||
    !pagesArtifact.uses.startsWith('actions/upload-pages-artifact@') ||
    object(pagesArtifact.with).path !== 'docs/site/build' ||
    object(pagesArtifact.with).name !== 'github-pages-${{ github.run_attempt }}' ||
    object(pagesArtifact.with)['retention-days'] !== 30 ||
    retain?.if !== '${{ always() }}' ||
    typeof retain?.uses !== 'string' ||
    !retain.uses.startsWith('actions/upload-artifact@') ||
    object(retain.with).path !== 'site-publication-record/*' ||
    object(retain.with)['retention-days'] !== 30 ||
    liveVerify === undefined ||
    !runLines(liveVerify).includes(SITE_LIVE_VERIFY_LINE) ||
    steps.some(
      (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/deploy-pages@'),
    )
  ) {
    findings.push(
      finding(
        'SITE_WORKFLOW_PUBLISH_STEP_UNBOUND',
        file,
        'site publication requires the journal-bound deployment step, the exact Pages artifact, retained identifiers and live verification',
      ),
    );
  }
  for (const [index, step] of steps.entries()) {
    const uses = typeof step.uses === 'string' ? step.uses : '';
    if (uses === '' || uses === SHARED_SETUP_ACTION) continue;
    if (uses.startsWith('./') || !/@[0-9a-f]{40}$/u.test(uses)) {
      findings.push(
        finding(
          'CI_ACTION_REFERENCE_MUTABLE',
          file,
          `jobs.${SITE_JOB}.steps[${String(index)}] uses ${uses}`,
        ),
      );
    }
  }
  if (/\bsecrets\s*[.[]/u.test(source) || /\bvars\s*\./u.test(source)) {
    findings.push(
      finding(
        'SITE_WORKFLOW_PROTECTED_INPUT_FORBIDDEN',
        file,
        'site publication must not read repository secrets or variables',
      ),
    );
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
  // ADR-REL-0030: jobs that shared an environment are merged, so a rehearsal and a
  // publication each stop exactly twice, and the control commit is summarized by an
  // ungated first job before the first stop.
  const expectedJobs = [
    'build-release',
    'control-commit-summary',
    'deploy-pages',
    'finalize-release',
    'verify-ledger',
  ];
  if (
    JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(expectedJobs) ||
    Object.keys(jobs)[0] !== 'control-commit-summary'
  ) {
    findings.push(finding('RELEASE_JOB_SET_INVALID', file, Object.keys(jobs).join(',')));
  }
  const summary = object(jobs['control-commit-summary']);
  const verify = object(jobs['verify-ledger']);
  const build = object(jobs['build-release']);
  const finalize = object(jobs['finalize-release']);
  const pages = object(jobs['deploy-pages']);
  const summarySteps = Array.isArray(summary.steps) ? summary.steps.map(object) : [];
  const summaryCheckout = object(summarySteps[0]?.with);
  const summaryStep = summarySteps[1];
  if (
    summary.environment !== undefined ||
    summary.if !== undefined ||
    summary.needs !== undefined ||
    JSON.stringify(object(summary.permissions)) !== JSON.stringify({ contents: 'read' }) ||
    summarySteps.length !== 2 ||
    typeof summarySteps[0]?.uses !== 'string' ||
    !summarySteps[0].uses.startsWith('actions/checkout@') ||
    JSON.stringify(summaryCheckout) !==
      JSON.stringify({
        ref: '${{ github.workflow_sha }}',
        'persist-credentials': false,
        'sparse-checkout': 'scripts/process/release-prerequisites.mjs',
        'sparse-checkout-cone-mode': false,
      }) ||
    summaryStep?.uses !== undefined ||
    credentialReferences(summary).size !== 0 ||
    object(summaryStep?.env).CONTROL_COMMIT !== '${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }}' ||
    summaryStep?.run !==
      'set -euo pipefail\nnode scripts/process/release-prerequisites.mjs control-commit'
  ) {
    findings.push(
      finding(
        'RELEASE_CONTROL_COMMIT_SUMMARY_INVALID',
        file,
        'an ungated, read-only, secret-free first job must sparse-check out only the prerequisites script without persisted credentials and summarize the control commit before the first stop',
      ),
    );
  }
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
  // The completion record binds only after Linux adoption of the exact uploaded
  // assets has passed, all inside the one devai-rc-release stop.
  const buildSteps = Array.isArray(build.steps) ? build.steps.map(object) : [];
  const buildOrder = [
    'Upload release candidate assets',
    'Download exact release assets',
    'Exercise fresh npm adoption, execution, and reuse',
    'Check out approved process controls',
    'Bind approved process controls',
    'Record completed rehearsal',
    'Retain rehearsal completion',
  ].map((name) => buildSteps.findIndex((step) => step.name === name));
  const buildDownload = buildSteps[buildOrder[1]];
  if (
    build.if !== rehearsalCondition ||
    build.needs !== 'verify-ledger' ||
    JSON.stringify(object(build.permissions)) !== JSON.stringify({ contents: 'read' }) ||
    buildOrder.some((position, index) => position < 0 || position !== buildOrder[0] + index) ||
    buildSteps[buildOrder[0]]?.id !== 'upload' ||
    object(buildDownload?.with).name !== 'devai-release-assets-${{ github.run_attempt }}' ||
    object(buildDownload?.with).path !== 'release-assets' ||
    !JSON.stringify(buildSteps[buildOrder[5]] ?? {}).includes('steps.upload.outputs.artifact-id') ||
    object(buildSteps[buildOrder[6]]?.with).name !== 'devai-rehearsal-${{ github.run_attempt }}'
  ) {
    findings.push(
      finding(
        'RELEASE_REHEARSAL_JOB_INVALID',
        file,
        'a non-publishing dispatch builds, adopts on Linux, and records completion in one read-only devai-rc-release job',
      ),
    );
  }
  if (
    verify.needs !== 'control-commit-summary' ||
    verify.if !== undefined ||
    JSON.stringify(object(verify.permissions)) !==
      JSON.stringify({ contents: 'read', actions: 'read' }) ||
    finalize.needs !== 'verify-ledger' ||
    JSON.stringify(pages.needs) !== JSON.stringify(['finalize-release', 'verify-ledger'])
  ) {
    findings.push(
      finding(
        'RELEASE_JOB_GRAPH_INVALID',
        file,
        'verify-ledger needs control-commit-summary; build-release and finalize-release need verify-ledger; deploy-pages needs finalize-release and verify-ledger',
      ),
    );
  }

  const verifySteps = Array.isArray(verify.steps) ? verify.steps.map(object) : [];
  const verifyNames = verifySteps.map((step) => step.name);
  const promotionVerify = verifySteps.find((step) => step.name === 'Verify selected rehearsal');
  const promotionRetain = verifySteps.find(
    (step) => step.name === 'Retain verified promotion assets',
  );
  const finalizeSteps = Array.isArray(finalize.steps) ? finalize.steps : [];
  const finalizeAssets = finalizeSteps.find(
    (step) => step.name === 'Download exact release assets',
  );
  if (
    build.if !== rehearsalCondition ||
    promotionVerify?.if !== publishCondition ||
    promotionRetain?.if !== publishCondition ||
    promotionRetain?.id !== 'retain' ||
    verifyNames.indexOf('Verify selected rehearsal') <=
      verifyNames.indexOf('Bind and verify exact release evidence') ||
    verifyNames.indexOf('Retain verified promotion assets') !==
      verifyNames.indexOf('Verify selected rehearsal') + 1 ||
    object(promotionRetain?.with).name !== 'devai-release-assets-${{ github.run_attempt }}' ||
    object(promotionRetain?.with).path !== 'release-assets/*' ||
    object(verify.outputs).release_asset_id !== '${{ steps.retain.outputs.artifact-id }}' ||
    verifySteps
      .filter((step) => credentialReferences(step).has('GITHUB_TOKEN'))
      .some((step) => step !== promotionVerify) ||
    finalizeAssets?.with?.['artifact-ids'] !==
      '${{ needs.verify-ledger.outputs.release_asset_id }}' ||
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
  for (const name of ['verify-ledger', 'finalize-release', 'deploy-pages']) {
    const body = JSON.stringify(jobs[name]);
    if (/pnpm (?:run )?build|stage-release-package|double-pack|npm (?:run )?build/u.test(body))
      findings.push(finding('RELEASE_PROMOTION_REBUILD_FORBIDDEN', file, name));
  }
  for (const name of ['verify-ledger', 'build-release', 'finalize-release', 'deploy-pages']) {
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
    pagesAssets?.with?.['artifact-ids'] !== '${{ needs.verify-ledger.outputs.release_asset_id }}' ||
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
    if (uses === '' || uses === SHARED_SETUP_ACTION) continue;
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
    'Exercise fresh npm adoption, execution, and reuse',
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
  const pnpmStep = steps.find(({ step }) => {
    if (typeof step.uses !== 'string') return false;
    if (step.uses.startsWith('pnpm/action-setup@')) return true;
    // TASK-0254: pnpm setup may instead be delegated to the shared composite,
    // which runs pnpm/action-setup internally when setup-pnpm is enabled;
    // checkCompositeActionPins validates that internal step's own pin.
    return step.uses === SHARED_SETUP_ACTION && object(step.with)['setup-pnpm'] === 'true';
  });
  if (pnpmStep === undefined) {
    findings.push(finding('RELEASE_PNPM_SETUP_MISSING', file, pins.pnpmTagObject));
  } else if (
    pnpmStep.step.uses.startsWith('pnpm/action-setup@') &&
    object(pnpmStep.step.with).version !== undefined
  ) {
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
