export type VersionTransition = 'patch' | 'minor' | 'major' | 'prerelease' | 'support-promotion';
export type SupportIntention = 'preview' | 'current' | 'lts';
export type ChangeKind = 'documentation' | 'metadata' | 'behavioral';
export type PrereleaseRung = 'alpha' | 'beta' | 'rc';
export type ReleaseChannel = PrereleaseRung | 'stable';
export type MutationRequirement = 'none' | 'affected' | 'targeted' | 'full-roster';
export type ReleaseCapability =
  | 'formatting-hygiene'
  | 'lint'
  | 'type-integrity'
  | 'schema-consistency'
  | 'secret-scan'
  | 'path-portability'
  | 'exact-candidate'
  | 'affected-checks'
  | 'dependent-checks'
  | 'build-integrity'
  | 'unit'
  | 'integration'
  | 'e2e'
  | 'consumer'
  | 'api-compatibility'
  | 'migration'
  | 'rollback'
  | 'package-integrity'
  | 'adopter-materialization'
  | 'security'
  | 'database'
  | 'tenancy'
  | 'provenance'
  | 'reproducibility'
  | 'operational-matrix';
export type KnownRiskClass =
  | 'authentication'
  | 'authorization'
  | 'tenancy'
  | 'rls'
  | 'cryptography'
  | 'secrets'
  | 'credentials'
  | 'database'
  | 'migration'
  | 'release-integrity'
  | 'evidence'
  | 'provenance'
  | 'publication'
  | 'ledger'
  | 'mutation-policy'
  | 'test-policy'
  | 'test-configuration'
  | 'sanitization'
  | 'public-api'
  | 'export-map'
  | 'package-boundary'
  | 'lockfile'
  | 'toolchain'
  | 'cross-package'
  | 'large-change'
  | 'protected-resource';

export interface ReleaseVerificationInput {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly support: SupportIntention;
  readonly supportPromotion?: boolean;
  readonly changeKind?: ChangeKind;
  readonly changedPaths?: readonly string[];
  readonly changedPackages?: readonly string[];
  readonly risks?: readonly string[];
  readonly ownerEscalations?: readonly ReleaseCapability[];
  readonly riskCapabilities?: Readonly<Record<string, readonly ReleaseCapability[]>>;
  readonly mutationRosterSize?: number;
  readonly channel?: ReleaseChannel;
}

export interface ReleaseVerificationDecision {
  readonly schemaVersion: '1.0.0';
  readonly verdict: 'ready' | 'review' | 'block';
  readonly transition?: VersionTransition;
  readonly support: SupportIntention;
  readonly capabilities: readonly ReleaseCapability[];
  readonly mutation: MutationRequirement;
  readonly mutationDisposition: Readonly<{
    status: 'required' | 'not-required' | 'blocked';
    reason: string;
  }>;
  readonly blockingReasons: readonly string[];
}

