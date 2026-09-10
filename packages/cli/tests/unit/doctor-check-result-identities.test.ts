// Invariants: INV-DEVAI-001, INV-DEVAI-015, INV-DEVAI-017
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CAC } from 'cac';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MATERIALIZED_POLICY_FILES,
  resolveCanonicalPolicyContent,
} from '../../../skills/src/bootstrap/index.js';
import { initChain } from '../../../evidence/src/evidence/chain.js';
import { withAuthorityHostTestScope } from '../../../skills/tests/unit/authority-host-test-scope.js';
import { runWithAuthorityPolicyMaterialization } from '../../src/authority/command-capabilities.js';
import { doctor } from '../../src/commands/doctor.js';
import { initBind } from '../../src/commands/init/index.js';

const { cac } = createRequire(import.meta.url)('../../node_modules/cac/index-compat.js') as {
  cac: (name?: string) => CAC;
};

const SOURCE = 'law/policy/devai-adoption.json';
const BINDING = '.devai/config/adopter-policy-binding.json';
const CONFIG = '.devai/config';
const roots: string[] = [];

type JsonObject = Record<string, unknown>;

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly advisory?: boolean;
  readonly info?: JsonObject;
  readonly errors?: readonly string[];
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'devai-doctor-identities-'));
  roots.push(value);
  return value;
}

function put(repo: string, path: string, value: unknown): void {
  const absolute = join(repo, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function readJson(repo: string, path: string): JsonObject {
  return JSON.parse(readFileSync(join(repo, path), 'utf8')) as JsonObject;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalized<T>(value: T, repo: string): T {
  return JSON.parse(JSON.stringify(value).split(repo).join('<repo>')) as T;
}

async function invoke(definition: { register(cli: CAC): void }, argv: readonly string[]) {
  const cli = cac('devai-doctor-check-identities');
  definition.register(cli);
  const previous = {
    argv: process.argv,
    exit: process.exit,
    exitCode: process.exitCode,
    stdout: process.stdout.write,
    stderr: process.stderr.write,
  };
  let stdout = '';
  let stderr = '';
  try {
    process.argv = ['node', 'devai', ...argv];
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      process.exitCode = typeof code === 'number' ? code : 0;
      throw new Error(`TEST_PROCESS_EXIT:${String(process.exitCode)}`);
    }) as typeof process.exit;
    cli.parse(process.argv, { run: false });
    try {
      await withAuthorityHostTestScope(() =>
        runWithAuthorityPolicyMaterialization(
          () => ({
            path: '.devai/config/authority-policy.json',
            operation: 'unchanged',
            digest_sha256: 'a'.repeat(64),
          }),
          () => cli.runMatchedCommand(),
        ),
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('TEST_PROCESS_EXIT:')) throw error;
    }
    await new Promise<void>((done) => setImmediate(done));
    return { exit: process.exitCode ?? 0, stdout, stderr };
  } finally {
    process.argv = previous.argv;
    process.exit = previous.exit;
    process.exitCode = previous.exitCode;
    process.stdout.write = previous.stdout;
    process.stderr.write = previous.stderr;
  }
}

async function doctorCheck(repo: string, name: string, chain?: string): Promise<CheckResult> {
  const argv = ['doctor', '--repo-root', repo, '--skip', 'docs-governance'];
  if (chain !== undefined) argv.push('--chain', chain);
  const result = await invoke(doctor, argv);
  expect(result.stderr).toBe('');
  const report = JSON.parse(result.stdout) as { checks: CheckResult[] };
  const check = report.checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`missing doctor check: ${name}`);
  return check;
}

async function canonicalRepo(): Promise<string> {
  const repo = root();
  put(repo, `${CONFIG}/project.json`, {
    schemaVersion: '1.0.0',
    project_type: 'runtime-host',
    profile: 'tier1',
    devai_version: '1.5.0',
  });
  for (const file of MATERIALIZED_POLICY_FILES) {
    put(repo, `${CONFIG}/${file}`, resolveCanonicalPolicyContent(file));
  }
  return repo;
}

