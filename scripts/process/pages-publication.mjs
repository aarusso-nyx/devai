// Repository-local publication control. Callers must serialize ALL Pages writers,
// independently verify retained site bytes, and authenticate the complete journal.
// No build, packaging, site generation, or automatic deployment cancellation.
import { createHash } from 'node:crypto';

function fail(code) {
  throw new Error(`PAGES_PUBLICATION_${code}`);
}
function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}
function identityBytes(identity) {
  const keys = [
    'repository',
    'tag',
    'commit',
    'tree',
    'rehearsalRun',
    'rehearsalAttempt',
    'manifestSha256',
    'siteSha256',
    'controlCommit',
  ];
  if (
    !exactKeys(identity, keys) ||
    keys.some((key) => typeof identity[key] !== 'string') ||
    identity.repository !== 'aarusso-nyx/devai' ||
    !/^v\d+\.\d+\.\d+$/u.test(identity.tag) ||
    ['commit', 'tree', 'controlCommit'].some((key) => !/^[a-f0-9]{40}$/u.test(identity[key])) ||
    ['manifestSha256', 'siteSha256'].some((key) => !/^[a-f0-9]{64}$/u.test(identity[key])) ||
    ['rehearsalRun', 'rehearsalAttempt'].some((key) => !/^[1-9][0-9]*$/u.test(identity[key]))
  )
    fail('IDENTITY_INVALID');
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, identity[key]])));
}
function journalRecord(value, identity) {
  if (
    !exactKeys(value, ['schemaVersion', 'identity', 'intentId', 'artifactId', 'pagesId', 'phase'])
  )
    fail('JOURNAL_INVALID');
  if (
    value.schemaVersion !== '1.0.0' ||
    typeof value.artifactId !== 'string' ||
    !/^[1-9][0-9]*$/u.test(value.artifactId) ||
    typeof value.intentId !== 'string' ||
    identityBytes(value.identity) !== identityBytes(identity) ||
    !/^[1-9][0-9]*$/u.test(value.intentId) ||
    !['intent', 'submitted', 'verified'].includes(value.phase) ||
    (value.phase === 'intent'
      ? value.pagesId !== null
      : typeof value.pagesId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.pagesId))
  )
    fail('JOURNAL_INVALID');
  return value;
}

/**
 * Controls are approved host capabilities, never candidate-supplied callbacks.
 * readJournal must authenticate a complete collection for this exact tag and
 * reject duplicate/conflicting status histories. Writes must be durable before
 * returning. readEffect returns matching, confirmed-missing, or unknown; missing
 * requires authenticated external-state reconciliation, NOT HTTP 404 alone.
 * A migration audit must cover writers predating this journal. Exceptions and
 * unknown outcomes deliberately preserve the existing intent for reconciliation.
 */
export async function publishPages({ identity, artifactId, controls }) {
  const serialized = identityBytes(identity);
  if (typeof artifactId !== 'string' || !/^[1-9][0-9]*$/u.test(artifactId))
    fail('ARTIFACT_INVALID');
  const digest = createHash('sha256').update(serialized).digest('hex');
  const journal = await controls.readJournal(identity);
  if (
    !exactKeys(journal, ['complete', 'migrationAudited', 'records']) ||
    journal.complete !== true ||
    journal.migrationAudited !== true ||
    !Array.isArray(journal.records) ||
    journal.records.length > 1
  )
    fail('JOURNAL_UNKNOWN');
  let record = journal.records.length ? journalRecord(journal.records[0], identity) : null;
  const effect = await controls.readEffect(identity);
  if (!['matching', 'confirmed-missing', 'unknown'].includes(effect)) fail('EFFECT_UNKNOWN');
  if (effect === 'matching')
    return { outcome: 'no-op', identitySha256: digest, buildInvocations: 0 };
  if (record?.phase === 'verified') fail('VERIFIED_EFFECT_MISSING');
  if (record?.phase === 'intent') fail('SUBMISSION_UNKNOWN');
  if (!record) {
    if (effect !== 'confirmed-missing') fail('EFFECT_UNKNOWN');
    const intentId = await controls.createIntent({ schemaVersion: '1.0.0', identity, artifactId });
    record = journalRecord(
      { schemaVersion: '1.0.0', identity, intentId, artifactId, pagesId: null, phase: 'intent' },
      identity,
    );
    // Read-after-write catches incomplete persistence before the irreversible POST.
    const persisted = await controls.readJournal(identity);
    if (
      persisted.complete !== true ||
      persisted.migrationAudited !== true ||
      !Array.isArray(persisted.records) ||
      persisted.records.length !== 1 ||
      !['intentId', 'artifactId', 'pagesId', 'phase'].every(
        (key) => journalRecord(persisted.records[0], identity)[key] === record[key],
      )
    )
      fail('INTENT_NOT_DURABLE');
    const pagesId = await controls.submit({ identity, artifactId, intentId });
    record = journalRecord({ ...record, pagesId, phase: 'submitted' }, identity);
    await controls.recordSubmitted(record);
  }
  // Retrying a known submission may only observe that exact Pages deployment.
  const result = await controls.observe(record.pagesId);
  if (result !== 'succeeded') fail('DEPLOYMENT_UNRESOLVED');
  await controls.verifyLiveBytes(identity);
  await controls.recordVerified({ ...record, phase: 'verified' });
  return {
    outcome: 'verified',
    pagesId: record.pagesId,
    identitySha256: digest,
    buildInvocations: 0,
  };
}
