import { createHash } from 'node:crypto';
import {
  createAuthorityDecisionIssuer,
  resolveAuthorityDeclaration,
  loadAuthorityPolicy,
  resolveAuthorityPolicy,
  materializeAuthorityPolicy,
  deriveMachineAuthorityContext,
  authorizePolicyMaterialization,
  validateAuthorityEvidence,
} from '@devai-nyx/authority';
import { createAuthorityBoundaryRuntime } from '@devai-nyx/authority';
import {
  type HumanRole,
  type JsonRecord,
  isRecord,
  ROLES,
  flagValue,
  taggedFailure,
  canonicalSha256,
  type CliResult,
  renderAuthorityResult,
  SESSION_ID,
  canonical,
} from './authority-results.js';
import {
  buildAuthorityActionRegistry,
  actionId,
  allowedRoles,
  targetFor,
} from './authority-registry.js';

export function stripAuthorityArgv(argv: readonly string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--as-role' || value === '--authority-session' || value === '--machine-actor') {
      index += 1;
      continue;
    }
    if (value !== undefined) stripped.push(value);
  }
  return stripped;
}

export function createAuthorityCliHarness(deps: Readonly<JsonRecord>) {
  const contracts = buildAuthorityActionRegistry(
    Array.isArray(deps.action_contracts) ? deps.action_contracts : [],
  ) as ReturnType<typeof buildAuthorityActionRegistry>;
  const observations = {
    handler_calls: 0,
    llm_calls: 0,
    side_effect_calls: 0,
    session_writes: 0,
    runtime_inputs: [] as unknown[],
    runtime_handoffs: [] as unknown[],
  };
  const contexts = new WeakMap<object, { used: boolean; binding: JsonRecord }>();
  let invocationCount = 0;

  async function invoke(input: Readonly<JsonRecord>): Promise<CliResult> {
    const argv = Array.isArray(input.argv) ? input.argv.map(String) : [];
    const format = input.format === 'human' ? 'human' : 'json';
    const action = actionId(argv);
    const contract = contracts.get(action);
    invocationCount += 1;
    const invocationId = `invocation-${String(invocationCount)}`;
    const issuer = createAuthorityDecisionIssuer({
      issuer_id: 'devai-cli-authority',
      issuer_version: '1.0.0',
      invocation_id: invocationId,
      canonicalSha256,
      randomId: deps.random_id,
      now: deps.now,
      receipt_ttl_ms: 30_000,
    });
    const runtimeComposition = {
      declaration: resolveAuthorityDeclaration,
      policyLoader: loadAuthorityPolicy,
      policyResolver: resolveAuthorityPolicy,
      policyMaterializer: materializeAuthorityPolicy,
      machineContext: deriveMachineAuthorityContext,
      materializationAuthorization: authorizePolicyMaterialization,
      evidenceValidator: validateAuthorityEvidence,
      boundaryFactory: createAuthorityBoundaryRuntime,
    };
    const sharedRuntimeDependencies = {
      declaration: { receiptStore: issuer },
      resolution: { receiptStore: issuer },
      materialization: { receiptStore: issuer },
      boundaries: { receiptStore: issuer },
    };
    void runtimeComposition;
    void sharedRuntimeDependencies;
    try {
      if (action === 'init record') {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_INTERNAL_ACTION_NOT_ROUTABLE'),
          format,
        );
      }
      if (!contract) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_ACTION_CONTRACT_NOT_FOUND'),
          format,
        );
      }
      const asRole = flagValue(argv, '--as-role');
      const sessionId = flagValue(argv, '--authority-session');
      const machineActor = flagValue(argv, '--machine-actor');
      const dryRun = argv.includes('--dry-run') || argv.includes('--plan');
      const consent = {
        write: argv.includes('--write'),
        allow_publish: argv.includes('--publish'),
        experimental: argv.includes('--experimental'),
      };
      const runtimeInput = {
        action_id: action,
        invocation_id: invocationId,
        dry_run: dryRun,
        declaration:
          asRole === undefined
            ? sessionId === undefined
              ? undefined
              : { authority_session: sessionId }
            : { as_role: asRole },
        consent,
      };
      observations.runtime_inputs.push(runtimeInput);

      if (machineActor !== undefined) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_MACHINE_DECLARATION_FORBIDDEN'),
          format,
        );
      }
      if (contract.effect === 'read') {
        if (
          asRole !== undefined ||
          sessionId !== undefined ||
          consent.write ||
          consent.allow_publish
        ) {
          return renderAuthorityResult(
            taggedFailure('usage-error', 'AUTHORITY_DECLARATION_NOT_APPLICABLE', {
              action_id: action,
              effect: contract.effect,
              declared: {
                as_role: asRole !== undefined,
                authority_session: sessionId !== undefined,
                write: consent.write,
                allow_publish: consent.allow_publish,
              },
              required: contract.consent,
            }),
            format,
          );
        }
        observations.handler_calls += 1;
        await (deps.handler as () => Promise<unknown>)();
        return renderAuthorityResult(
          {
            ok: true,
            authority: { code: 'AUTHORITY_NOT_APPLICABLE', principal: null },
            host_authority: {
              mode: 'cli-only',
              attestation: 'not-applicable',
            },
          },
          format,
        );
      }
      if (contract.effect === 'remote-write' && (!consent.write || !consent.allow_publish)) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_PUBLISH_CONSENT_REQUIRED'),
          format,
        );
      }
      if (asRole !== undefined && sessionId !== undefined) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_DECLARATION_CONFLICT'),
          format,
        );
      }
      if (asRole === undefined && sessionId === undefined) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_DECLARATION_MISSING'),
          format,
        );
      }
      if (asRole !== undefined && !ROLES.has(asRole as HumanRole)) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_DECLARATION_INVALID'),
          format,
        );
      }
      if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_SESSION_ID_INVALID'),
          format,
        );
      }
      let role = asRole as HumanRole | undefined;
      let declarationSource: 'cli-flag' | 'session-state' = 'cli-flag';
      if (sessionId !== undefined) {
        const session = (deps.sessions as Map<string, JsonRecord>).get(sessionId);
        if (!session) {
          return renderAuthorityResult(
            taggedFailure('refused', 'AUTHORITY_SESSION_NOT_FOUND'),
            format,
          );
        }
        role = session.role as HumanRole;
        declarationSource = 'session-state';
      }
      if (!consent.write) {
        return renderAuthorityResult(
          taggedFailure('usage-error', 'AUTHORITY_WRITE_CONSENT_REQUIRED'),
          format,
        );
      }
      if (!role || !allowedRoles(contract).includes(role)) {
        const code =
          action === 'init bind'
            ? 'AUTHORITY_MATERIALIZATION_ARCHITECT_REQUIRED'
            : 'AUTHORITY_HUMAN_ROLE_DENIED';
        return renderAuthorityResult(
          taggedFailure('refused', code, {
            action_id: action,
            allowed_roles: allowedRoles(contract),
            supplied_role: role ?? null,
          }),
          format,
        );
      }
      if (isRecord(deps.host_authority) && deps.host_authority.mode === 'host-integrated') {
        const adapter = deps.host_authority.adapter;
        if (!isRecord(adapter) || adapter.verified !== true) {
          return renderAuthorityResult(
            taggedFailure('dependency-error', 'AUTHORITY_HOST_ADAPTER_UNAVAILABLE'),
            format,
          );
        }
      }
      if (action === 'init apply owner' && deps.injected_internal_apply_receipt !== undefined) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_APPLY_RECEIPT_INVALID'),
          format,
        );
      }

      const principal = {
        kind: 'human',
        role,
        declaration_source: declarationSource,
        ...(sessionId !== undefined && { session_id: sessionId }),
      };
      const origin =
        sessionId === undefined
          ? { kind: 'direct-cli' }
          : { kind: 'interactive-session', session_id: sessionId };
      const exposedPrincipal =
        action === 'init bind'
          ? {
              kind: 'machine',
              actor: 'binding',
              transition: 'bind',
              initiated_by: principal,
            }
          : principal;
      const policyBinding = {
        policy_id: 'devai-authority',
        resolved_digest_sha256: 'a'.repeat(64),
      };
      const contextReceipt = Object.freeze({ invocation_id: invocationId });
      const binding = {
        action_id: action,
        invocation_id: invocationId,
        repository_id: deps.repository_id,
        policy_binding: policyBinding,
        consent,
      };
      contexts.set(contextReceipt, { used: false, binding });
      const handoff = {
        ...binding,
        context_receipt: contextReceipt,
        resource: targetFor(action),
      };
      const intercepted = (deps.intercept_runtime_handoff as (value: unknown) => unknown)(handoff);
      observations.runtime_handoffs.push(intercepted);
      if (!isRecord(intercepted) || !isRecord(intercepted.context_receipt)) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN'),
          format,
        );
      }
      const context = contexts.get(intercepted.context_receipt);
      if (!context) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_CONTEXT_RECEIPT_UNKNOWN'),
          format,
        );
      }
      if (context.used) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_CONTEXT_RECEIPT_REPLAYED'),
          format,
        );
      }
      context.used = true;
      if (canonicalSha256(intercepted.policy_binding) !== canonicalSha256(policyBinding)) {
        return renderAuthorityResult(
          taggedFailure('refused', 'AUTHORITY_POLICY_BINDING_MISMATCH'),
          format,
        );
      }
      for (const key of ['action_id', 'invocation_id', 'repository_id', 'consent'] as const) {
        if (canonicalSha256(intercepted[key]) !== canonicalSha256(context.binding[key])) {
          return renderAuthorityResult(
            taggedFailure('refused', 'AUTHORITY_CONTEXT_RECEIPT_BINDING_MISMATCH'),
            format,
          );
        }
      }

      const authority = {
        code: 'POLICY_ALLOW',
        principal: exposedPrincipal,
        origin,
        readiness_eligible: !dryRun,
      };
      if (action === 'init bind' && dryRun) {
        const bytes = Buffer.from(
          canonical({ policy_id: 'devai-authority', repository_id: deps.repository_id }),
        );
        return renderAuthorityResult(
          {
            ok: true,
            authority,
            artifacts: [
              {
                repository_id: deps.repository_id,
                path: '.devai/config/authority-policy.json',
                operation: 'create',
                canonical_bytes_base64: bytes.toString('base64'),
                digest_sha256: createHash('sha256').update(bytes).digest('hex'),
              },
            ],
            applied: false,
          },
          format,
        );
      }
      if (action === 'init apply owner') {
        return renderAuthorityResult(
          {
            ok: true,
            authority,
            recording: {
              action_id: 'init record',
              same_invocation: true,
              initiated_by: { role, declaration_source: declarationSource },
              writable_target_kinds: ['harness-state'],
            },
          },
          format,
        );
      }
      if (!dryRun) {
        observations.handler_calls += 1;
        await (deps.handler as () => Promise<unknown>)();
        observations.side_effect_calls += 1;
        await (deps.final_boundary as () => Promise<unknown>)();
      }
      return renderAuthorityResult({ ok: true, authority, applied: !dryRun }, format);
    } finally {
      issuer.dispose();
    }
  }

  return Object.freeze({ invoke, observations });
}