export interface MutationRosterEntry {
  readonly id: string;
  readonly package: string;
  readonly task_node: string;
  readonly risk_classes?: readonly string[];
  readonly source_selectors?: readonly string[];
  readonly test_selectors?: readonly string[];
  readonly manifest_path?: string;
  readonly config_paths?: readonly string[];
  readonly vitest_config_path?: string;
  readonly typescript_config_path?: string;
  readonly sanitizer_paths?: readonly string[];
  readonly orchestration_paths?: readonly string[];
  readonly lockfile_path?: string;
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const KNOWN_RISKS = new Set<KnownRiskClass>([
  'authentication',
  'authorization',
  'tenancy',
  'rls',
  'cryptography',
  'secrets',
  'credentials',
  'database',
  'migration',
  'release-integrity',
  'evidence',
  'provenance',
  'publication',
  'ledger',
  'mutation-policy',
  'test-policy',
  'test-configuration',
  'sanitization',
  'public-api',
  'export-map',
  'package-boundary',
  'lockfile',
  'toolchain',
  'cross-package',
  'large-change',
  'protected-resource',
]);
const UNCONDITIONAL_FLOOR: readonly ReleaseCapability[] = [
  'formatting-hygiene',
  'lint',
  'type-integrity',
  'schema-consistency',
  'secret-scan',
  'path-portability',
  'package-integrity',
  'exact-candidate',
];
const TRANSITION_CAPABILITIES: Record<VersionTransition, readonly ReleaseCapability[]> = {
  patch: ['affected-checks', 'dependent-checks', 'build-integrity'],
  prerelease: ['affected-checks', 'dependent-checks', 'build-integrity'],
  minor: ['unit', 'integration', 'e2e', 'consumer', 'api-compatibility', 'adopter-materialization'],
  major: [
    'unit',
    'integration',
    'e2e',
    'consumer',
    'api-compatibility',
    'migration',
    'rollback',
    'adopter-materialization',
    'security',
    'database',
    'tenancy',
    'provenance',
    'reproducibility',
  ],
  'support-promotion': [
    'unit',
    'integration',
    'e2e',
    'consumer',
    'api-compatibility',
    'migration',
    'rollback',
    'adopter-materialization',
    'security',
    'database',
    'tenancy',
    'provenance',
    'reproducibility',
    'operational-matrix',
  ],
};
const LTS_CAPABILITIES: readonly ReleaseCapability[] = [
  'unit',
  'integration',
  'e2e',
  'consumer',
  'api-compatibility',
  'migration',
  'rollback',
  'adopter-materialization',
  'security',
  'database',
  'tenancy',
  'provenance',
  'reproducibility',
  'operational-matrix',
];

/**
 * Prerelease channel ladder mirrored from
 * law/policy/release-lifecycle.json#/plan_determination/prerelease_ladder
 * (ADR-REL-0028). The identifier pattern, rung order, stable_from rung, and
 * per-rung required capabilities must stay equal to that policy.
 */
const PRERELEASE_IDENTIFIER = /^(alpha|beta|rc)\.(0|[1-9][0-9]*)$/u;
const RUNG_ORDER: readonly PrereleaseRung[] = ['alpha', 'beta', 'rc'];
const STABLE_FROM: PrereleaseRung = 'rc';
const RUNG_CAPABILITIES: Record<PrereleaseRung, readonly ReleaseCapability[]> = {
  alpha: [...UNCONDITIONAL_FLOOR, 'affected-checks', 'dependent-checks'],
  beta: [...UNCONDITIONAL_FLOOR, 'affected-checks', 'dependent-checks', 'unit', 'integration'],
  rc: [
    ...UNCONDITIONAL_FLOOR,
    'affected-checks',
    'dependent-checks',
    'unit',
    'integration',
    'e2e',
    'consumer',
    'api-compatibility',
    'migration',
    'rollback',
    'adopter-materialization',
    'security',
    'database',
    'tenancy',
    'provenance',
    'reproducibility',
  ],
};

interface RungPosition {
  readonly rung: PrereleaseRung;
  readonly suffix: number;
}

/**
 * Resolve the ladder rung of a parsed version: `null` for a stable version,
 * `undefined` for a prerelease identifier outside the ladder.
 */
function resolveRung(version: ParsedVersion): RungPosition | null | undefined {
  if (version.prerelease.length === 0) return null;
  const match = PRERELEASE_IDENTIFIER.exec(version.prerelease.join('.'));
  if (match === null) return undefined;
  return { rung: match[1] as PrereleaseRung, suffix: Number(match[2]) };
}

function sameCore(left: ParsedVersion, right: ParsedVersion): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

/**
 * Promotion within one version core: a same-rung suffix increment, the next
 * rung only, or stable from the stable_from rung. Anything else is a downgrade.
 */
function ladderPromotionAllowed(
  current: RungPosition | null,
  target: RungPosition | null,
): boolean {
  if (current === null) return target === null;
  if (target === null) return current.rung === STABLE_FROM;
  if (current.rung === target.rung) return target.suffix > current.suffix;
  return RUNG_ORDER.indexOf(target.rung) === RUNG_ORDER.indexOf(current.rung) + 1;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = SEMVER.exec(value);
  if (match === null) return undefined;
  const prerelease = (match[4] ?? '')
    .split('.')
    .filter(Boolean)
    .map((identifier) => (/^\d+$/u.test(identifier) ? Number(identifier) : identifier));
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease };
}

function comparePrerelease(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'string') return -1;
    if (typeof a === 'string' && typeof b === 'number') return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function classifyTransition(
  current: ParsedVersion,
  target: ParsedVersion,
  promotion: boolean,
): VersionTransition | undefined {
  const comparison = compareVersions(current, target);
  if (comparison === 0) return promotion ? 'support-promotion' : undefined;
  if (comparison > 0) return undefined;
  if (current.prerelease.length > 0 || target.prerelease.length > 0) return 'prerelease';
  if (current.major !== target.major) return 'major';
  if (current.minor !== target.minor) return 'minor';
  return 'patch';
}

function blocked(input: ReleaseVerificationInput, reason: string): ReleaseVerificationDecision {
  return {
    schemaVersion: '1.0.0',
    verdict: 'block',
    support: input.support,
    capabilities: [],
    mutation: 'none',
    mutationDisposition: { status: 'blocked', reason: 'policy-invalid' },
    blockingReasons: [reason],
  };
}

function addRiskCapabilities(
  capabilities: Set<ReleaseCapability>,
  risks: readonly KnownRiskClass[],
): void {
  if (risks.length > 0) {
    capabilities.add('security');
    capabilities.add('integration');
  }
  if (risks.some((risk) => ['tenancy', 'rls'].includes(risk))) capabilities.add('tenancy');
  if (risks.some((risk) => ['database', 'migration'].includes(risk))) capabilities.add('database');
  if (risks.some((risk) => ['public-api', 'export-map', 'package-boundary'].includes(risk))) {
    capabilities.add('api-compatibility');
    capabilities.add('consumer');
  }
  if (
    risks.some((risk) =>
      ['release-integrity', 'evidence', 'provenance', 'publication', 'ledger'].includes(risk),
    )
  ) {
    capabilities.add('provenance');
    capabilities.add('reproducibility');
  }
  if (
    risks.some((risk) => ['lockfile', 'toolchain', 'cross-package', 'large-change'].includes(risk))
  ) {
    capabilities.add('integration');
    capabilities.add('consumer');
  }
}

