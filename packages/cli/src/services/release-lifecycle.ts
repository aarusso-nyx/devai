import { parsers } from '@devai-nyx/schemas';
import { canonicalSha256 } from '@devai-nyx/utils';
import {
  finalizeReleasePlanReceipt,
  verifyReleasePlanReceiptIdentity,
  type ReleaseCandidateIdentity,
  type ReleaseIdentity,
  type ReleasePlanReceipt,
} from '@devai-nyx/loop';
import { resolveReleaseVerification } from './release-profile.js';
import {
  isVerifiedReleasePolicyResolution,
  type VerifiedReleasePolicyResolution,
} from './release-policy-resolution.js';

export interface ReleaseIntentDocument {
  readonly schemaVersion: '1.0.0';
  readonly release_unit: string;
  readonly current_version: string;
  readonly target_version: string;
  readonly support: 'preview' | 'current' | 'lts';
  readonly support_promotion?: boolean;
  readonly change_kind?: 'documentation' | 'metadata' | 'behavioral';
  readonly changed_paths: readonly string[];
  readonly changed_packages: readonly string[];
  readonly risks?: readonly string[];
  readonly owner_escalations?: readonly string[];
  readonly candidate: { readonly commit: string; readonly tree: string };
  readonly base: { readonly commit: string; readonly tree: string };
}

interface ReleaseVerificationProfileDocument {
  readonly risk_capabilities?: Readonly<Record<string, readonly never[]>>;
  readonly mutation_roster: readonly unknown[];
}

interface ReleaseLifecyclePolicyDocument {
  readonly plan_determination: {
    readonly required_inputs: readonly {
      readonly order: number;
      readonly kind: string;
      readonly source: string;
      readonly schema: string;
      readonly canonical_bytes: string;
      readonly origin?: string;
      readonly path?: string;
    }[];
  };
  readonly states: readonly {
    readonly state: string;
    readonly order: number;
    readonly produced_by_action: string | null;
    readonly derived_by_action: string | null;
  }[];
}

const PLAN_CANONICALIZATION = {
  kernel_id: 'devai.kernel.release-plan-receipt-canonicalization.v1',
  encoding: 'utf-8',
  json_form: 'rfc8785-jcs',
  digest_algorithm: 'sha256',
  receipt_projection_excludes: ['receipt_id', 'receipt_digest_sha256'],
  calculation_order: [
    'compute-receipt_digest_sha256-over-the-receipt-projection',
    'derive-receipt_id-as-RPL-hyphen-plus-the-first-16-lowercase-hex-characters-of-receipt_digest_sha256',
  ],
} as const;

const PLAN_KERNEL = {
  kernel_id: 'devai.kernel.release-plan-receipt.v2',
  mandatory: true,
  determination_contract: 'law/policy/release-lifecycle.json#/plan_determination',
  schema_assertion_establishes_pass: false,
  algorithm: [
    'resolve-every-declared-input-and-recompute-its-sha256',
    'require-the-exact-four-ordered-input-kinds-sources-schemas-paths-and-utf-8-rfc8785-jcs-sha256-digests-declared-by-plan_determination',
    'recompute-verdict-profile_verdict-transition-support-impact-risk_classes-capabilities-mutation-mutation_disposition-and-blocking_reasons-under-plan_determination-and-compare-to-the-reported-values',
    'recompute-the-nine-ordered-plan-steps-for-pass-or-the-empty-plan-for-block-from-the-lifecycle-policy-and-compare-to-plan',
    'recompute-receipt_digest_sha256-under-devai.kernel.release-plan-receipt-canonicalization.v1',
    'recompute-receipt_id-as-RPL-hyphen-plus-the-first-16-lowercase-hex-characters-of-the-recomputed-receipt-digest',
    'reject-pass-when-any-recomputed-value-differs-from-the-reported-value',
  ],
  errors: [
    'rpl-input-unresolved',
    'rpl-input-digest-mismatch',
    'rpl-input-set-mismatch',
    'rpl-determination-mismatch',
    'rpl-plan-mismatch',
    'rpl-receipt-digest-mismatch',
    'rpl-receipt-id-mismatch',
    'rpl-semantic-verification-not-performed',
  ],
} as const;

const PLAN_KERNEL_V3 = {
  ...PLAN_KERNEL,
  kernel_id: 'devai.kernel.release-plan-receipt.v3',
  determination_contract: 'dist/law/policy/release-lifecycle.json#/plan_determination',
  algorithm: [
    'verify-policy-resolution-against-external-expected-package-candidate-and-complete-binding-evidence-before-resolving-inputs',
    ...PLAN_KERNEL.algorithm.map((step, index) =>
      index === 1
        ? 'require-the-exact-four-ordered-input-kinds-origins-sources-schemas-paths-and-utf-8-rfc8785-jcs-sha256-digests-declared-by-plan_determination'
        : step,
    ),
  ],
  errors: [
    ...PLAN_KERNEL.errors,
    'rpl-policy-source-unresolved',
    'rpl-package-identity-mismatch',
    'rpl-adopter-binding-mismatch',
    'rpl-policy-resolution-mismatch',
    'rpl-legacy-plan-non-authoritative',
  ],
} as const;