function defaultPolicy(): JsonObject {
  return {
    schemaVersion: '1.0.0',
    policy_id: 'fixture.devai-adoption',
    policy_version: '1.0.0',
    domains: { client: ['COVERAGE', 'ERROR', 'FLOW', 'PRIVACY', 'RBAC'] },
    thresholds: { coverage: { lines: 91 }, mutation: { score_min: 88 } },
    scorecard_na: {
      schemaVersion: '1.0.0',
      cells: [
        {
          cell: 'F4:T5',
          reason: 'Fixture inventory has no idiomaticity surface.',
          constitution_anchor: 'Article 5',
        },
      ],
    },
    glob_guards: {
      schemaVersion: '1.0.0',
      guards: [
        {
          id: 'CLIENT_ROUTES',
          pattern: 'src/**/*.ts',
          min_matches: 2,
          description: 'Client routing files remain covered.',
          source: '.github/workflows/ci.yml',
        },
      ],
    },
    project: { project_type: 'runtime-host', repo: { kind: 'application' } },
  };
}

async function boundRepo(): Promise<string> {
  const repo = await canonicalRepo();
  put(repo, SOURCE, defaultPolicy());
  const result = await invoke(initBind, [
    'init-bind',
    '--target',
    repo,
    '--adopter-policy',
    SOURCE,
    '--write',
  ]);
  expect(result.exit, result.stderr).toBe(0);
  return repo;
}

async function policyIdentity(repo: string): Promise<CheckResult> {
  return normalized(await doctorCheck(repo, 'policy-materialization-current'), repo);
}

