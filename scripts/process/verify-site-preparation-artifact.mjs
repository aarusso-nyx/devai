// Complete typed validation occurs before any extraction or publication callback.
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { siteMembers } from './verify-pages-bytes.mjs';
const built = new URL('../../packages/sensors/dist/ci-invariant-gate.js', import.meta.url);
const gate = await import(
  existsSync(built)
    ? built.href
    : new URL('../../packages/sensors/src/ci-invariant-gate.ts', import.meta.url).href
);
export async function verifySitePreparationArtifact(input) {
  const validated = gate.validateSitePreparationArtifact(input);
  if (validated.status !== 'pass') throw new Error('SITE_PREPARATION_ARTIFACT_REFUSED');
  const files = gate.consumeSitePreparationFiles(validated);
  if (input.extract) await input.extract(files);
  if (input.destination) {
    const root = resolve(input.destination);
    if (existsSync(root)) throw new Error('SITE_PREPARATION_DESTINATION_EXISTS');
    const parent = resolve(root, '..');
    mkdirSync(parent, { recursive: true });
    const scratch = mkdtempSync(join(parent, '.validated-site-'));
    for (const member of gate.consumeSitePreparationFiles(validated)) {
      const path = join(scratch, member.path);
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, member.bytes, { flag: 'wx' });
    }
    const { renameSync } = await import('node:fs');
    renameSync(scratch, root);
  }
  return validated;
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function fetchSitePreparationArtifact({ env, destination, fetchImpl = fetch }) {
  const refuse = () => {
    throw new Error('SITE_PREPARATION_REMOTE_CUSTODY_REFUSED');
  };
  if (
    env.GITHUB_REPOSITORY !== 'aarusso-nyx/devai' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !/^[1-9][0-9]*$/u.test(env.PAGES_ARTIFACT_ID ?? '') ||
    !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
    !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '') ||
    !/^[a-f0-9]{40}$/u.test(env.SOURCE_TREE ?? '') ||
    !env.GH_TOKEN
  )
    refuse();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  if (head !== env.GITHUB_SHA || tree !== env.SOURCE_TREE) refuse();
  const signal = AbortSignal.timeout(60000);
  const api = 'https://api.github.com/repos/aarusso-nyx/devai';
  async function read(url, maximum, authenticated = true) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal,
      headers: authenticated
        ? { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' }
        : {},
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      refuse();
    }
    const reader = response.body.getReader(),
      chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maximum) refuse();
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  const metadata = JSON.parse(
    (await read(`${api}/actions/artifacts/${env.PAGES_ARTIFACT_ID}`, 2 * 1024 * 1024)).toString(),
  );
  if (
    String(metadata.id) !== env.PAGES_ARTIFACT_ID ||
    metadata.expired !== false ||
    String(metadata.workflow_run?.id) !== env.GITHUB_RUN_ID ||
    metadata.workflow_run?.head_sha !== head ||
    metadata.workflow_run?.head_branch !== 'main' ||
    !/^sha256:[a-f0-9]{64}$/u.test(metadata.digest ?? '')
  )
    refuse();
  const jobs = JSON.parse(
    (
      await read(
        `${api}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
        2 * 1024 * 1024,
      )
    ).toString(),
  );
  const preparation = jobs.jobs?.filter(
    (j) => j.name === 'Prepare the documentation site from main',
  );
  if (
    !Array.isArray(jobs.jobs) ||
    jobs.total_count !== jobs.jobs.length ||
    preparation?.length !== 1 ||
    preparation[0].status !== 'completed' ||
    preparation[0].conclusion !== 'success'
  )
    refuse();
  const download = await fetchImpl(`${api}/actions/artifacts/${env.PAGES_ARTIFACT_ID}/zip`, {
    redirect: 'manual',
    signal,
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (download.status !== 302) {
    await download.body?.cancel();
    refuse();
  }
  const location = new URL(download.headers.get('location') ?? '');
  await download.body?.cancel();
  if (
    location.protocol !== 'https:' ||
    location.username ||
    location.password ||
    !(
      /(?:^|\.)blob\.core\.windows\.net$/u.test(location.hostname) ||
      location.hostname === 'productionresultssa0.blob.core.windows.net'
    )
  )
    refuse();
  const archiveBytes = await read(location.href, 544 * 1024 * 1024, false);
  if (!/^[a-f0-9]{64}$/u.test(env.SITE_SHA256 ?? '')) refuse();
  // The member population travels inside the downloaded archive, never through an environment
  // string (single env strings are capped near 128 KiB). Only its sha256 crosses jobs; the
  // validator below binds the archive population to that read-only preparation digest.
  let members;
  try {
    members = gate.siteArchiveMembers(archiveBytes);
  } catch {
    refuse();
  }
  if (digest(Buffer.from(JSON.stringify(members))) !== env.SITE_SHA256) refuse();
  if (
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== head ||
    execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim() !== tree
  )
    refuse();
  return verifySitePreparationArtifact({
    archiveBytes,
    artifact: {
      id: env.PAGES_ARTIFACT_ID,
      runId: env.GITHUB_RUN_ID,
      sourceCommit: head,
      sourceTree: tree,
      archiveSha256: metadata.digest.slice(7),
      siteSha256: env.SITE_SHA256,
      members,
    },
    expected: {
      artifactId: env.PAGES_ARTIFACT_ID,
      runId: env.GITHUB_RUN_ID,
      sourceCommit: head,
      sourceTree: tree,
      siteSha256: env.SITE_SHA256,
      preparationConclusion: 'success',
    },
    destination,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory] = process.argv.slice(2);
  if (mode === 'prepare' && directory && process.env.GITHUB_OUTPUT) {
    // Only the population digest is a job output; the population itself is the uploaded artifact.
    const population = Buffer.from(JSON.stringify(siteMembers(directory)));
    appendFileSync(process.env.GITHUB_OUTPUT, `site_sha256=${digest(population)}\n`);
  } else if (mode === 'fetch' && directory)
    await fetchSitePreparationArtifact({ env: process.env, destination: directory });
  else throw new Error('SITE_PREPARATION_ARGUMENTS_REQUIRED');
}
