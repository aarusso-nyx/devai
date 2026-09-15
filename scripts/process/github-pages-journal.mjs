// Approved repository control: GitHub deployment metadata is the durable intent
// journal. Pages effects still require the exact promotion authorization.
import { createHash } from 'node:crypto';
const REPOSITORY = 'aarusso-nyx/devai';
const ROOT = `/repos/${REPOSITORY}`;
const ENVIRONMENT = 'devai-pages-publication';
const TASK = 'devai:pages-publication';
const KIND = 'devai-pages-publication-intent';
const API = 'https://api.github.com';
const numericId = (id) => Number.isSafeInteger(id) && id > 0;
const fail = (reason) => {
  throw new Error(`PAGES_JOURNAL_${reason}`);
};

export function inspectPagesMigrationAudit(bytes, expectedSha256, identity) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 65536 ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    createHash('sha256').update(bytes).digest('hex') !== expectedSha256
  )
    fail('MIGRATION_AUDIT_DIGEST');
  const audit = JSON.parse(bytes.toString('utf8'));
  if (
    audit.schemaVersion !== '1.0.0' ||
    audit.repository !== REPOSITORY ||
    audit.tag !== identity.tag ||
    audit.controlCommit !== identity.controlCommit ||
    audit.legacyEffects !== 'confirmed-absent-for-tag' ||
    audit.singleWriterGroup !== ENVIRONMENT ||
    typeof audit.reviewedAt !== 'string' ||
    !Number.isFinite(Date.parse(audit.reviewedAt))
  )
    fail('MIGRATION_AUDIT_INVALID');
  return audit;
}

