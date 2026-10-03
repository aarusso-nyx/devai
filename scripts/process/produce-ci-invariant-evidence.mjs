// Invariants: INV-HARNESS-006
// Explicit custodian operation. Importing this module never starts a provider or signs.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { canonicalJson } from '../../packages/utils/dist/index.js';
const gateUrl = new URL('../../packages/sensors/dist/ci-invariant-gate.js', import.meta.url);
const gate = await import(
  existsSync(gateUrl)
    ? gateUrl.href
    : new URL('../../packages/sensors/src/ci-invariant-gate.ts', import.meta.url).href
);
const judgeUrl = new URL('../../packages/sensors/dist/judge.js', import.meta.url);
const { senseJudge } = await import(
  existsSync(judgeUrl)
    ? judgeUrl.href
    : new URL('../../packages/sensors/src/judge.ts', import.meta.url).href
);
const canonical = (v) => Buffer.from(canonicalJson(v));
const hash = (v) => createHash('sha256').update(v).digest('hex');
const requireValue = (v) => {
  if (!v) throw new Error('CI_EVIDENCE_PRODUCER_REFUSED');
};
/** The custodian supplies observed effective controls and the separately bounded effect envelope. */
export async function produceCiInvariantEvidence({
  envelope,
  client,
  observeHost,
  signManifest,
  expected,
  rubric,
  thresholds,
  thresholdBytes,
  sourceFiles,
  retainedInputs,
  createdAt,
  invocationId,
}) {
  requireValue(
    envelope?.operation === 'scored-llm-judge' &&
      envelope.invocation_id === invocationId &&
      envelope.candidate &&
      canonical(envelope.candidate).equals(canonical(expected.candidate)),
  );
  requireValue(
    Number.isSafeInteger(envelope.timeout_ms) &&
      envelope.timeout_ms > 0 &&
      envelope.timeout_ms <= 120000 &&
      Number.isSafeInteger(envelope.max_output_bytes) &&
      envelope.max_output_bytes > 0 &&
      envelope.max_output_bytes <= 16 * 1024 * 1024 &&
      Number.isFinite(envelope.max_cost_usd) &&
      envelope.max_cost_usd >= 0,
  );
  requireValue(
    envelope.no_tools === true &&
      envelope.no_mcp === true &&
      typeof observeHost === 'function' &&
      typeof signManifest === 'function' &&
      client &&
      sourceFiles instanceof Map &&
      retainedInputs instanceof Map,
  );
  requireValue(thresholdBytes instanceof Uint8Array);
  const observedThresholdBytes = Buffer.from(thresholdBytes);
  let observedThresholds;
  try {
    observedThresholds = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(observedThresholdBytes),
    );
  } catch {
    throw new Error('CI_EVIDENCE_PRODUCER_REFUSED');
  }
  requireValue(
    canonical(observedThresholds).equals(canonical(thresholds)) &&
      hash(observedThresholdBytes) === expected.boundInputs.thresholds_sha256,
  );
  let response;
  const observedClient = {
    ...client,
    complete: async (...args) => {
      requireValue(response === undefined);
      requireValue(['claude-cli', 'codex-cli'].includes(client.family));
      const [messages, metadata, options] = args;
      response = await client.complete(messages, metadata, {
        ...options,
        timeout_ms: envelope.timeout_ms,
        max_output_bytes: envelope.max_output_bytes,
      });
      requireValue(
        response.text &&
          Buffer.byteLength(response.text) <= envelope.max_output_bytes &&
          response.usage?.cost_usd <= envelope.max_cost_usd,
      );
      return response;
    },
  };
  const started = Date.now();
  const reading = await senseJudge(
    {
      mode: 'scored',
      aspect: 'candidate',
      rubric: JSON.stringify(rubric),
      evidence: JSON.stringify(
        [...sourceFiles].map(([path, bytes]) => ({
          path,
          sha256: hash(bytes),
          text: Buffer.from(bytes).toString('utf8'),
        })),
      ),
      scoredContext: { thresholds, sourceFiles },
    },
    observedClient,
  );
  requireValue(
    Date.now() - started <= envelope.timeout_ms &&
      reading.status === 'pass' &&
      response?.host_observation,
  );
  const host = await observeHost(response.host_observation);
  requireValue(
    Number.isSafeInteger(host.version?.status) &&
      Number.isSafeInteger(host.hostHelp?.status) &&
      gate.verifySoftGateHostObservation(host).status === 'pass',
  );
  const selected = gate.inspectSoftGateHostStream(host.invocation.stdout, host.evaluator.host);
  requireValue(
    Buffer.from(selected.replyBytes).equals(Buffer.from(response.text)) &&
      host.selectedControls.executableSha256 === expected.producerControl.executable_sha256,
  );
  const roles = [
    'score_reply',
    'host_envelope',
    'configuration_observation',
    'inventory_observation',
    'host_help_observation',
    'context_inventory',
    'effective_rubric',
    'effective_thresholds',
    'control_observation',
    'invocation_envelope',
  ];
  const payload_roles = Object.fromEntries(roles.map((r) => [r, `${r}.json`]));
  const members = new Map(retainedInputs);
  requireValue(!members.has('producer-executable.bin') && !members.has('host-version.txt'));
  members.set('producer-executable.bin', Buffer.from(host.executable.bytes));
  members.set('host-version.txt', Buffer.from(host.version.stdout));
  const raw = {
    score_reply: Buffer.from(response.text),
    host_envelope: Buffer.from(host.invocation.stdout),
    configuration_observation: Buffer.from(host.configurationBytes),
    inventory_observation: canonical({
      tools: host.configuration.tools,
      mcp_servers: host.configuration.mcp_servers,
      hooks: host.configuration.hooks,
      plugins: host.configuration.plugins,
      agents: host.configuration.agents,
    }),
    host_help_observation: Buffer.from(host.hostHelp.stdout),
    context_inventory: canonical({
      inheritedConversation: host.configuration.inheritedConversation,
      messages: [],
      agents: [],
    }),
    effective_rubric: canonical(rubric),
    effective_thresholds: observedThresholdBytes,
    // The real probe exit statuses are signed evidence; consumers reopen them, never assume 0.
    control_observation: canonical({
      ...expected.producerControl,
      ...host.selectedControls,
      versionStatus: host.version.status,
      hostHelpStatus: host.hostHelp.status,
    }),
    invocation_envelope: canonical({
      process_instance_id: host.invocation.process_instance_id,
      argv: host.invocation.argv,
      status: host.invocation.status,
      stdout_sha256: hash(host.invocation.stdout),
      stderr_sha256: hash(host.invocation.stderr),
    }),
  };
  for (const role of roles) {
    requireValue(!members.has(payload_roles[role]));
    members.set(payload_roles[role], raw[role]);
  }
  const bound_inputs = { ...expected.boundInputs };
  for (const [role, key] of [
    ['effective_rubric', 'rubric_sha256'],
    ['effective_thresholds', 'thresholds_sha256'],
    ['configuration_observation', 'configuration_sha256'],
    ['inventory_observation', 'inventory_sha256'],
    ['host_help_observation', 'host_help_sha256'],
    ['context_inventory', 'context_sha256'],
  ])
    requireValue(bound_inputs[key] === hash(raw[role]));
  requireValue(
    bound_inputs.source_population_sha256 ===
      hash(
        canonical(
          [...sourceFiles].map(([path, bytes]) => ({
            path,
            byte_length: bytes.length,
            sha256: hash(bytes),
          })),
        ),
      ),
  );
  const manifest = {
    schemaVersion: '1.0.0',
    canonicalization: 'DEVAI-CANONICAL-JSON-V1',
    signature_domain: 'DEVAI-SOFT-GATE-EVIDENCE-V1',
    repository: expected.repository,
    candidate: expected.candidate,
    producer_control: expected.producerControl,
    working_agent: host.workingAgent,
    evaluator: host.evaluator,
    created_at: createdAt,
    invocation_id: invocationId,
    bound_inputs,
    reply_sha256: hash(raw.score_reply),
    host_envelope_sha256: hash(raw.host_envelope),
    score_projection_sha256: hash(canonical(JSON.parse(reading.metrics.score_projection))),
    payload_roles,
    members: [...members]
      .map(([path, bytes]) => ({ path, byte_length: bytes.length, sha256: hash(bytes) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  requireValue(members.size <= 64);
  let total = 0;
  for (const [path, bytes] of members) {
    requireValue(
      gate.containedEvidencePath(path) &&
        bytes instanceof Uint8Array &&
        bytes.length <= 16 * 1024 * 1024,
    );
    total += bytes.length;
  }
  requireValue(
    total <= 32 * 1024 * 1024 &&
      manifest.working_agent.agent_id === expected.workingAgent.agent_id &&
      manifest.working_agent.session_id === expected.workingAgent.session_id &&
      manifest.working_agent.process_instance_id === expected.workingAgent.process_instance_id,
  );
  requireValue(
    Number.isFinite(Date.parse(createdAt)) &&
      Date.parse(createdAt) <= Date.now() &&
      Date.now() - Date.parse(createdAt) <= 24 * 60 * 60 * 1000,
  );
  const manifestBytes = canonical(manifest);
  gate.canonicalEvidenceObject(manifestBytes, 'soft-gate-evidence.schema.json');
  const signature = await signManifest(
    Buffer.concat([Buffer.from('DEVAI-SOFT-GATE-EVIDENCE-V1\n'), manifestBytes]),
  );
  requireValue(signature instanceof Uint8Array && signature.length === 64);
  return {
    manifestBytes,
    signature,
    members,
    payloadSha256: hash(manifestBytes),
    reading,
    hostObservation: host,
  };
}