function inputPath(kind: string, intentPath: string, source: string): string {
  return kind === 'release-intent' ? intentPath : source;
}

export function buildReleasePlanReceipt(input: {
  readonly repository_id: string;
  readonly intent_path?: string;
  readonly intent: unknown;
  readonly release_verification_profile: unknown;
  readonly release_lifecycle_policy: unknown;
  readonly action_registry: unknown;
  readonly resolution?: VerifiedReleasePolicyResolution;
}): ReleasePlanReceipt {
  const resolution = input.resolution;
  if (resolution !== undefined && !isVerifiedReleasePolicyResolution(resolution))
    throw new Error('rpl-policy-resolution-mismatch');
  if (resolution === undefined && input.intent_path === undefined)
    throw new Error('rpl-input-unresolved');
  const intent =
    resolution === undefined
      ? parsers.releaseIntent.parse<ReleaseIntentDocument>(input.intent)
      : resolution.tools.parse<ReleaseIntentDocument>('release-intent.schema.json', input.intent);
  const profile =
    resolution === undefined
      ? parsers.releaseVerificationProfile.parse<ReleaseVerificationProfileDocument>(
          input.release_verification_profile,
        )
      : resolution.tools.parse<ReleaseVerificationProfileDocument>(
          'release-verification-profile.schema.json',
          input.release_verification_profile,
        );
  const lifecycle =
    resolution === undefined
      ? parsers.releaseLifecyclePolicy.parse<ReleaseLifecyclePolicyDocument>(
          input.release_lifecycle_policy,
        )
      : resolution.tools.parse<ReleaseLifecyclePolicyDocument>(
          'release-lifecycle-policy.schema.json',
          input.release_lifecycle_policy,
        );
  if (resolution === undefined) parsers.actionRegistry.parse(input.action_registry);
  else {
    resolution.tools.parse('action-registry.schema.json', input.action_registry);
    if (
      resolution.repository.id !== input.repository_id ||
      resolution.repository.commit !== intent.candidate.commit ||
      resolution.repository.tree !== intent.candidate.tree ||
      resolution.release_unit !== intent.release_unit ||
      canonicalSha256(resolution.readInput('release-verification-profile')) !==
        canonicalSha256(input.release_verification_profile) ||
      canonicalSha256(resolution.readInput('release-lifecycle-policy')) !==
        canonicalSha256(input.release_lifecycle_policy) ||
      canonicalSha256(resolution.readInput('action-registry-policy')) !==
        canonicalSha256(input.action_registry)
    )
      throw new Error('rpl-policy-resolution-mismatch');
  }

  const documents = new Map<string, unknown>([
    ['release-intent', intent],
    ['release-verification-profile', input.release_verification_profile],
    ['release-lifecycle-policy', lifecycle],
    ['action-registry-policy', input.action_registry],
  ]);
  const requiredInputs = [...lifecycle.plan_determination.required_inputs].sort(
    (left, right) => left.order - right.order,
  );
  const inputs = requiredInputs.map((required) => {
    const document = documents.get(required.kind);
    if (document === undefined) throw new Error(`RELEASE_PLAN_INPUT_UNRESOLVED:${required.kind}`);
    return {
      kind: required.kind,
      source: required.source,
      schema: required.schema,
      ...(resolution === undefined
        ? { path: inputPath(required.kind, input.intent_path ?? '', required.source) }
        : {
            origin: required.origin,
            ...(required.kind === 'release-intent' ? {} : { path: required.path }),
          }),
      canonical_bytes: required.canonical_bytes,
      ...(required.kind === 'release-intent' ? { inline_document: intent } : {}),
      sha256: canonicalSha256(document),
    };
  });
  const decision = resolveReleaseVerification({
    currentVersion: intent.current_version,
    targetVersion: intent.target_version,
    support: intent.support,
    mutationRosterSize: profile.mutation_roster.length,
    riskCapabilities: profile.risk_capabilities,
    ...(intent.support_promotion === undefined
      ? {}
      : { supportPromotion: intent.support_promotion }),
    ...(intent.change_kind === undefined ? {} : { changeKind: intent.change_kind }),
    ...(intent.risks === undefined ? {} : { risks: intent.risks }),
    ...(intent.owner_escalations === undefined
      ? {}
      : { ownerEscalations: intent.owner_escalations as never[] }),
  });
  const passed = decision.verdict === 'ready';
  const repository: ReleaseIdentity = {
    id: input.repository_id,
    commit: intent.candidate.commit,
    tree: intent.candidate.tree,
  };
  const candidate: ReleaseCandidateIdentity = {
    release_unit: intent.release_unit,
    version: intent.target_version,
    commit: intent.candidate.commit,
    tree: intent.candidate.tree,
  };
  const plan = passed
    ? [...lifecycle.states]
        .sort((left, right) => left.order - right.order)
        .map((state) => ({
          order: state.order,
          action_id: state.produced_by_action ?? state.derived_by_action,
          produces_state: state.produced_by_action === null ? null : state.state,
          derives_state: state.derived_by_action === null ? null : state.state,
        }))
    : [];
  const blockingReason = decision.blockingReasons[0];
  const draft = {
    schemaVersion: resolution === undefined ? '1.0.0' : '2.0.0',
    receipt_kind: 'release-plan-receipt',
    canonicalization: PLAN_CANONICALIZATION,
    state_observed: passed ? 'planned' : null,
    verdict: passed ? 'pass' : 'block',
    repository,
    candidate,
    inputs,
    plan,
    determination: {
      profile_verdict: passed ? 'ready' : 'block',
      transition: decision.transition ?? null,
      support: decision.support,
      impact: intent.change_kind ?? 'behavioral',
      risk_classes: [...(intent.risks ?? [])].sort(),
      capabilities: passed ? decision.capabilities : [],
      mutation: passed ? decision.mutation : 'none',
      mutation_disposition: {
        status: passed ? decision.mutationDisposition.status : 'blocked',
        reason: passed
          ? decision.mutationDisposition.reason
          : (blockingReason ?? decision.mutationDisposition.reason),
      },
      blocking_reasons: decision.blockingReasons,
    },
    verification_kernel: resolution === undefined ? PLAN_KERNEL : PLAN_KERNEL_V3,
    ...(resolution === undefined ? {} : { policy_resolution: resolution.resolution }),
    emitted_by: {
      action_id: 'release plan',
      effect: 'read',
      output_channel: 'stdout',
      persists_repository_state: false,
      appends_state_record: false,
      writes_receipt_file: false,
    },
    grants: {
      authority: false,
      publication_authority: false,
      lifecycle_transition: false,
      satisfies_state: false,
    },
    determinism: {
      deterministic: true,
      derived_from_bound_inputs_only: true,
      contains_wall_clock_time: false,
    },
  };
  if (resolution === undefined) return finalizeReleasePlanReceipt(draft as never);
  const digest = canonicalSha256(draft);
  return resolution.tools.parse<ReleasePlanReceipt>('release-plan-receipt-v2.schema.json', {
    ...draft,
    receipt_id: `RPL-${digest.slice(0, 16)}`,
    receipt_digest_sha256: digest,
  });
}

