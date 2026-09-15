// Fixture-level bundled-host integration only; this is not an installed-tarball acceptance test.
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
  createHash,
} from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { canonicalJson, canonicalSha256 } from '@devai-nyx/utils';
import { installedPackage, fixture } from '../helpers/release-mutation-inputs-fixture.js';
import { bindReleaseHostPackageSnapshot } from '../../src/services/release-host-package-binding.js';
import { invokeDevaiCli } from '../../src/release-host.js';
import { createProtectedReleaseHostRunner } from '../../src/services/release-protected-host-runner.js';
import { verifyReleaseCandidateSnapshot } from '../../src/services/release-candidate-snapshot.js';
import { validateReleaseLifecycleRequest } from '../../src/services/release-lifecycle-execution.js';

const ROOT = process.env.DEVAI_TEST_ROOT;
if (typeof ROOT !== 'string') throw new Error('fixture root missing');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const require = createRequire(join(ROOT, 'packages/cli/package.json'));
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'devai export fixture ç-')));
const files = (root) =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
const git = (root, args, input) => {
  const result = spawnSync('git', ['-C', root, ...args], { input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const oid = (type, bytes) =>
  createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
function candidate(files, parent) {
  const root = { children: new Map() };
  const objects = new Map();
  for (const [filePath, value] of files) {
    const parts = filePath.split('/');
    const leaf = parts.pop();
    let current = root;
    for (const part of parts) {
      const existing = current.children.get(part);
      const next = existing ?? { children: new Map() };
      if ('bytes' in next) throw new Error('fixture candidate path collision');
      current.children.set(part, next);
      current = next;
    }
    current.children.set(leaf, { path: filePath, bytes: Buffer.from(value) });
  }
  const tree = (node) => {
    const entries = [...node.children]
      .map(([name, child]) => {
        if ('bytes' in child) {
          const id = oid('blob', child.bytes);
          objects.set(id, { type: 'blob', bytes: child.bytes });
          return { name, mode: '100644', id };
        }
        return { name, mode: '40000', id: tree(child) };
      })
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(`${left.name}${left.mode === '40000' ? '/' : ''}`),
          Buffer.from(`${right.name}${right.mode === '40000' ? '/' : ''}`),
        ),
      );
    const bytes = Buffer.concat(
      entries.map((entry) =>
        Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.id, 'hex')]),
      ),
    );
    const id = oid('tree', bytes);
    objects.set(id, { type: 'tree', bytes });
    return id;
  };
  const treeId = tree(root);
  const commitBytes = Buffer.from(
    `tree ${treeId}\n${parent === undefined ? '' : `parent ${parent}\n`}author Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`,
  );
  const commit = oid('commit', commitBytes);
  objects.set(commit, { type: 'commit', bytes: commitBytes });
  return verifyReleaseCandidateSnapshot({
    repository: { id: 'aarusso-nyx/devai', commit, tree: treeId },
    objects,
    maximum_bytes: 8 * 1024 * 1024,
    maximum_entries: 10000,
  });
}
function checkout(snapshot, root, ancestors = []) {
  mkdirSync(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'DEVAI Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  for (const proof of [...ancestors, snapshot]) {
    for (const [id, object] of proof.readProof(proof.paths))
      assert.equal(
        git(root, ['hash-object', '-w', '--literally', '-t', object.type, '--stdin'], object.bytes),
        id,
      );
  }
  git(root, ['checkout', '--detach', snapshot.repository.commit]);
  git(root, ['remote', 'add', 'origin', `https://github.com/${snapshot.repository.id}.git`]);
}
function input(name, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const path = join(parent, name);
  writeFileSync(path, bytes);
  return { path, sha256: hash(bytes) };
}
try {
  const dist = join(ROOT, 'packages/cli/dist/runtime');
  // Mirror only the identity-bound runtime population, rather than treating the
  // complete development dist tree as package input.
  const library = readFileSync(join(require.resolve('typescript'), '..', 'lib.d.ts'));
  const tsVersion = JSON.parse(
    readFileSync(require.resolve('typescript/package.json'), 'utf8'),
  ).version;
  const runtimeFiles = [
    join(dist, 'index/sensor-registry.json'),
    join(dist, 'index/sense-presets.json'),
    ...files(join(dist, 'evidence-verification')),
  ];
  const extras = [
    ...runtimeFiles.map((path) => ({
      path: `dist/runtime/${relative(dist, path)}`,
      mode: 0o644,
      bytes: readFileSync(path),
    })),
    { path: 'dist/runtime/index/lib.d.ts', mode: 0o644, bytes: library },
    {
      path: 'dist/runtime/index/typescript-libraries.json',
      mode: 0o644,
      bytes: Buffer.from(
        JSON.stringify({
          schemaVersion: '1.0.0',
          compiler_version: tsVersion,
          files: [{ path: 'lib.d.ts', sha256: hash(library) }],
        }),
      ),
    },
  ];
  const installed = installedPackage(extras, { current: true });
  bindReleaseHostPackageSnapshot(installed);
  const base = fixture(installed, { current: true, profileOverrides: { mutation_roster: [] } });
  // A none-carrier still prepares the sole publishable CLI unit; this is not a
  // mutation-roster entry and must remain present in the candidate snapshot.
  base.files.set(
    'packages/cli/package.json',
    Buffer.from(JSON.stringify({ name: '@aarusso-nyx/devai', version: '1.5.0' })),
  );
  // The generic mutation fixture derives its descriptor from the mutation
  // roster. A `none` plan has no mutation entries, while the genuine preflight
  // floor still resolves its capability nodes. Materialize those declared
  // nodes rather than substituting the runner.
  const profile = JSON.parse(
    base.files.get('law/policy/devai-adoption.json').toString('utf8'),
  ).release_verification;
  const taskNodes = [...new Set(Object.values(profile.capability_tasks).flat())].sort();
  base.files.set(
    'test-tasks.json',
    Buffer.from(
      JSON.stringify({
        schemaVersion: '1.0.0',
        descriptorVersion: 'fixture-none-v1',
        repositoryId: 'aarusso-nyx/devai',
        fallbackNodeId: null,
        dynamicFallbackSelectors: [],
        tasks: taskNodes.map((nodeId) => ({
          nodeId,
          dependencies: [],
          argv: ['node', '-e', 'process.stdout.write("fixture capability")'],
          cwd: '.',
          runner: 'node-v1',
          inputSelectors: [{ kind: 'exact', pattern: 'package.json' }],
          toolchainKeys: ['node'],
          allowlistedEnv: ['CI'],
          outputContract: { kind: 'test', requiredResult: 'pass' },
        })),
        profiles: [{ profileId: 'local', mode: 'fixed', requiredNodes: taskNodes }],
      }),
    ),
  );
  // `init bind --write` must be part of the exact candidate rather than an
  // after-snapshot worktree mutation. Exercise the actual binding once, then
  // reconstruct the final candidate from its materialized authority policy.
  // Authority policy records the local slug. Keep this bootstrap checkout's
  // basename equal to the final candidate checkout while retaining a distinct
  // parent so the final tree still receives only committed candidate bytes.
  const bindingParent = join(parent, 'binding-bootstrap');
  mkdirSync(bindingParent);
  const bindingRoot = join(bindingParent, 'candidate');
  checkout(candidate(base.files), bindingRoot);
  const bound = await invokeDevaiCli([
    'init',
    'bind',
    '--target',
    bindingRoot,
    '--as-role',
    'architect',
    '--write',
  ]);
  assert.equal(bound.exit_code, 0, bound.stderr);
  base.files.set(
    '.devai/config/authority-policy.json',
    readFileSync(join(bindingRoot, '.devai/config/authority-policy.json')),
  );
  rmSync(bindingRoot, { recursive: true, force: true });
  const baseFiles = new Map(base.files);
  baseFiles.set(
    'packages/cli/package.json',
    Buffer.from(JSON.stringify({ name: '@aarusso-nyx/devai', version: '1.4.5' })),
  );
  const baseSnapshot = candidate(baseFiles);
  const snapshot = candidate(base.files, baseSnapshot.repository.commit);
  const expected = {
    repository: snapshot.repository,
    installed_package: installed.identity,
    installation_origin: 'candidate-adopter-dependency',
    release_unit: '@aarusso-nyx/devai',
  };
  const intent = {
    schemaVersion: '1.0.0',
    release_unit: '@aarusso-nyx/devai',
    current_version: '1.4.5',
    target_version: '1.5.0',
    support: 'current',
    change_kind: 'metadata',
    changed_paths: ['packages/cli/package.json'],
    changed_packages: ['@aarusso-nyx/devai'],
    risks: [],
    candidate: { commit: snapshot.repository.commit, tree: snapshot.repository.tree },
    base: { commit: baseSnapshot.repository.commit, tree: baseSnapshot.repository.tree },
  };
  const production = {
    snapshot,
    intent,
    controls: {
      container: {
        docker_binary: '/protected/docker',
        docker_binary_sha256: 'a'.repeat(64),
        docker_config_directory: '/protected/config',
        engine_socket: 'unix:///protected/docker.sock',
        engine_version: '29.5.2',
        image: `node@sha256:${'b'.repeat(64)}`,
        node_version: 'v24.20.0',
        executables: { node: { path: '/usr/local/bin/node', sha256: 'c'.repeat(64) } },
        memory_bytes: 256 * 1024 * 1024,
        cpus: 0.5,
        pids_limit: 64,
        maximum_archive_bytes: 1024 * 1024,
      },
      environment: { CI: '1' },
      toolchain: {
        node: 'v24.20.0',
        pnpm: '9.15.0',
        vitest: '4.1.10',
        typescript: '5.9.3',
        stryker: '9.6.1',
      },
    },
  };
  const root = join(parent, 'candidate');
  checkout(production.snapshot, root, [baseSnapshot]);
  const evidence = join(parent, 'evidence');
  const artifacts = join(parent, 'artifacts');
  mkdirSync(evidence, { mode: 0o700 });
  mkdirSync(artifacts, { mode: 0o700 });
  // `init bind` derives the authority slug from this checkout's basename; it is
  // deliberately distinct from the canonical repository identity below.
  const identity = {
    authority_repository_id: 'candidate',
    read_expected_release_repository_id: () => production.snapshot.repository.id,
  };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const runner = createProtectedReleaseHostRunner({
    installed_package: installed,
    candidate: production.snapshot,
    expected,
    repository_root: root,
    repository_identity: identity,
    state_root: join(root, '.devai/state/release-lifecycle'),
    maximum_input_bytes: 1024 * 1024,
    unit: {
      intent: production.intent,
      packages: [
        {
          manifest_path: 'packages/cli/package.json',
          source_entries: ['package.json'],
          generated_entries: [],
        },
      ],
    },
    execution: {
      controls: production.controls.container,
      dependencies: [],
      environment: production.controls.environment,
      toolchain: production.controls.toolchain,
      timeout_ms: 1000,
    },
    certification_store: {
      root: evidence,
      evidence_sink_id: 'fixture-evidence',
      repository_roots: [root],
      max_blob_bytes: 1024 * 1024,
    },
    artifact_store: {
      root: artifacts,
      sink_id: 'fixture-artifacts',
      repository_roots: [root],
      max_blob_bytes: 1024 * 1024,
    },
    publication_signature_verifier: () => false,
    later_stages: {
      offline_verify: 'unavailable',
      export: {
        provider: { kind: 'evidence-export', provider_id: 'fixture-ed25519' },
        destination: { kind: 'evidence-destination', exact_identifier: 'fixture/export' },
        trust: {
          trust_root_id: 'fixture-trust',
          trust_store_digest_sha256: 'a'.repeat(64),
          key_id: 'fixture-ed25519',
          signature_algorithm: 'ed25519',
        },
        signer: {
          sign: (transcript) => signBytes(null, transcript, privateKey),
          verify: (transcript, signature) => verifyBytes(null, transcript, publicKey, signature),
        },
        closure_limits: {
          maximum_archive_bytes: 4 * 1024 * 1024,
          maximum_unpacked_bytes: 4 * 1024 * 1024,
          maximum_git_bytes: 4 * 1024 * 1024,
          maximum_git_entries: 2000,
        },
        transport_limits: {
          maximum_transport_bytes: 4 * 1024 * 1024,
          maximum_decoded_bytes: 4 * 1024 * 1024,
          maximum_entries: 2000,
        },
        transcript_limits: {
          maximum_transcript_bytes: 1024 * 1024,
          maximum_provider_result_bytes: 1024 * 1024,
          maximum_packages: 4,
        },
      },
    },
  });
  const plan = runner.readPlan();
  const planPath = '.devai/state/release-lifecycle/receipts/plan.json';
  mkdirSync(join(root, '.devai/state/release-lifecycle/receipts'), { recursive: true });
  writeFileSync(join(root, planPath), `${canonicalJson(plan)}\n`);
  const request = (action) => ({
    schemaVersion: '1.0.0',
    request_kind: 'release-lifecycle-request',
    action_id: action,
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
        path: planPath,
      },
    ],
    ...(action === 'release export'
      ? {
          provider: { kind: 'evidence-export', provider_id: 'fixture-ed25519' },
          destination: {
            kind: 'evidence-destination',
            exact_identifier: 'fixture/export',
            trust: {
              trust_root_id: 'fixture-trust',
              trust_store_digest_sha256: 'a'.repeat(64),
              key_id: 'fixture-ed25519',
              signature_algorithm: 'ed25519',
            },
          },
        }
      : {}),
  });
  await runner.invoke({ action: 'release plan', intent: input('intent.json', intent) });
  for (const action of [
    'release preflight',
    'release certify',
    'release prepare',
    'release export',
  ]) {
    const actionRequest = request(action);
    validateReleaseLifecycleRequest(actionRequest, action);
    const result = await runner.invoke({
      action,
      as_role: ['release preflight', 'release certify'].includes(action)
        ? 'inspector'
        : 'architect',
      write: true,
      request: input(`${action}.json`, actionRequest),
    });
    if (result.exit_code !== 0) console.error(JSON.stringify({ action, result }));
    assert.equal(result.exit_code, 0, `${action}: ${result.stderr}`);
  }
  process.stdout.write(
    JSON.stringify({
      verdict: 'pass',
      mode: 'none',
      plan: plan.receipt_digest_sha256,
      inputs: canonicalSha256(request('release export')),
    }),
  );
} finally {
  rmSync(parent, { recursive: true, force: true });
}