export function githubPagesControls({
  token,
  identity,
  runId,
  attempt,
  auditBytes,
  auditSha256,
  verifyLiveBytes,
  getOidcToken,
  fetchImpl = fetch,
  retainRecord,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  inspectPagesMigrationAudit(auditBytes, auditSha256, identity);
  if (!token || !/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(attempt))
    fail('CONFIGURATION');
  let preparedOidcToken;
  const logUrl = `https://github.com/${REPOSITORY}/actions/runs/${runId}/attempts/${attempt}`;
  async function request(method, path, body) {
    if (!path.startsWith(`${ROOT}/`) || path.includes('..')) fail('API_PATH');
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      fail('API_OUTCOME_UNKNOWN');
    }
    // Never include the response body, token, OIDC token or request body in errors.
    if (
      response.status !== (method === 'GET' || path === `${ROOT}/pages/deployments` ? 200 : 201)
    ) {
      await response.body?.cancel();
      fail('API_OUTCOME_UNKNOWN');
    }
    const chunks = [];
    let total = 0;
    if (!response.body) fail('API_RESPONSE_INVALID');
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) fail('API_RESPONSE_LIMIT');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('API_RESPONSE_INVALID');
    }
  }
  async function collection(path) {
    const all = [],
      ids = new Set();
    for (let page = 1; page <= 100; page++) {
      const values = await request(
        'GET',
        `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      if (!Array.isArray(values) || values.length > 100) fail('COLLECTION_INVALID');
      for (const value of values) {
        if (!numericId(value?.id) || ids.has(value.id)) fail('COLLECTION_INVALID');
        ids.add(value.id);
        all.push(value);
      }
      if (values.length < 100) return all;
    }
    fail('COLLECTION_LIMIT');
  }
  async function readJournal() {
    const deployments = await collection(`${ROOT}/deployments?task=${encodeURIComponent(TASK)}`);
    const records = [];
    for (const deployment of deployments) {
      const payload = deployment.payload;
      if (
        deployment.task !== TASK ||
        deployment.environment !== ENVIRONMENT ||
        payload?.kind !== KIND ||
        payload.schemaVersion !== '1.0.0' ||
        typeof payload.identity?.tag !== 'string'
      )
        fail('INTENT_INVALID');
      if (
        deployment.sha !== payload.identity.commit ||
        typeof payload.artifactId !== 'string' ||
        !/^[1-9][0-9]*$/u.test(payload.artifactId) ||
        typeof payload.runId !== 'string' ||
        !/^[1-9][0-9]*$/u.test(payload.runId) ||
        typeof payload.attempt !== 'string' ||
        !/^[1-9][0-9]*$/u.test(payload.attempt)
      )
        fail('INTENT_INVALID');
      const statuses = await collection(`${ROOT}/deployments/${deployment.id}/statuses`);
      let pagesId = null,
        phase = 'intent';
      // API order is not evidence: status IDs give a stable chronological order.
      for (const status of statuses.sort((a, b) => a.id - b.id)) {
        const match = /^devai-pages:(submitted|verified):([A-Za-z0-9_-]{1,100})$/u.exec(
          status.description,
        );
        if (
          !match ||
          status.environment !== ENVIRONMENT ||
          status.deployment_url !== `${API}${ROOT}/deployments/${deployment.id}` ||
          status.state !== (match[1] === 'submitted' ? 'in_progress' : 'success') ||
          (pagesId !== null && pagesId !== match[2]) ||
          (phase === 'verified' && match[1] !== 'verified') ||
          (phase === 'intent' && match[1] !== 'submitted')
        )
          fail('STATUS_INVALID');
        pagesId = match[2];
        phase = match[1];
      }
      const matchingIdentity =
        payload.identity !== null &&
        typeof payload.identity === 'object' &&
        Object.keys(payload.identity).length === Object.keys(identity).length &&
        Object.entries(identity).every(([key, value]) => payload.identity[key] === value);
      if (!matchingIdentity) {
        if (phase !== 'verified') fail('OTHER_PUBLICATION_UNRESOLVED');
        continue;
      }
      records.push({
        schemaVersion: '1.0.0',
        identity: payload.identity,
        intentId: String(deployment.id),
        artifactId: payload.artifactId,
        pagesId,
        phase,
      });
    }
    return { complete: true, migrationAudited: true, records };
  }
  async function writeStatus(record, verified) {
    if (!/^[1-9][0-9]*$/u.test(record.intentId) || !/^[A-Za-z0-9_-]{1,100}$/u.test(record.pagesId))
      fail('STATUS_INVALID');
    await retainRecord(record);
    const result = await request('POST', `${ROOT}/deployments/${record.intentId}/statuses`, {
      state: verified ? 'success' : 'in_progress',
      environment: ENVIRONMENT,
      description: `devai-pages:${verified ? 'verified' : 'submitted'}:${record.pagesId}`,
      log_url: logUrl,
      auto_inactive: false,
    });
    if (!numericId(result?.id)) fail('STATUS_INVALID');
    const persisted = await readJournal();
    const matching = persisted.records.filter((item) => item.intentId === record.intentId);
    if (
      matching.length !== 1 ||
      matching[0].pagesId !== record.pagesId ||
      matching[0].phase !== (verified ? 'verified' : 'submitted')
    )
      fail('STATUS_NOT_DURABLE');
  }
  return {
    readJournal,
    async readEffect() {
      try {
        await verifyLiveBytes(identity);
        return 'matching';
      } catch {
        // Absence is proven by complete intent history under the separately
        // approved migration audit and mandatory single-writer workflow lock.
        // A live HTTP failure alone never establishes absence.
        const journal = await readJournal();
        return journal.records.length === 0 ? 'confirmed-missing' : 'unknown';
      }
    },
    async createIntent({ schemaVersion, identity: selected, artifactId }) {
      if (!Number.isSafeInteger(Number(artifactId)) || Number(artifactId) < 1)
        fail('ARTIFACT_ID_INVALID');
      preparedOidcToken = await getOidcToken();
      if (typeof preparedOidcToken !== 'string' || !preparedOidcToken) fail('OIDC_UNAVAILABLE');
      const payload = { schemaVersion, kind: KIND, identity: selected, artifactId, runId, attempt };
      await retainRecord({ phase: 'request-intent', payload });
      const result = await request('POST', `${ROOT}/deployments`, {
        ref: selected.commit,
        task: TASK,
        environment: ENVIRONMENT,
        payload,
        auto_merge: false,
        required_contexts: [],
        transient_environment: false,
        production_environment: false,
        description: `Pages publication intent for ${selected.tag}`,
      });
      if (!numericId(result?.id)) fail('INTENT_RESPONSE_INVALID');
      await retainRecord({ phase: 'intent-created', intentId: String(result.id), payload });
      return String(result.id);
    },
    async submit({ identity: selected, artifactId, intentId }) {
      if (!Number.isSafeInteger(Number(artifactId)) || Number(artifactId) < 1)
        fail('ARTIFACT_ID_INVALID');
      if (!preparedOidcToken) fail('OIDC_UNAVAILABLE');
      const result = await request('POST', `${ROOT}/pages/deployments`, {
        artifact_id: Number(artifactId),
        pages_build_version: selected.commit,
        oidc_token: preparedOidcToken,
      });
      const pagesId = String(result?.id ?? '');
      if (!/^[A-Za-z0-9_-]{1,100}$/u.test(pagesId)) fail('PAGES_RESPONSE_INVALID');
      await retainRecord({ phase: 'pages-created', intentId, pagesId, artifactId });
      return pagesId;
    },
    recordSubmitted: (record) => writeStatus(record, false),
    async observe(pagesId) {
      if (!/^[A-Za-z0-9_-]{1,100}$/u.test(pagesId)) fail('PAGES_ID_INVALID');
      for (let count = 0; count < 60; count++) {
        const result = await request('GET', `${ROOT}/pages/deployments/${pagesId}`);
        if (result?.status === 'succeed') return 'succeeded';
        if (!['deployment_in_progress', 'queued', 'waiting'].includes(result?.status))
          return 'unresolved';
        await sleep(5000);
      }
      return 'unresolved';
    },
    verifyLiveBytes,
    recordVerified: (record) => writeStatus(record, true),
  };
}
