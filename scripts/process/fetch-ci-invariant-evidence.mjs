// Invariants: INV-HARNESS-006
// Fixed immutable object transport. Never invokes an evaluator. Authenticates only with a
// caller-supplied ambient token; without one it stays within the unauthenticated budget.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
const gateUrl = new URL('../../packages/sensors/dist/ci-invariant-gate.js', import.meta.url);
const gate = await import(
  existsSync(gateUrl)
    ? gateUrl.href
    : new URL('../../packages/sensors/src/ci-invariant-gate.ts', import.meta.url).href
);
const MiB = 1024 * 1024;
const fail = () => {
  throw new Error('CI_EVIDENCE_TRANSPORT_REFUSED');
};
const demand = (v) => {
  if (!v) fail();
};
const sha1 = (type, raw) =>
  createHash('sha1')
    .update(Buffer.from(`${type} ${raw.length}\0`))
    .update(raw)
    .digest('hex');
/** One deadline, no retries, no redirects or credential fallback. All bytes remain in process. */
export async function fetchCiInvariantEvidence({
  trustBytes,
  expected,
  now,
  fetchImpl = fetch,
  sourceFiles = new Map(),
  token,
}) {
  demand(token === undefined || (typeof token === 'string' && /^[\x21-\x7e]+$/u.test(token)));
  // GitHub allows 60 unauthenticated REST requests per hour per runner address; stay strictly
  // below it without a token so the bound fails closed deterministically, not by rate limit.
  const requestBudget = token === undefined ? 59 : 128;
  const trust = gate.canonicalEvidenceObject(trustBytes, 'soft-gate-trust.schema.json');
  demand(trust.repository === 'aarusso-nyx/devai' && /^[a-f0-9]{40}$/u.test(trust.evidence_commit));
  demand(
    expected?.repository === trust.repository && expected.evidenceCommit === trust.evidence_commit,
  );
  // Exact canonical equality of a non-empty candidate identity; no subset or vacuous match.
  const sortedJson = (value) =>
    JSON.stringify(value, (_key, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          )
        : v,
    );
  demand(
    trust.candidate &&
      typeof trust.candidate === 'object' &&
      !Array.isArray(trust.candidate) &&
      Object.keys(trust.candidate).length > 0 &&
      expected.candidate &&
      typeof expected.candidate === 'object' &&
      !Array.isArray(expected.candidate) &&
      sortedJson(expected.candidate) === sortedJson(trust.candidate),
  );
  const deadline = Date.now() + 60000,
    controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const cache = new Map();
  let count = 0,
    total = 0;
  try {
    async function request(kind, id, limit) {
      demand(/^[a-f0-9]{40}$/u.test(id) && Date.now() < deadline && ++count <= requestBudget);
      const url = `https://api.github.com/repos/aarusso-nyx/devai/git/${kind}/${id}`;
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
      });
      if (response.status !== 200 || response.redirected) {
        await response.body?.cancel();
        fail();
      }
      demand(response.body);
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          demand(Date.now() < deadline);
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          demand(size <= limit);
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel();
        throw error;
      } finally {
        reader.releaseLock();
      }
      const value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      demand(value && value.sha === id);
      return value;
    }
    async function tree(id) {
      if (cache.has(`tree/${id}`)) return cache.get(`tree/${id}`);
      const value = await request('trees', id, 2 * MiB);
      demand(value.truncated === false && Array.isArray(value.tree) && value.tree.length <= 10000);
      const names = new Set();
      const raw = [];
      for (const entry of value.tree) {
        demand(
          typeof entry.path === 'string' &&
            gate.containedEvidencePath(entry.path) &&
            !entry.path.includes('/') &&
            !names.has(entry.path),
        );
        names.add(entry.path);
        demand(/^[a-f0-9]{40}$/u.test(entry.sha));
        demand(
          (entry.type === 'tree' && entry.mode === '040000') ||
            (entry.type === 'blob' &&
              entry.mode === '100644' &&
              Number.isSafeInteger(entry.size) &&
              entry.size >= 0 &&
              entry.size <= 16 * MiB),
        );
      }
      const sorted = [...value.tree].sort((a, b) =>
        Buffer.compare(
          Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
          Buffer.from(b.path + (b.type === 'tree' ? '/' : '')),
        ),
      );
      for (const entry of sorted)
        raw.push(
          Buffer.concat([
            Buffer.from(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.path}\0`),
            Buffer.from(entry.sha, 'hex'),
          ]),
        );
      demand(sha1('tree', Buffer.concat(raw)) === id);
      cache.set(`tree/${id}`, value.tree);
      return value.tree;
    }
    async function blob(entry, bound = 16 * MiB) {
      demand(entry.size <= bound);
      const key = `blob/${entry.sha}`;
      if (cache.has(key)) return cache.get(key);
      const value = await request('blobs', entry.sha, 2 * MiB + 2 * Math.ceil(entry.size / 3) * 4);
      demand(
        value.encoding === 'base64' &&
          value.size === entry.size &&
          typeof value.content === 'string' &&
          value.content.length <= 2 * Math.ceil(entry.size / 3) * 4 + 16,
      );
      // GitHub wraps base64 with LF; no other unobserved encoding is admitted.
      const encoded = value.content.replace(/\n/gu, '');
      const raw = Buffer.from(encoded, 'base64');
      demand(
        raw.toString('base64') === encoded &&
          raw.length === entry.size &&
          sha1('blob', raw) === entry.sha,
      );
      cache.set(key, raw);
      return raw;
    }
    const commit = await request('commits', trust.evidence_commit, 2 * MiB);
    demand(commit.tree && /^[a-f0-9]{40}$/u.test(commit.tree.sha));
    let current = commit.tree.sha;
    for (const path of ['evidence', trust.candidate.commit, trust.payload_sha256]) {
      const entries = await tree(current);
      demand(entries.length === 1 && entries[0].path === path && entries[0].type === 'tree');
      current = entries[0].sha;
    }
    const population = new Map();
    async function walk(id, prefix = '', depth = 0) {
      demand(depth <= 8);
      for (const entry of await tree(id)) {
        const path = prefix + entry.path;
        demand(gate.containedEvidencePath(path));
        if (entry.type === 'tree') await walk(entry.sha, path + '/', depth + 1);
        else {
          demand(!population.has(path));
          population.set(path, entry);
          demand(population.size <= 66);
        }
      }
    }
    await walk(current);
    const manifestEntry = population.get('manifest.json'),
      signatureEntry = population.get('signature.ed25519');
    demand(manifestEntry && signatureEntry && signatureEntry.size === 64);
    const manifestBytes = await blob(manifestEntry, MiB),
      signature = await blob(signatureEntry, 64);
    const manifest = gate.canonicalEvidenceObject(manifestBytes, 'soft-gate-evidence.schema.json');
    demand(gate.evidenceSha256(manifestBytes) === trust.payload_sha256);
    const names = [
      ...manifest.members.map((m) => m.path),
      'manifest.json',
      'signature.ed25519',
    ].sort();
    demand(JSON.stringify(names) === JSON.stringify([...population.keys()].sort()));
    const members = new Map();
    for (const member of manifest.members) {
      const entry = population.get(member.path);
      demand(entry && entry.size === member.byte_length);
      total += entry.size;
      demand(total <= 32 * MiB);
      const raw = await blob(entry);
      demand(gate.evidenceSha256(raw) === member.sha256);
      members.set(member.path, raw);
    }
    const result = {
      manifestBytes,
      signature,
      trustBytes: Buffer.from(trustBytes),
      members,
      expected,
      now,
      sourceFiles,
    };
    // When a frozen source population is supplied, retain the private verified result.
    if (sourceFiles.size) {
      const verifiedPayload = gate.verifySoftGatePayload(result);
      demand(verifiedPayload.status === 'pass');
      return { ...result, verifiedPayload };
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