export function buildResolvedReleasePlanReceipt(input: {
  readonly intent: unknown;
  readonly resolution: VerifiedReleasePolicyResolution;
}): ReleasePlanReceipt {
  if (!isVerifiedReleasePolicyResolution(input.resolution))
    throw new Error('rpl-policy-resolution-mismatch');
  return buildReleasePlanReceipt({
    repository_id: input.resolution.repository.id,
    intent: input.intent,
    resolution: input.resolution,
    release_verification_profile: input.resolution.readInput('release-verification-profile'),
    release_lifecycle_policy: input.resolution.readInput('release-lifecycle-policy'),
    action_registry: input.resolution.readInput('action-registry-policy'),
  });
}

export function verifyResolvedReleasePlanReceipt(input: {
  readonly receipt: unknown;
  readonly resolution: VerifiedReleasePolicyResolution;
}): boolean {
  try {
    if (!isVerifiedReleasePolicyResolution(input.resolution)) return false;
    const receipt = input.resolution.tools.parse<ReleasePlanReceipt>(
      'release-plan-receipt-v2.schema.json',
      input.receipt,
    );
    const inputs = receipt['inputs'] as readonly { readonly inline_document?: unknown }[];
    const expected = buildResolvedReleasePlanReceipt({
      intent: inputs[0]?.inline_document,
      resolution: input.resolution,
    });
    return canonicalSha256(expected) === canonicalSha256(receipt);
  } catch {
    return false;
  }
}

export function verifyReleasePlanReceipt(input: {
  readonly receipt: unknown;
  readonly repository_id: string;
  readonly intent_path: string;
  readonly intent: unknown;
  readonly release_verification_profile: unknown;
  readonly release_lifecycle_policy: unknown;
  readonly action_registry: unknown;
}): boolean {
  if (!verifyReleasePlanReceiptIdentity(input.receipt)) return false;
  let expected: ReleasePlanReceipt;
  try {
    expected = buildReleasePlanReceipt(input);
  } catch {
    return false;
  }
  return canonicalSha256(expected) === canonicalSha256(input.receipt);
}