describe('Doctor whole CheckResult identities', () => {
  it('freezes absent, malformed-override, and complete F1 path identities', async () => {
    const absent = root();
    const malformed = root();
    put(malformed, `${CONFIG}/project.json`, '{broken-json\n');

    const complete = root();
    put(complete, `${CONFIG}/project.json`, {
      docs: { ia: { path_overrides: { ct: 'rogue-product', 'dev/operations': 'runbooks' } } },
    });
    for (const path of [
      'product',
      'law/invariants',
      'law/schemas',
      'law/adr',
      'docs/runbooks',
      'docs/dev/security',
      'law/glossary',
    ]) {
      mkdirSync(join(complete, path), { recursive: true });
    }

    expect({
      absent: await doctorCheck(absent, 'f1-paths-present'),
      malformed: await doctorCheck(malformed, 'f1-paths-present'),
      complete: await doctorCheck(complete, 'f1-paths-present'),
    }).toMatchInlineSnapshot(`
      {
        "absent": {
          "errors": [
            "missing F1 path: product",
            "missing F1 path: law/invariants",
            "missing F1 path: law/schemas",
            "missing F1 path: law/adr",
            "missing F1 path: docs/dev/operations",
            "missing F1 path: docs/dev/security",
            "missing F1 path: law/glossary",
          ],
          "info": {
            "missing": [
              "product",
              "law/invariants",
              "law/schemas",
              "law/adr",
              "docs/dev/operations",
              "docs/dev/security",
              "law/glossary",
            ],
            "paths": [
              "product",
              "law/invariants",
              "law/schemas",
              "law/adr",
              "docs/dev/operations",
              "docs/dev/security",
              "law/glossary",
            ],
          },
          "name": "f1-paths-present",
          "ok": false,
        },
        "complete": {
          "info": {
            "missing": [],
            "path_overrides": {
              "ct": "rogue-product",
              "dev/operations": "runbooks",
            },
            "paths": [
              "product",
              "law/invariants",
              "law/schemas",
              "law/adr",
              "docs/runbooks",
              "docs/dev/security",
              "law/glossary",
            ],
          },
          "name": "f1-paths-present",
          "ok": true,
        },
        "malformed": {
          "errors": [
            "missing F1 path: product",
            "missing F1 path: law/invariants",
            "missing F1 path: law/schemas",
            "missing F1 path: law/adr",
            "missing F1 path: docs/dev/operations",
            "missing F1 path: docs/dev/security",
            "missing F1 path: law/glossary",
          ],
          "info": {
            "missing": [
              "product",
              "law/invariants",
              "law/schemas",
              "law/adr",
              "docs/dev/operations",
              "docs/dev/security",
              "law/glossary",
            ],
            "paths": [
              "product",
              "law/invariants",
              "law/schemas",
              "law/adr",
              "docs/dev/operations",
              "docs/dev/security",
              "law/glossary",
            ],
          },
          "name": "f1-paths-present",
          "ok": false,
        },
      }
    `);
  });

  it('freezes complete, missing, and mismatched canonical materialization identities', async () => {
    const complete = await canonicalRepo();
    const missing = root();
    const mismatch = await canonicalRepo();
    put(mismatch, `${CONFIG}/domains.json`, '{}\n');

    expect({
      complete: normalized(await doctorCheck(complete, 'policy-materialization-current'), complete),
      missing: normalized(await doctorCheck(missing, 'policy-materialization-current'), missing),
      mismatch: normalized(await doctorCheck(mismatch, 'policy-materialization-current'), mismatch),
    }).toMatchInlineSnapshot(`
      {
        "complete": {
          "info": {
            "mismatches": [],
            "remediation_commands": [
              "devai init bind --target . --operational-law --as-role architect --write",
              "devai init bind --target . --subprocess-effects --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": true,
        },
        "mismatch": {
          "errors": [
            "materialized policy differs from installed policy: domains.json",
            "rebind with: devai init bind --target . --operational-law --as-role architect --write",
            "rebind with: devai init bind --target . --subprocess-effects --as-role architect --write",
          ],
          "info": {
            "mismatches": [
              {
                "actual_sha256": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
                "file": "domains.json",
                "installed_sha256": "9539eb0e6679d423fa83b98726136eb369202edb042fce68eae92b19f543f6fd",
                "target": "<repo>/.devai/config/domains.json",
              },
            ],
            "remediation_commands": [
              "devai init bind --target . --operational-law --as-role architect --write",
              "devai init bind --target . --subprocess-effects --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "missing": {
          "errors": [
            "materialized policy differs from installed policy: domains.json",
            "materialized policy differs from installed policy: forbidden-actions.json",
            "materialized policy differs from installed policy: glob-guards.json",
            "materialized policy differs from installed policy: scorecard-na.json",
            "materialized policy differs from installed policy: thresholds.json",
            "materialized policy differs from installed policy: subprocess-effects.json",
            "rebind with: devai init bind --target . --operational-law --as-role architect --write",
            "rebind with: devai init bind --target . --subprocess-effects --as-role architect --write",
          ],
          "info": {
            "mismatches": [
              {
                "actual_sha256": "missing",
                "file": "domains.json",
                "installed_sha256": "9539eb0e6679d423fa83b98726136eb369202edb042fce68eae92b19f543f6fd",
                "target": "<repo>/.devai/config/domains.json",
              },
              {
                "actual_sha256": "missing",
                "file": "forbidden-actions.json",
                "installed_sha256": "f4691c88c7ad74c27e6100ad0c958d79d3112853964d2ff362e7b4ccb495cf74",
                "target": "<repo>/.devai/config/forbidden-actions.json",
              },
              {
                "actual_sha256": "missing",
                "file": "glob-guards.json",
                "installed_sha256": "759bf9dd020fff02a75cdc184780c04e4883bde6a82e16290ce7f0b8ab70d4bd",
                "target": "<repo>/.devai/config/glob-guards.json",
              },
              {
                "actual_sha256": "missing",
                "file": "scorecard-na.json",
                "installed_sha256": "811858d9a230f84ef027b3281fd97d6dbeb2e819f0c4169585ce13080dc94460",
                "target": "<repo>/.devai/config/scorecard-na.json",
              },
              {
                "actual_sha256": "missing",
                "file": "thresholds.json",
                "installed_sha256": "19bff20b5d9531d15a30227fb958ea34be660d88655ef46e45888f1fc1559751",
                "target": "<repo>/.devai/config/thresholds.json",
              },
              {
                "actual_sha256": "missing",
                "file": "subprocess-effects.json",
                "installed_sha256": "a19c52e9f293f55763f7ff344c785a36f0ab9355c54e7fb0f0abb365643e4ef0",
                "target": "<repo>/.devai/config/subprocess-effects.json",
              },
            ],
            "remediation_commands": [
              "devai init bind --target . --operational-law --as-role architect --write",
              "devai init bind --target . --subprocess-effects --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
      }
    `);
  });

  it('freezes valid, malformed, unsupported, and symlink binding identities', async () => {
    const valid = await boundRepo();

    const malformed = await boundRepo();
    put(malformed, BINDING, '{broken-json\n');

    const unsupported = await boundRepo();
    put(unsupported, BINDING, { ...readJson(unsupported, BINDING), schemaVersion: '2.0.0' });

    const linked = await boundRepo();
    put(linked, 'binding-copy.json', readFileSync(join(linked, BINDING)));
    rmSync(join(linked, BINDING));
    symlinkSync('../../binding-copy.json', join(linked, BINDING));

    expect({
      valid: await policyIdentity(valid),
      malformed: await policyIdentity(malformed),
      unsupported: await policyIdentity(unsupported),
      linked: await policyIdentity(linked),
    }).toMatchInlineSnapshot(`
      {
        "linked": {
          "errors": [
            "adopter-policy binding cannot be read",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "BINDING_MALFORMED",
            ],
            "remediation_commands": [],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "malformed": {
          "errors": [
            "adopter-policy binding rejected: BINDING_MALFORMED",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "BINDING_MALFORMED",
            ],
            "remediation_commands": [],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "unsupported": {
          "errors": [
            "adopter-policy binding rejected: BINDING_VERSION_UNSUPPORTED",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "BINDING_VERSION_UNSUPPORTED",
            ],
            "remediation_commands": [],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "valid": {
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": true,
        },
      }
    `);
  });

  it('freezes source confinement, availability, digest, schema, and identity failures', async () => {
    const absolute = await boundRepo();
    const absoluteReceipt = readJson(absolute, BINDING);
    absoluteReceipt['source_path'] = join(absolute, SOURCE);
    put(absolute, BINDING, absoluteReceipt);

    const noncanonical = await boundRepo();
    const noncanonicalReceipt = readJson(noncanonical, BINDING);
    noncanonicalReceipt['source_path'] = 'law/policy/sub/../devai-adoption.json';
    put(noncanonical, BINDING, noncanonicalReceipt);

    const missing = await boundRepo();
    rmSync(join(missing, SOURCE));

    const directory = await boundRepo();
    rmSync(join(directory, SOURCE));
    mkdirSync(join(directory, SOURCE));

    const digest = await boundRepo();
    writeFileSync(join(digest, SOURCE), `${readFileSync(join(digest, SOURCE), 'utf8')} \n`);

    const invalid = await boundRepo();
    put(invalid, SOURCE, '{broken-json\n');
    const invalidReceipt = readJson(invalid, BINDING);
    invalidReceipt['source_digest_sha256'] = sha256(readFileSync(join(invalid, SOURCE)));
    put(invalid, BINDING, invalidReceipt);

    const identity = await boundRepo();
    put(identity, SOURCE, { ...defaultPolicy(), policy_version: '1.0.1' });
    const identityReceipt = readJson(identity, BINDING);
    identityReceipt['source_digest_sha256'] = sha256(readFileSync(join(identity, SOURCE)));
    put(identity, BINDING, identityReceipt);

    expect({
      absolute: await policyIdentity(absolute),
      noncanonical: await policyIdentity(noncanonical),
      missing: await policyIdentity(missing),
      directory: await policyIdentity(directory),
      digest: await policyIdentity(digest),
      invalid: await policyIdentity(invalid),
      identity: await policyIdentity(identity),
    }).toMatchInlineSnapshot(`
      {
        "absolute": {
          "errors": [
            "adopter-policy binding source must be a file beneath law/policy",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_PATH_OUTSIDE_LAW_POLICY",
            ],
            "remediation_commands": [],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "digest": {
          "errors": [
            "adopter-policy source digest differs: law/policy/devai-adoption.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_DIGEST_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "directory": {
          "errors": [
            "adopter-policy source is not a regular file: law/policy/devai-adoption.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_POLICY_INVALID",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "identity": {
          "errors": [
            "adopter-policy source identity differs from the binding receipt",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "POLICY_IDENTITY_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "invalid": {
          "errors": [
            "adopter-policy source is invalid: law/policy/devai-adoption.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_POLICY_INVALID",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "missing": {
          "errors": [
            "adopter-policy source is missing: law/policy/devai-adoption.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_MISSING",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "noncanonical": {
          "errors": [
            "adopter-policy binding source must be a file beneath law/policy",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_PATH_OUTSIDE_LAW_POLICY",
            ],
            "remediation_commands": [],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
      }
    `);
  });

  it('freezes resolved source escapes through the law directory boundaries', async () => {
    const same = await boundRepo();
    rmSync(join(same, SOURCE));
    symlinkSync('.', join(same, SOURCE));

    const parent = await boundRepo();
    rmSync(join(parent, SOURCE));
    symlinkSync('..', join(parent, SOURCE));

    const outside = await boundRepo();
    put(outside, 'outside-policy.json', defaultPolicy());
    rmSync(join(outside, SOURCE));
    symlinkSync('../../outside-policy.json', join(outside, SOURCE));

    expect({
      same: await policyIdentity(same),
      parent: await policyIdentity(parent),
      outside: await policyIdentity(outside),
    }).toMatchInlineSnapshot(`
      {
        "outside": {
          "errors": [
            "adopter-policy binding source resolves outside law/policy",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_PATH_OUTSIDE_LAW_POLICY",
            ],
            "remediation_commands": [],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "parent": {
          "errors": [
            "adopter-policy binding source resolves outside law/policy",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_PATH_OUTSIDE_LAW_POLICY",
            ],
            "remediation_commands": [],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "same": {
          "errors": [
            "adopter-policy binding source resolves outside law/policy",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_PATH_OUTSIDE_LAW_POLICY",
            ],
            "remediation_commands": [],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
      }
    `);
  });

  it('freezes project and materialization failure identities', async () => {
    const missingProject = await boundRepo();
    rmSync(join(missingProject, `${CONFIG}/project.json`));

    const malformedProject = await boundRepo();
    put(malformedProject, `${CONFIG}/project.json`, '{broken-json\n');

    const collision = await boundRepo();
    put(collision, SOURCE, {
      ...defaultPolicy(),
      domains: { client: ['AUTH'] },
    });
    const collisionReceipt = readJson(collision, BINDING);
    collisionReceipt['source_digest_sha256'] = sha256(readFileSync(join(collision, SOURCE)));
    put(collision, BINDING, collisionReceipt);

    const missingCollision = await boundRepo();
    put(missingCollision, SOURCE, {
      ...defaultPolicy(),
      domains: { client: ['AUTH'] },
    });
    const missingCollisionReceipt = readJson(missingCollision, BINDING);
    missingCollisionReceipt['source_digest_sha256'] = sha256(
      readFileSync(join(missingCollision, SOURCE)),
    );
    put(missingCollision, BINDING, missingCollisionReceipt);
    rmSync(join(missingCollision, `${CONFIG}/project.json`));

    expect({
      missingProject: await policyIdentity(missingProject),
      malformedProject: await policyIdentity(malformedProject),
      collision: await policyIdentity(collision),
      missingCollision: await policyIdentity(missingCollision),
    }).toMatchInlineSnapshot(`
      {
        "collision": {
          "errors": [
            "adopter-policy source cannot be materialized: law/policy/devai-adoption.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "SOURCE_POLICY_INVALID",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "malformedProject": {
          "errors": [
            "materialized target is invalid: .devai/config/project.json",
            "bound DEVAI version missing differs from installed DEVAI version 1.5.0",
            "adopter-policy source cannot be materialized: law/policy/devai-adoption.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "TARGET_BYTES_MISMATCH",
              "FRAMEWORK_VERSION_MISMATCH",
              "SOURCE_POLICY_INVALID",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "missingCollision": {
          "errors": [
            "materialized target is missing: .devai/config/project.json",
            "bound DEVAI version missing differs from installed DEVAI version 1.5.0",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [
              {
                "actual_sha256": "missing",
                "expected_sha256": "unknown",
                "file": ".devai/config/project.json",
              },
            ],
            "reason_ids": [
              "TARGET_MISSING",
              "FRAMEWORK_VERSION_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "missingProject": {
          "errors": [
            "materialized target is missing: .devai/config/project.json",
            "bound DEVAI version missing differs from installed DEVAI version 1.5.0",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [
              {
                "actual_sha256": "missing",
                "expected_sha256": "unknown",
                "file": ".devai/config/project.json",
              },
            ],
            "reason_ids": [
              "TARGET_MISSING",
              "FRAMEWORK_VERSION_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
      }
    `);
  });

  it('freezes receipt-set, receipt-hash, missing-target, and target-byte failures', async () => {
    const targetSet = await boundRepo();
    const targetSetReceipt = readJson(targetSet, BINDING);
    targetSetReceipt['materialized'] = Object.fromEntries(
      Object.entries(targetSetReceipt['materialized'] as JsonObject).filter(
        ([path]) => path !== `${CONFIG}/scorecard-na.json`,
      ),
    );
    put(targetSet, BINDING, targetSetReceipt);

    const receiptHash = await boundRepo();
    const receiptHashReceipt = readJson(receiptHash, BINDING);
    (receiptHashReceipt['materialized'] as JsonObject)[`${CONFIG}/domains.json`] = '0'.repeat(64);
    put(receiptHash, BINDING, receiptHashReceipt);

    const missingTarget = await boundRepo();
    rmSync(join(missingTarget, `${CONFIG}/glob-guards.json`));

    const directoryTarget = await boundRepo();
    rmSync(join(directoryTarget, `${CONFIG}/thresholds.json`));
    mkdirSync(join(directoryTarget, `${CONFIG}/thresholds.json`));

    const bytes = await boundRepo();
    put(bytes, `${CONFIG}/domains.json`, '{}\n');

    expect({
      targetSet: await policyIdentity(targetSet),
      receiptHash: await policyIdentity(receiptHash),
      missingTarget: await policyIdentity(missingTarget),
      directoryTarget: await policyIdentity(directoryTarget),
      bytes: await policyIdentity(bytes),
    }).toMatchInlineSnapshot(`
      {
        "bytes": {
          "errors": [
            "materialized target differs: .devai/config/domains.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [
              {
                "actual_sha256": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
                "expected_sha256": "a1df7ff4ea537f5be17cd850fcee467aaef5aca1a60b0fa5b86010701d331f1e",
                "file": ".devai/config/domains.json",
              },
            ],
            "reason_ids": [
              "TARGET_BYTES_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "directoryTarget": {
          "errors": [
            "materialized target is not a regular file: .devai/config/thresholds.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [
              {
                "actual_sha256": "unreadable",
                "expected_sha256": "b6bc2ce7d893d7d66ba5f23d4d8272fa7bb0f12d2b768619fee8133cc3ba3b3e",
                "file": ".devai/config/thresholds.json",
              },
            ],
            "reason_ids": [
              "TARGET_BYTES_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "missingTarget": {
          "errors": [
            "materialized target is missing: .devai/config/glob-guards.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [
              {
                "actual_sha256": "missing",
                "expected_sha256": "73e53f211e4b3281a19bc42451f5e2f5f9b4929d492d18ef72c56871a37464d7",
                "file": ".devai/config/glob-guards.json",
              },
            ],
            "reason_ids": [
              "TARGET_MISSING",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "receiptHash": {
          "errors": [
            "binding receipt hash differs from recomputed materialization: .devai/config/domains.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "RECEIPT_HASH_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "targetSet": {
          "errors": [
            "adopter-policy binding must contain the exact policy-selected materialized target set",
            "binding receipt hash differs from recomputed materialization: .devai/config/scorecard-na.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "TARGET_SET_MISMATCH",
              "RECEIPT_HASH_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
      }
    `);
  });

  it('freezes canonical policy target failures while an adopter binding is present', async () => {
    const missing = await boundRepo();
    rmSync(join(missing, `${CONFIG}/forbidden-actions.json`));

    const mismatch = await boundRepo();
    put(mismatch, `${CONFIG}/subprocess-effects.json`, '{}\n');

    expect({
      missing: await policyIdentity(missing),
      mismatch: await policyIdentity(mismatch),
    }).toMatchInlineSnapshot(`
      {
        "mismatch": {
          "errors": [
            "materialized target differs: .devai/config/subprocess-effects.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [
              {
                "actual_sha256": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
                "expected_sha256": "a19c52e9f293f55763f7ff344c785a36f0ab9355c54e7fb0f0abb365643e4ef0",
                "file": ".devai/config/subprocess-effects.json",
              },
            ],
            "reason_ids": [
              "TARGET_BYTES_MISMATCH",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
        "missing": {
          "errors": [
            "materialized target is missing: .devai/config/forbidden-actions.json",
          ],
          "info": {
            "binding": ".devai/config/adopter-policy-binding.json",
            "mismatches": [],
            "reason_ids": [
              "TARGET_MISSING",
            ],
            "remediation_commands": [
              "devai init bind --target . --adopter-policy law/policy/devai-adoption.json --as-role architect --write",
            ],
          },
          "name": "policy-materialization-current",
          "ok": false,
        },
      }
    `);
  });

  it('freezes missing, valid, and malformed evidence-chain identities', async () => {
    const repo = root();
    const missing = join(repo, 'missing-chain.json');
    const valid = join(repo, 'valid-chain.json');
    const malformed = join(repo, 'malformed-chain.json');
    await withAuthorityHostTestScope(() => initChain(valid));
    put(repo, 'malformed-chain.json', '{broken-json\n');

    expect({
      missing: normalized(await doctorCheck(repo, 'evidence-chain-valid', missing), repo),
      valid: normalized(await doctorCheck(repo, 'evidence-chain-valid', valid), repo),
      malformed: normalized(await doctorCheck(repo, 'evidence-chain-valid', malformed), repo),
    }).toMatchInlineSnapshot(`
      {
        "malformed": {
          "errors": [
            "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
          ],
          "name": "evidence-chain-valid",
          "ok": false,
        },
        "missing": {
          "errors": [
            "chain file missing: <repo>/missing-chain.json",
          ],
          "name": "evidence-chain-valid",
          "ok": false,
        },
        "valid": {
          "info": {
            "chain": "<repo>/valid-chain.json",
          },
          "name": "evidence-chain-valid",
          "ok": true,
        },
      }
    `);
  });
});