export function resolveReleaseVerification(
  input: ReleaseVerificationInput,
): ReleaseVerificationDecision {
  const current = parseVersion(input.currentVersion);
  const target = parseVersion(input.targetVersion);
  if (current === undefined || target === undefined) return blocked(input, 'invalid-semver');
  const currentRung = resolveRung(current);
  const targetRung = resolveRung(target);
  if (currentRung === undefined || targetRung === undefined)
    return blocked(input, 'invalid-semver');
  const order = compareVersions(current, target);
  if (order > 0) return blocked(input, 'downgrade');
  if (order < 0 && sameCore(current, target) && !ladderPromotionAllowed(currentRung, targetRung))
    return blocked(input, 'downgrade');
  const transition = classifyTransition(current, target, input.supportPromotion === true);
  if (transition === undefined) return blocked(input, 'same-version-without-support-promotion');
  if (transition === 'support-promotion' && input.support !== 'lts')
    return blocked(input, 'support-promotion-requires-lts');
  const channel: ReleaseChannel = targetRung === null ? 'stable' : targetRung.rung;
  if (input.channel !== undefined && input.channel !== channel)
    return blocked(input, 'channel-mismatch');
  const declaredRiskClasses = new Set(Object.keys(input.riskCapabilities ?? {}));
  const unknownRisks = (input.risks ?? []).filter(
    (risk) => !KNOWN_RISKS.has(risk as KnownRiskClass) && !declaredRiskClasses.has(risk),
  );
  if (unknownRisks.length > 0)
    return blocked(input, `unknown-risk:${unknownRisks.sort().join(',')}`);
  const risks = (input.risks ?? []) as readonly KnownRiskClass[];
  const capabilities = new Set<ReleaseCapability>([
    ...UNCONDITIONAL_FLOOR,
    ...TRANSITION_CAPABILITIES[transition],
  ]);
  const rung = targetRung?.rung ?? (currentRung === null ? undefined : STABLE_FROM);
  if (rung !== undefined) RUNG_CAPABILITIES[rung].forEach((value) => capabilities.add(value));
  if (input.support === 'lts') {
    LTS_CAPABILITIES.forEach((value) => capabilities.add(value));
  }
  addRiskCapabilities(capabilities, risks);
  for (const risk of input.risks ?? []) {
    for (const capability of input.riskCapabilities?.[risk] ?? []) capabilities.add(capability);
  }
  for (const escalation of input.ownerEscalations ?? []) capabilities.add(escalation);
  return {
    schemaVersion: '1.0.0',
    verdict: 'ready',
    transition,
    support: input.support,
    capabilities: [...capabilities].sort(),
    mutation: 'none',
    mutationDisposition: { status: 'not-required', reason: 'mutation-external-hardening' },
    blockingReasons: [],
  };
}

export function resolveReleaseTaskNodes(
  decision: ReleaseVerificationDecision,
  capabilityTasks: Readonly<Record<string, readonly string[]>>,
  knownTaskNodes: readonly string[],
): readonly string[] {
  if (decision.verdict !== 'ready') throw new Error('CHECK_RELEASE_DECISION_BLOCKED');
  const known = new Set(knownTaskNodes);
  const missing: string[] = [];
  const selected = new Set<string>();
  for (const capability of decision.capabilities) {
    const nodes = capabilityTasks[capability] ?? [];
    if (nodes.length === 0) {
      missing.push(capability);
      continue;
    }
    for (const node of nodes) {
      if (!known.has(node)) throw new Error(`CHECK_RELEASE_PROFILE_UNKNOWN_TASK:${node}`);
      selected.add(node);
    }
  }
  if (missing.length > 0) {
    throw new Error(`CHECK_RELEASE_PROFILE_CAPABILITY_UNSATISFIED:${missing.sort().join(',')}`);
  }
  return [...selected].sort();
}

export function resolveReleaseMutationTaskNodes(
  decision: ReleaseVerificationDecision,
  _roster: readonly MutationRosterEntry[],
  _changedPackages: readonly string[],
  _changedPaths: readonly string[],
  _risks: readonly string[],
  _knownTaskNodes: readonly string[],
): Readonly<{ taskNodes: readonly string[]; rosterEntryIds: readonly string[] }> {
  if (decision.verdict !== 'ready') throw new Error('CHECK_RELEASE_DECISION_BLOCKED');
  return { taskNodes: [], rosterEntryIds: [] };
}
