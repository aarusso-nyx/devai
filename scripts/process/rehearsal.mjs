#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function requireValue(value, code) {
  if (!value) throw new Error(code);
}
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const id = (value) => /^[1-9][0-9]*$/u.test(String(value));

export function inspectAssets(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'));
  requireValue(
    manifest.schemaVersion === '1.0.0' &&
      manifest.release.repository === 'aarusso-nyx/devai' &&
      manifest.release.package === '@aarusso-nyx/devai' &&
      manifest.release.tag === `v${manifest.release.version}`,
    'REHEARSAL_MANIFEST_INVALID',
  );
  const expected = ['release-manifest.json', 'SHA256SUMS'];
  for (const type of ['package', 'sbom', 'site']) {
    const artifact = manifest.artifacts[type];
    requireValue(
      typeof artifact.file === 'string' &&
        basename(artifact.file) === artifact.file &&
        !artifact.file.includes('\\') &&
        hex(artifact.sha256),
      'REHEARSAL_ARTIFACT_INVALID',
    );
    expected.push(artifact.file);
    requireValue(
      lstatSync(join(directory, artifact.file)).isFile() &&
        sha256(readFileSync(join(directory, artifact.file))) === artifact.sha256,
      'REHEARSAL_ARTIFACT_MISMATCH',
    );
  }
  requireValue(
    new Set(expected).size === 5 &&
      JSON.stringify(readdirSync(directory).sort()) === JSON.stringify(expected.sort()),
    'REHEARSAL_POPULATION_INVALID',
  );
  const files = {};
  for (const name of expected) {
    requireValue(
      lstatSync(join(directory, name)).isFile() &&
        !lstatSync(join(directory, name)).isSymbolicLink(),
      'REHEARSAL_SPECIAL_FILE',
    );
    files[name] = sha256(readFileSync(join(directory, name)));
  }
  const sums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
  requireValue(sums.length === 4, 'REHEARSAL_CHECKSUM_POPULATION');
  const seen = new Set();
  for (const line of sums) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/u.exec(line);
    requireValue(
      match && match[2] !== 'SHA256SUMS' && !seen.has(match[2]) && files[match[2]] === match[1],
      'REHEARSAL_CHECKSUM_MISMATCH',
    );
    seen.add(match[2]);
  }
  return { manifest, files };
}

export function makeCompletion(directory, context) {
  const { manifest, files } = inspectAssets(directory);
  requireValue(
    context.repository === 'aarusso-nyx/devai' &&
      id(context.runId) &&
      id(context.attempt) &&
      id(context.artifactId) &&
      hex(context.artifactDigest?.replace(/^sha256:/u, '')) &&
      /^[a-f0-9]{40}$/u.test(context.workflowCommit) &&
      /^[a-f0-9]{40}$/u.test(context.controlCommit),
    'REHEARSAL_CONTEXT_INVALID',
  );
  return {
    schemaVersion: '1.0.0',
    kind: 'devai-rehearsal-completion',
    ...context,
    workflow: '.github/workflows/release.yml',
    source: manifest.source,
    releaseTag: manifest.release.tag,
    ledger: manifest.ledger,
    files,
    manifestSha256: files['release-manifest.json'],
  };
}

export function validatePromotion(record, run, artifact, expected, assets) {
  requireValue(
    record.schemaVersion === '1.0.0' && record.kind === 'devai-rehearsal-completion',
    'PROMOTION_RECEIPT_INVALID',
  );
  requireValue(
    record.repository === expected.repository && record.repository === 'aarusso-nyx/devai',
    'PROMOTION_REPOSITORY_MISMATCH',
  );
  requireValue(
    String(record.runId) === String(expected.runId) &&
      String(record.attempt) === String(expected.attempt) &&
      String(run.id) === String(expected.runId) &&
      String(run.run_attempt) === String(expected.attempt),
    'PROMOTION_RUN_MISMATCH',
  );
  requireValue(
    run.status === 'completed' && run.conclusion === 'success' && run.event === 'workflow_dispatch',
    'PROMOTION_RUN_NOT_SUCCESSFUL',
  );
  requireValue(
    run.repository?.full_name === record.repository &&
      run.path === record.workflow &&
      record.workflow === '.github/workflows/release.yml' &&
      run.head_sha === record.workflowCommit &&
      record.workflowCommit === expected.workflowCommit &&
      record.controlCommit === expected.controlCommit,
    'PROMOTION_WORKFLOW_MISMATCH',
  );
  requireValue(
    record.releaseTag === expected.tag &&
      record.source.commit === expected.commit &&
      record.source.tree === expected.tree,
    'PROMOTION_CANDIDATE_MISMATCH',
  );
  requireValue(
    String(record.artifactId) === String(artifact.id) &&
      artifact.expired === false &&
      artifact.name === `devai-release-assets-${record.attempt}` &&
      artifact.digest === `sha256:${record.artifactDigest.replace(/^sha256:/u, '')}` &&
      String(artifact.workflow_run?.id) === String(record.runId),
    'PROMOTION_ARTIFACT_IDENTITY_MISMATCH',
  );
  requireValue(
    record.manifestSha256 === assets.files['release-manifest.json'] &&
      JSON.stringify(record.files) === JSON.stringify(assets.files),
    'PROMOTION_FILE_MISMATCH',
  );
  requireValue(
    JSON.stringify(record.source) === JSON.stringify(assets.manifest.source) &&
      record.releaseTag === assets.manifest.release.tag &&
      JSON.stringify(record.ledger) === JSON.stringify(assets.manifest.ledger),
    'PROMOTION_MANIFEST_MISMATCH',
  );
  // Current verification is performed by the protected ledger job. Any changed
  // evidence or trust input requires a new rehearsal; no obsolete claim is reused.
  requireValue(
    expected.ledger !== null &&
      typeof expected.ledger === 'object' &&
      !Array.isArray(expected.ledger) &&
      record.ledger !== null &&
      typeof record.ledger === 'object' &&
      !Array.isArray(record.ledger) &&
      Object.keys(expected.ledger).length > 0 &&
      JSON.stringify(Object.keys(expected.ledger).sort()) ===
        JSON.stringify(Object.keys(record.ledger).sort()),
    'PROMOTION_TRUST_OR_EVIDENCE_CHANGED',
  );
  for (const [key, value] of Object.entries(expected.ledger))
    requireValue(record.ledger[key] === value, 'PROMOTION_TRUST_OR_EVIDENCE_CHANGED');
  return true;
}

