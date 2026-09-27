import { platform } from 'node:os';
/** The infrastructure, network-egress and cleanup frames the isolated run itself decides. */
export function translationRunFrames(input: {
  readonly effectiveInfrastructureFinding: string | undefined;
  readonly networkDenialProven: boolean;
  readonly isolationAttempts: number;
  readonly worktreeCleanup: boolean;
  readonly databaseCleanup: boolean;
}) {
  const {
    effectiveInfrastructureFinding,
    networkDenialProven,
    isolationAttempts,
    worktreeCleanup,
    databaseCleanup,
  } = input;
  return [
    effectiveInfrastructureFinding === undefined
      ? { name: 'infrastructure', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'infrastructure',
          status: 'FAIL' as const,
          evidence_refs: [],
          finding: `Validation infrastructure failed: ${effectiveInfrastructureFinding}`,
        },
    networkDenialProven
      ? { name: 'network-egress', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'network-egress',
          status: 'REVIEW' as const,
          evidence_refs: [],
          finding:
            platform() !== 'linux'
              ? 'Native isolation is best-effort; network denial is not proven.'
              : isolationAttempts === 0
                ? 'Registered execution did not reach the Linux isolation boundary.'
                : 'Linux isolation proof is unavailable because validation infrastructure failed.',
        },
    worktreeCleanup && databaseCleanup
      ? { name: 'cleanup', status: 'PASS' as const, evidence_refs: [] }
      : {
          name: 'cleanup',
          status: 'FAIL' as const,
          evidence_refs: [],
          finding: 'Exact worktree or database cleanup could not be verified.',
        },
  ];
}

/** FAIL when any frame fails, REVIEW when any needs review, PASS otherwise. */
export function translationFrameVerdict(frames: readonly { readonly status: string }[]) {
  return frames.some((frame) => frame.status === 'FAIL')
    ? 'FAIL'
    : frames.some((frame) => frame.status === 'REVIEW')
      ? 'REVIEW'
      : 'PASS';
}
