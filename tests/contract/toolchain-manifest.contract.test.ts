// ADR-CHK-0002: one adopter-owned manifest declares toolchain identity, and
// every consumer (workflow checker, provisioning script, check-runner digest)
// must agree with it instead of restating versions inline. This contract pins
// the manifest itself: it validates against its schema, and the constants
// scripts/check-workflows.mjs still hardcodes today must equal the manifest's
// values, with the manifest as the source of truth.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_COMMIT,
  CONFIGURE_PAGES_COMMIT,
  DEPLOY_PAGES_COMMIT,
  DOWNLOAD_ARTIFACT_COMMIT,
  LEDGER_ENVIRONMENT,
  PNPM_SETUP_PEELED_COMMIT,
  PNPM_SETUP_TAG_OBJECT,
  SETUP_NODE_COMMIT,
  UPLOAD_ARTIFACT_COMMIT,
  UPLOAD_PAGES_COMMIT,
  VERIFIER_PACKAGE,
} from '../../scripts/check-workflows.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const SCHEMA_PATH = resolve(ROOT, 'law/schemas/toolchain-manifest.schema.json');
const MANIFEST_PATH = resolve(ROOT, '.devai/config/toolchain.json');
const WORKFLOWS_DIR = resolve(ROOT, '.github/workflows');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  runtimes: { node: string; pnpm: string; git: string };
  actions: Record<string, { ref: string; digest: string; peeled_commit?: string }>;
  verifier: { package: string; version: string; policy: string };
  constants: { expected_action_count?: number; ledger_environment?: string };
};

it('validates the committed manifest against law/schemas/toolchain-manifest.schema.json', () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(manifest);
  expect(validate.errors ?? []).toEqual([]);
  expect(valid).toBe(true);
});

describe('every pin constant scripts/check-workflows.mjs exports equals the manifest value', () => {
  // The manifest is the source of truth (ADR-CHK-0002): a divergence here
  // means the exported constant is stale, not the manifest.
  it.each([
    ['actions/checkout digest', CHECKOUT_COMMIT, manifest.actions['actions/checkout']?.digest],
    [
      'actions/setup-node digest',
      SETUP_NODE_COMMIT,
      manifest.actions['actions/setup-node']?.digest,
    ],
    [
      'pnpm/action-setup tag object digest',
      PNPM_SETUP_TAG_OBJECT,
      manifest.actions['pnpm/action-setup']?.digest,
    ],
    [
      'pnpm/action-setup peeled commit',
      PNPM_SETUP_PEELED_COMMIT,
      manifest.actions['pnpm/action-setup']?.peeled_commit,
    ],
    [
      'actions/upload-artifact digest',
      UPLOAD_ARTIFACT_COMMIT,
      manifest.actions['actions/upload-artifact']?.digest,
    ],
    [
      'actions/download-artifact digest',
      DOWNLOAD_ARTIFACT_COMMIT,
      manifest.actions['actions/download-artifact']?.digest,
    ],
    [
      'actions/configure-pages digest',
      CONFIGURE_PAGES_COMMIT,
      manifest.actions['actions/configure-pages']?.digest,
    ],
    [
      'actions/upload-pages-artifact digest',
      UPLOAD_PAGES_COMMIT,
      manifest.actions['actions/upload-pages-artifact']?.digest,
    ],
    [
      'actions/deploy-pages digest',
      DEPLOY_PAGES_COMMIT,
      manifest.actions['actions/deploy-pages']?.digest,
    ],
    ['verifier package name', VERIFIER_PACKAGE, manifest.verifier?.package],
    ['ledger environment', LEDGER_ENVIRONMENT, manifest.constants?.ledger_environment],
  ])('%s', (_label, constant, manifestValue) => {
    expect(manifestValue).toBeDefined();
    expect(constant).toBe(manifestValue);
  });
});

it('matches every node-version pinned in .github/workflows/*.yml to the manifest node major', () => {
  const requiredMajor = manifest.runtimes.node.split('.')[0];
  const files = readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/u.test(name));
  expect(files.length).toBeGreaterThan(0);
  const observed: Array<{ file: string; major: string }> = [];
  for (const file of files) {
    const source = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf8');
    for (const match of source.matchAll(/node-version:\s*['"]?([0-9]+)/gu)) {
      observed.push({ file, major: match[1] });
    }
  }
  expect(observed.length).toBeGreaterThan(0);
  for (const entry of observed) {
    expect(entry).toEqual({ file: entry.file, major: requiredMajor });
  }
});