function gh(args, binary = false) {
  const result = spawnSync('gh', args, {
    encoding: binary ? undefined : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  requireValue(result.status === 0, 'PROMOTION_REMOTE_STATE_UNKNOWN');
  return binary ? result.stdout : JSON.parse(result.stdout);
}
function extractZip(data, directory) {
  requireValue(!lstatMaybe(directory), 'PROMOTION_DESTINATION_EXISTS');
  const result = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `
import io, os, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    names = z.namelist()
    if len(names) != len(set(names)) or len(names) > 20: raise ValueError('population')
    total = 0
    for info in z.infolist():
        mode = info.external_attr >> 16
        if '/' in info.filename or '\\\\' in info.filename or info.filename in ('.', '..') or ':' in info.filename or (mode & 0o170000) not in (0, 0o100000): raise ValueError('path or type')
        total += info.file_size
        if total > 1024 * 1024 * 1024: raise ValueError('size')
    root.mkdir(mode=0o700)
    for name in names:
        with (root / name).open('xb') as f: f.write(z.read(name))
`,
      directory,
    ],
    { input: data, maxBuffer: 1024 * 1024 },
  );
  requireValue(result.status === 0, 'PROMOTION_ARCHIVE_INVALID');
}
function lstatMaybe(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function main() {
  const [mode, directory, contextPath, output] = process.argv.slice(2);
  if (mode === 'complete') {
    writeFileSync(
      output,
      `${JSON.stringify(makeCompletion(directory, JSON.parse(readFileSync(contextPath))), null, 2)}\n`,
      { flag: 'wx' },
    );
    return;
  }
  requireValue(mode === 'promote', 'USAGE');
  const expected = JSON.parse(readFileSync(contextPath));
  requireValue(
    expected.repository === 'aarusso-nyx/devai' && id(expected.runId) && id(expected.attempt),
    'PROMOTION_SELECTION_REQUIRED',
  );
  const prefix = `repos/${expected.repository}/actions`;
  const run = gh(['api', `${prefix}/runs/${expected.runId}/attempts/${expected.attempt}`]);
  const pages = gh([
    'api',
    '--paginate',
    '--slurp',
    `${prefix}/runs/${expected.runId}/artifacts?per_page=100`,
  ]);
  const artifacts = pages.flatMap((page) => page.artifacts);
  const select = (name) => {
    const matches = artifacts.filter((item) => item.name === name && item.expired === false);
    requireValue(matches.length === 1, 'PROMOTION_ARTIFACT_UNAVAILABLE_OR_AMBIGUOUS');
    return matches[0];
  };
  const receiptArtifact = select(`devai-rehearsal-${expected.attempt}`);
  const download = (artifact) => {
    const data = gh(['api', `${prefix}/artifacts/${artifact.id}/zip`], true);
    requireValue(
      artifact.digest === `sha256:${sha256(data)}`,
      'PROMOTION_DOWNLOAD_DIGEST_MISMATCH',
    );
    return data;
  };
  const receiptDir = `${directory}-completion`;
  extractZip(download(receiptArtifact), receiptDir);
  requireValue(
    JSON.stringify(readdirSync(receiptDir)) === '["rehearsal-completion.json"]',
    'PROMOTION_RECEIPT_POPULATION',
  );
  const record = JSON.parse(readFileSync(join(receiptDir, 'rehearsal-completion.json')));
  const artifact = select(`devai-release-assets-${expected.attempt}`);
  extractZip(download(artifact), directory);
  validatePromotion(record, run, artifact, expected, inspectAssets(directory));
  // Keep a machine-readable, non-sensitive promotion decision for job summaries.
  process.stdout.write(
    `${JSON.stringify({ ok: true, runId: expected.runId, attempt: expected.attempt, manifestSha256: record.manifestSha256, buildInvocations: 0 })}\n`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${/^[A-Z_]+$/u.test(error.message) ? error.message : 'PROMOTION_FAILED'}\n`,
    );
    process.exitCode = 1;
  }
}
