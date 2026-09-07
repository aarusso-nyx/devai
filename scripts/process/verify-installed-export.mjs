import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectApprovedMutationVerifier } from './approved-mutation-verifier.mjs';

const loaded = new Map();
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

/** Caller provisions and independently approves the installed host before this
 * invocation. No candidate commands, signing keys, or publication adapters are
 * installed here. A successful receipt is not DEVAI ten-package readiness. */
export async function verifyInstalledExport({
  host,
  dagControl,
  directory,
  workDirectory,
  request,
  expected,
}) {
  const identity = inspectApprovedMutationVerifier(dagControl);
  requireValue(
    !loaded.has(identity.packageRoot) ||
      loaded.get(identity.packageRoot) === identity.approvalSha256,
    'INSTALLED_OFFLINE_CONTROL_PROCESS_CHANGED',
  );
  loaded.set(identity.packageRoot, identity.approvalSha256);
  requireValue(
    expected &&
      expected.hostIdentitySha256 &&
      expected.metadataSha256 &&
      expected.trustStore &&
      expected.signerId &&
      expected.verifier &&
      expected.sinkId,
    'INSTALLED_OFFLINE_EXPECTATIONS_REQUIRED',
  );
  const module = (name) => import(pathToFileURL(join(identity.packageRoot, 'src', name)).href);
  const [canonical, paths, dag] = await Promise.all([
    module('canonical.js'),
    module('safe-path.js'),
    module('verify.js'),
  ]);
  inspectApprovedMutationVerifier(dagControl);
  requireValue(
    sha(canonical.canonicalBytes(host.installed_package.identity)) === expected.hostIdentitySha256,
    'INSTALLED_OFFLINE_HOST_IDENTITY_MISMATCH',
  );
  const verificationRoot = realpathSync(expected.verificationRoot);
  const root = realpathSync(directory),
    work = realpathSync(workDirectory),
    candidate = realpathSync(dagControl.candidateRoot);
  for (const [selected, actual] of [
    [directory, root],
    [workDirectory, work],
    [expected.verificationRoot, verificationRoot],
  ]) {
    const rel = relative(candidate, actual);
    requireValue(
      resolve(selected) === actual &&
        (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)),
      'INSTALLED_OFFLINE_LOCATION_INVALID',
    );
  }
  requireValue(
    readdirSync(work).length === 0 && (lstatSync(work).mode & 0o077) === 0,
    'INSTALLED_OFFLINE_WORK_INVALID',
  );
  requireValue(
    JSON.stringify(readdirSync(root).sort()) ===
      JSON.stringify([
        'exported-state.json',
        'objects',
        'policy-closure.json',
        'task-policies.json',
      ]),
    'INSTALLED_OFFLINE_POPULATION_INVALID',
  );
  const documents = {};
  for (const name of ['exported-state.json', 'policy-closure.json', 'task-policies.json']) {
    requireValue(
      hex(expected.metadataSha256[name]) && lstatSync(join(root, name)).size <= 64 * 1024 * 1024,
      'INSTALLED_OFFLINE_METADATA_INVALID',
    );
    const bytes = paths.readRootRelativeRegularFile(root, name, 'offline metadata');
    requireValue(
      sha(bytes) === expected.metadataSha256[name],
      'INSTALLED_OFFLINE_METADATA_MISMATCH',
    );
    documents[name] = bytes;
  }
  const objects = new Map();
  let total = 0;
  requireValue(lstatSync(join(root, 'objects')).isDirectory(), 'INSTALLED_OFFLINE_OBJECTS_INVALID');
  for (const name of readdirSync(join(root, 'objects'))) {
    requireValue(
      hex(name) && lstatSync(join(root, 'objects', name)).size <= 128 * 1024 * 1024,
      'INSTALLED_OFFLINE_OBJECTS_INVALID',
    );
    const bytes = paths.readRootRelativeRegularFile(root, `objects/${name}`, 'offline object');
    total += bytes.length;
    requireValue(
      total <= 512 * 1024 * 1024 && objects.size < 40000 && sha(bytes) === name,
      'INSTALLED_OFFLINE_OBJECTS_INVALID',
    );
    objects.set(name, bytes);
  }
  const usedObjects = new Set();
  const reader = {
    readArtifact({ sink_id, opaque_handle }) {
      requireValue(
        sink_id === expected.sinkId &&
          typeof opaque_handle === 'string' &&
          /^[a-f0-9-]+:[a-f0-9-]+:[a-f0-9]{64}$/u.test(opaque_handle),
        'INSTALLED_OFFLINE_ARTIFACT_IDENTITY_INVALID',
      );
      const digest = opaque_handle.split(':').at(-1);
      const bytes = objects.get(digest);
      requireValue(bytes, 'INSTALLED_OFFLINE_ARTIFACT_MISSING');
      usedObjects.add(digest);
      return Buffer.from(bytes);
    },
  };
  const runtime = host.runtime;
  const closure = runtime.decodeReleasePolicyClosure(
    documents['policy-closure.json'],
    expected.transportLimits,
  );
  const policies = JSON.parse(documents['task-policies.json'].toString('utf8')).map(
    ({ release_unit, document }) => ({ release_unit, policy: document }),
  );
  const provider = runtime.createReleaseOfflineVerifierProvider({
    candidate: expected.candidate,
    reader,
    dag: {
      identity: { source_commit: identity.sourceCommit, archive_sha256: identity.archiveSha256 },
      verify: dag.verifyCandidateReceiptDag,
    },
    task_policies: policies,
    trust_store: expected.trustStore,
    signer_id: expected.signerId,
    verifier: expected.verifier,
    limits: expected.exportLimits,
    maximum_archive_bytes: expected.maximumArchiveBytes,
    maximum_total_bytes: expected.maximumTotalBytes,
  });
  runtime.installReleaseLifecycleCommandAdapters({
    provider: () => undefined,
    authorization: () => undefined,
    offline_receipt_verifier: () => undefined,
    publication_controls: () => undefined,
    offline_verification_provider: () => provider,
    artifact_reader: () => reader,
    export_limits: () => expected.exportLimits,
    offline_policy_closures: () => [
      {
        closure,
        expected: {
          repository: expected.repository,
          installed_package: host.installed_package.identity,
          installation_origin: expected.installationOrigin,
          release_unit: expected.releaseUnit,
        },
        implementation: host.installed_package,
        limits: expected.closureLimits,
      },
    ],
  });
  const requestPath = join(work, 'offline-request.json'),
    statePath = join(work, 'exported-state.json');
  writeFileSync(requestPath, canonical.canonicalBytes(request), { flag: 'wx', mode: 0o600 });
  writeFileSync(statePath, documents['exported-state.json'], { flag: 'wx', mode: 0o600 });
  const result = await runtime.invokeDevaiCli([
    'release',
    'offline-verify',
    '--request',
    requestPath,
    '--exported-state',
    statePath,
    '--repo-root',
    verificationRoot,
  ]);
  writeFileSync(join(work, 'offline-command-result.json'), JSON.stringify(result), {
    flag: 'wx',
    mode: 0o600,
  });
  requireValue(result.exit_code === 0, 'INSTALLED_OFFLINE_VERIFICATION_FAILED');
  requireValue(usedObjects.size === objects.size, 'INSTALLED_OFFLINE_EXTRA_OBJECTS');
  const receipt = JSON.parse(result.stdout);
  requireValue(
    receipt.receipt_kind === 'release-offline-verification-receipt' && receipt.verdict === 'pass',
    'INSTALLED_OFFLINE_RECEIPT_INVALID',
  );
  inspectApprovedMutationVerifier(dagControl);
  return { receipt, control: identity, metadataSha256: expected.metadataSha256 };
}
