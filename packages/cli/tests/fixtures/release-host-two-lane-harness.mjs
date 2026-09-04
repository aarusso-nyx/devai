// Executed only inside the instrumented test bundle; not production-package evidence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalSha256 } from '@devai-nyx/utils';
import { installedPackage, fixture, build } from '../helpers/release-mutation-inputs-fixture.js';
import { providerFixture, cleanupFixtures } from '../helpers/release-toolchain-provider-fixture.js';
import { bindReleaseHostPackageSnapshot } from '../../src/services/release-host-package-binding.js';
import { createProtectedReleaseHostRunner } from '../../src/services/release-protected-host-runner.js';
import { extraAssets, observations } from 'test-host-runtime-state';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'devai two lane host ç-')));
const git = (root, args, input) => {
  const result = spawnSync('git', ['-C', root, ...args], { input });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
function checkout(snapshot, root) {
  mkdirSync(root);
  git(root, ['init', '-q']);
  for (const [id, object] of snapshot.readProof(snapshot.paths))
    assert.equal(
      git(root, ['hash-object', '-w', '--literally', '-t', object.type, '--stdin'], object.bytes),
      id,
    );
  git(root, ['checkout', '--detach', snapshot.repository.commit]);
  git(root, ['remote', 'add', 'origin', `https://github.com/${snapshot.repository.id}.git`]);
}
function document(name, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const path = join(parent, name);
  writeFileSync(path, bytes);
  return { path, sha256: hash(bytes) };
}

try {
  const installed = installedPackage(
    extraAssets.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes, 'base64') })),
  );
  bindReleaseHostPackageSnapshot(installed);
  const base = fixture(installed);
  for (const [path, bytes] of base.files) {
    if (path.endsWith('package.json')) {
      const manifest = JSON.parse(Buffer.from(bytes).toString());
      base.files.set(path, Buffer.from(JSON.stringify({ ...manifest, version: '1.5.0' })));
    }
  }
  const production = build(base);
  const diagnostic = providerFixture({ installed, resolution: production.resolution });
  const productionRoot = join(parent, 'production');
  checkout(production.snapshot, productionRoot);
  const fixtureRoot = diagnostic.options.repository_root;
  git(fixtureRoot, [
    'remote',
    'add',
    'origin',
    `https://github.com/${diagnostic.value.candidate.repository.id}.git`,
  ]);
  const roots = [productionRoot, fixtureRoot];
  const evidenceRoot = join(parent, 'evidence');
  const artifactRoot = join(parent, 'artifacts');
  mkdirSync(evidenceRoot, { mode: 0o700 });
  mkdirSync(artifactRoot, { mode: 0o700 });
  const identity = (snapshot) => ({
    authority_repository_id: snapshot.repository.id.split('/')[1],
    read_expected_release_repository_id: () => snapshot.repository.id,
  });
  const expected = (snapshot, release_unit) => ({
    repository: snapshot.repository,
    installed_package: installed.identity,
    installation_origin: 'candidate-adopter-dependency',
    release_unit,
  });
  const execution = {
    controls: diagnostic.options.controls,
    environment: diagnostic.options.environment,
    toolchain: diagnostic.options.toolchain,
    timeout_ms: 1000,
  };
  const intent = {
    schemaVersion: '1.0.0',
    release_unit: '@aarusso-nyx/devai',
    current_version: '1.4.5',
    target_version: '1.5.0',
    support: 'current',
    change_kind: 'behavioral',
    changed_paths: [],
    changed_packages: [],
    risks: [],
    candidate: {
      commit: production.snapshot.repository.commit,
      tree: production.snapshot.repository.tree,
    },
    base: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  };
  const controls = {
    installed_package: installed,
    candidate: production.snapshot,
    expected: expected(production.snapshot, '@aarusso-nyx/devai'),
    repository_root: productionRoot,
    repository_identity: identity(production.snapshot),
    state_root: join(productionRoot, '.devai/state/release-lifecycle'),
    maximum_input_bytes: 1024 * 1024,
    unit: {
      intent,
      packages: [
        {
          manifest_path: 'packages/cli/package.json',
          source_entries: ['package.json'],
          generated_entries: [],
        },
      ],
    },
    execution,
    certification_store: {
      root: evidenceRoot,
      evidence_sink_id: 'test-evidence',
      repository_roots: roots,
      max_blob_bytes: 1024 * 1024,
    },
    artifact_store: {
      root: artifactRoot,
      sink_id: 'test-artifacts',
      repository_roots: roots,
      max_blob_bytes: 1024 * 1024,
    },
    publication_signature_verifier: () => false,
    later_stages: { export: 'unavailable', offline_verify: 'unavailable' },
    toolchain_fixture: {
      candidate: diagnostic.value.candidate,
      expected: expected(diagnostic.value.candidate, '@devai-toolchain/diagnostic'),
      repository_root: fixtureRoot,
      repository_identity: identity(diagnostic.value.candidate),
      state_root: join(fixtureRoot, '.devai/state/release-lifecycle'),
      maximum_input_bytes: 1024 * 1024,
      unit: {
        intent: diagnostic.options.plans[0].intent,
        packages: [
          {
            manifest_path: 'package.json',
            source_entries: ['package.json'],
            generated_entries: [],
          },
        ],
      },
      execution: { ...execution, dependencies: diagnostic.options.dependencies },
    },
    mutation_inputs: {
      execution_coverage: production.controls.execution_coverage,
      maximum_source_bytes: 8 * 1024 * 1024,
      maximum_source_entries: 10000,
    },
  };
  assert.throws(
    () => createProtectedReleaseHostRunner({ ...controls, installed_package: { ...installed } }),
    /rpl-package-identity-mismatch/,
  );
  assert.equal(observations.calls.length, 0);
  assert.equal(observations.stores.length, 0);
  assert.throws(
    () =>
      createProtectedReleaseHostRunner({
        ...controls,
        toolchain_fixture: {
          ...controls.toolchain_fixture,
          execution: { ...controls.toolchain_fixture.execution, environment: { CI: '1' } },
        },
      }),
    /release-host-controls-invalid/,
  );
  assert.equal(observations.stores.length, 0);
  const stale = {
    ...controls,
    mutation_inputs: {
      ...controls.mutation_inputs,
      execution_coverage: {
        ...controls.mutation_inputs.execution_coverage,
        release_plan_receipt_digest: '0'.repeat(64),
      },
    },
  };
  assert.throws(() => createProtectedReleaseHostRunner(stale), /MUTATION_ROSTER_MISMATCH/);
  assert.equal(observations.calls.length, 0);
  assert.equal(observations.container_executions, 0);
  const storeCountBeforeSuccess = observations.stores.length;
  const withoutFixture = process.argv[2] === 'without-fixture';
  if (withoutFixture) {
    delete controls.toolchain_fixture;
    delete controls.mutation_inputs;
  }
  const runner = createProtectedReleaseHostRunner(controls);
  check: {
    if (withoutFixture) {
      assert.throws(() => runner.readFixturePlan(), /release-host-fixture-unavailable/);
      assert.throws(
        () => runner.readMutationInputPlan(),
        /release-host-mutation-input-controls-unavailable/,
      );
      assert.equal(
        runner.readPlan().receipt_digest_sha256,
        production.receipt.receipt_digest_sha256,
      );
      assert.equal(observations.container_executions, 0);
      process.stdout.write(JSON.stringify({ verdict: 'pass', fixture: false }));
      break check;
    }
    const plan = runner.readPlan();
    assert.equal(plan.receipt_digest_sha256, production.receipt.receipt_digest_sha256);
    const fixturePlan = runner.readFixturePlan();
    fixturePlan.receipt_id = 'caller mutation';
    assert.notEqual(runner.readFixturePlan().receipt_id, 'caller mutation');
    const before = runner.readMutationInputPlan();
    assert.equal(before.packages.length, 10);
    assert.equal('readProof' in before, false);
    assert.deepEqual(before.grants, { execution: false, certification: false, reuse: false });
    assert.deepEqual(Object.keys(runner).sort(), [
      'invoke',
      'readFixturePlan',
      'readMutationInputPlan',
      'readPlan',
      'readPolicyClosure',
    ]);
    const fixtureRequest = { ...diagnostic.request };
    const requestFile = document('fixture-request.json', fixtureRequest);
    const result = await runner.invoke({
      action: 'release preflight',
      as_role: 'inspector',
      write: true,
      request: requestFile,
    });
    assert.equal(result.exit_code, 0, JSON.stringify(result));
    const after = runner.readMutationInputPlan();
    assert.deepEqual(after, {
      ...before,
      packages: before.packages.map((entry) => ({
        ...entry,
        reuse: {
          eligible: false,
          unresolved: entry.reuse.unresolved.filter(
            (value) => value !== 'toolchain-fixture-validation-required',
          ),
        },
      })),
    });
    assert.equal(observations.calls.at(-1).root, fixtureRoot);
    assert.equal(observations.calls.at(-1).state, controls.toolchain_fixture.state_root);
    assert.equal(observations.calls.at(-1).repository, diagnostic.value.candidate.repository.id);
    const callCount = observations.calls.length;
    for (const action of ['release certify', 'release prepare', 'release resume']) {
      const request = { ...fixtureRequest, action_id: action };
      if (action === 'release resume') delete request.receipt_locators;
      const invocation =
        action === 'release resume'
          ? {
              action,
              request: document(`${action}.json`, request),
              receipts: document('receipts.json', [runner.readFixturePlan()]),
            }
          : {
              action,
              as_role: 'inspector',
              write: true,
              request: document(`${action}.json`, request),
            };
      await assert.rejects(() => runner.invoke(invocation));
    }
    assert.equal(observations.calls.length, callCount);
    const unknown = {
      ...fixtureRequest,
      repository_locator: { ...fixtureRequest.repository_locator, id: 'unknown/repository' },
    };
    await assert.rejects(() =>
      runner.invoke({
        action: 'release preflight',
        as_role: 'inspector',
        write: true,
        request: document('unknown.json', unknown),
      }),
    );
    assert.equal(observations.calls.length, callCount);
    const mixed = { ...fixtureRequest, repository_locator: production.snapshot.repository };
    await assert.rejects(() =>
      runner.invoke({
        action: 'release preflight',
        as_role: 'inspector',
        write: true,
        request: document('mixed.json', mixed),
      }),
    );
    assert.equal(observations.calls.length, callCount);
    await runner.invoke({
      action: 'release plan',
      intent: document('production-intent.json', intent),
    });
    assert.equal(observations.calls.at(-1).root, productionRoot);
    const productionRequest = {
      ...fixtureRequest,
      action_id: 'release certify',
      repository_locator: production.snapshot.repository,
      candidate_locator: {
        commit: production.snapshot.repository.commit,
        tree: production.snapshot.repository.tree,
        release_units: [
          {
            release_unit: '@aarusso-nyx/devai',
            version: '1.5.0',
            package_roster: [
              {
                package_id: '@aarusso-nyx/devai',
                manifest_path: 'packages/cli/package.json',
                manifest_digest_sha256: hash(production.snapshot.read('packages/cli/package.json')),
              },
            ],
          },
        ],
      },
      receipt_locators: [
        {
          kind: 'release-plan-receipt',
          receipt_id: plan.receipt_id,
          receipt_digest_sha256: plan.receipt_digest_sha256,
          path: 'receipts/production-plan.json',
        },
      ],
    };
    await assert.rejects(
      () =>
        runner.invoke({
          action: 'release certify',
          as_role: 'inspector',
          write: true,
          request: document('production-certify.json', productionRequest),
        }),
      /release-certification-mutation-evidence-unavailable/,
    );
    assert.equal(observations.calls.at(-1).root, productionRoot);
    assert.equal(observations.calls.at(-1).repository, production.snapshot.repository.id);
    assert.equal(observations.stores.length - storeCountBeforeSuccess, 2);
    assert.deepEqual(
      observations.stores
        .slice(storeCountBeforeSuccess)
        .map((entry) => entry.root)
        .sort(),
      [artifactRoot, evidenceRoot].sort(),
    );
    assert.throws(
      () => createProtectedReleaseHostRunner(controls),
      /release-host-runner-already-installed/,
    );
    const repeated = await runner.invoke({
      action: 'release preflight',
      as_role: 'inspector',
      write: true,
      request: requestFile,
    });
    assert.equal(repeated.exit_code, 1);
    assert.deepEqual(runner.readMutationInputPlan(), before);
    assert.equal(readFileSync(requestFile.path).length > 0, true);
    process.stdout.write(
      JSON.stringify({
        verdict: 'pass',
        packages: after.packages.length,
        fixture: true,
        store_count: observations.stores.length - storeCountBeforeSuccess,
        expected_inputs: canonicalSha256(after.packages.map((entry) => entry.input_digest)),
      }),
    );
  }
} finally {
  cleanupFixtures();
  rmSync(parent, { recursive: true, force: true });
}
