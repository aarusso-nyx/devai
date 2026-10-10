/**
 * Reviewed workflow steps (#325). The harness effect analysis cannot prove every step the
 * DEVAI workflows run: checkouts select a ref and path, the toolchain action takes inputs,
 * and the run scripts use shell the closed command grammar refuses. Each entry below names
 * one exact step by the sha256 of its canonical YAML and records the effect a reviewer
 * assigned it. Any edit to the step changes its digest, so an edited step is analysed again
 * and reads unknown until it is reviewed anew; ADR-REL-0034 keeps unknown effects findings.
 *
 * `publication` marks a step that writes an external release surface; `repository-write` marks a
 * step that changes this repository's own branches through the API; every other entry writes only
 * the workspace, runner files or step outputs. The registry test
 * (packages/sensors/tests/unit/reviewed-workflow-steps.test.ts) fails on an entry whose
 * occurrences differ from the current workflows and names every job left unproved; the
 * digests of a job's steps come from `workflowStepInventory` in workflow-parser.ts.
 */
/**
 * A proved step or job effect (ADR-CHK-0008): read-only writes only the workspace, runner files
 * or step outputs; repository-write changes this repository's own branches through the API (the
 * update-branch rebase), with no release surface; publication writes an external release surface.
 */
export type HarnessEffect = 'read-only' | 'repository-write' | 'publication';

export interface ReviewedWorkflowStep {
  readonly sha256: string;
  readonly effect: HarnessEffect;
  /** Every occurrence, as `<workflow file>#<job>[<step index>]`. */
  readonly workflow: string;
  readonly step: string;
  readonly review: string;
  /**
   * Every repository file the step executes, sorted by path, with the sha256 of the reviewed
   * bytes. The analysis recomputes them from the candidate tree and reads unknown on any
   * difference, so a changed composite action or script re-opens the review.
   */
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  /**
   * Reviewed covers for computed dynamic imports (#344 review). An executed module whose
   * `import(...)` or `require(...)` specifier is not a string literal can load any file, so the
   * step reads unknown unless its entry names, for that module, every repository file the import
   * can reach (each one is then in `files`, pinned by digest). An empty list is a reviewed
   * statement that the import reaches nothing in the repository; the reason says why.
   */
  readonly computed_imports?: readonly {
    readonly from: string;
    readonly reason: string;
    readonly files: readonly string[];
  }[];
}

/** The steps of DEVAI's own workflows under .github/workflows. */
const REPOSITORY_WORKFLOW_STEPS: readonly ReviewedWorkflowStep[] = [
  {
    sha256: 'b789ab88315626e7303bea66f4a3c615df7ef22bc152ac28b7c4768210563368',
    effect: 'read-only',
    workflow: 'devai-ledger-verify.yml#verify-ledger[0]',
    step: 'Check out exact candidate',
    review:
      'Checks out ${{ env.CANDIDATE_SHA }} into candidate without persisted credentials; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: '27ebd378b62e492970f4dfb82e513d1e0bf3c3a4d28d74b8bbf7c45abe07e173',
    effect: 'read-only',
    workflow: 'devai-ledger-verify.yml#verify-ledger[2]',
    step: 'Probe declared credential prerequisites',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/release-prerequisites.mjs',
        sha256: '14573fc97c0804462c4be5bc92a3e9301bbe20ffa2fb3dc4141ba206ff5e605b',
      },
    ],
  },
  {
    sha256: 'f9528066a815882745ebd13cce65557a4169b2e1ab164562df757d285089315c',
    effect: 'read-only',
    workflow: 'devai-ledger-verify.yml#verify-ledger[3], release.yml#verify-ledger[3]',
    step: 'Materialize protected DEVAI verifier package',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: '54bb87f679c366459df5f782319b69e3db5d2ff2677be044bf89198efaa1a992',
    effect: 'read-only',
    workflow:
      'devai-ledger-verify.yml#verify-ledger[4], release.yml#verify-ledger[4], release.yml#build-release[9], release.yml#finalize-release[1]',
    step: 'Check out approved process controls',
    review:
      'Checks out ${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }} into release-control without persisted credentials; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: '5fef52e1debe90acd745e6cc496632a31687d39d0d2e38d6d4d53396ea1084e2',
    effect: 'read-only',
    workflow:
      'devai-ledger-verify.yml#verify-ledger[5], release.yml#verify-ledger[5], release.yml#build-release[10], release.yml#finalize-release[2]',
    step: 'Bind approved process controls',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: '42f70b743242ce188aa0097507dddcb42bc178722c34b0dc42ba6076e5ba51d2',
    effect: 'read-only',
    workflow: 'devai-ledger-verify.yml#verify-ledger[6]',
    step: 'Materialize externally controlled verification inputs',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/evidence_transport.py',
        sha256: '21a56bdc1df376418918ce761c873a6fb63aaf8a254dd0d9996ce27a3773c3ba',
      },
    ],
  },
  {
    sha256: 'c3e03422413fe9db822cd1a885a86e853c68ae892dfa7f2d89b72bbce5d947f1',
    effect: 'read-only',
    workflow: 'devai-ledger-verify.yml#verify-ledger[7]',
    step: 'Bind exact candidate identity',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: '5550c37da6504d2baf22544fa64dd5c10f02674fe0d2bddd3d6b58bc3cbd79d1',
    effect: 'read-only',
    workflow: 'devai-ledger-verify.yml#verify-ledger[8]',
    step: 'Reconstruct policy and verify ledger',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: 'a5a7ea3605608cc3fd140e071d6fb7270542636ea3a80ca33a6c04484976a6c0',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-cli[0], pull-request-checks.yml#gate-rest[0]',
    step: 'Check out exact candidate',
    review:
      "Checks out ${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }} into the workspace without persisted credentials; selects source, publishes nothing.",
    files: [],
  },
  {
    sha256: 'b7ed7ae3efcf18f796d7496b73aa9531724d8c844932e1d114d38937fa9b7018',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-cli[1], pull-request-checks.yml#gate-rest[1]',
    step: 'Set up pnpm and Node',
    review:
      'Repository toolchain action with declared inputs: installs Node and optionally pnpm and a registry scope; publishes nothing.',
    files: [
      {
        path: '.github/actions/setup-node-toolchain/action.yml',
        sha256: 'fd52623680a69ece95939fbc4e3e023b223205b3fc0381043a7ebffd1046bada',
      },
    ],
  },
  {
    sha256: 'c486121aada4d6e6e22633528e550ffaaac884812fb8a92183a0742343bd117c',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-cli[2], pull-request-checks.yml#gate-rest[2]',
    step: 'Restore the check runner bootstrap',
    review:
      'Restores the bootstrap runner keyed by the hash of every input it compiles (ADR-CHK-0003); a stale key only recompiles. The following run steps are reviewed with this restore in view.',
    files: [],
  },
  {
    sha256: '869b6b0cd83816e1ff7cc3ae93ee096bb1b9e38f02aeba1eea72506e77130fd7',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-cli[3], pull-request-checks.yml#gate-rest[3]',
    step: 'Compile the check runner bootstrap',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'package.json',
        sha256: 'e0fa5ba3b04195514dc2c71987092e3355e224e42a8b4c8d2a54012f7a9089b2',
      },
      {
        path: 'scripts/process/bootstrap-check-runner.mjs',
        sha256: 'cc2e1f307390ba7db8c0666a0a2ea15780d19c4657d8d3cd656d796b6a63e4e6',
      },
    ],
  },
  {
    sha256: '9a13ac4faaccd643f196d9da3fc38f590403a70773cf998213ae9497da2535eb',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-cli[4]',
    step: 'Preflight probes',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: 'd6118e1f7242659d27bbcb028a58b5f41f7d7193066240c9bb0477483a925ce2',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-cli[5]',
    step: 'Affected checks owned by test:cli',
    review:
      'Runs the test:cli side of the partitioned affected plan (ADR-CHK-0007 rule 11) and writes its report under the runner temp directory; makes no external write.',
    files: [
      {
        path: 'scripts/process/summarize-check-report.mjs',
        sha256: '61d42e1bc0cdaf3a9e68f7950be0ef49f5797e43a348b26415062f0bae37323f',
      },
    ],
  },
  {
    sha256: 'b0084ee23bfa8266d898e03d7e81c91972524541000067be939e5d8020e31534',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-cli[6]',
    step: 'Upload the partition report',
    review:
      "Uploads this partition's report from the runner temp directory as an artifact of the same workflow run (devai-gate-report-cli), which only the aggregator job reads; writes no release surface.",
    files: [],
  },
  {
    sha256: '33bd02d9f43654b3d6aa81c4f271ecab48c9c41d4c8b152377dd1f9cfbef3c3c',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-rest[4]',
    step: 'Preflight probes',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: 'b05cd92ce9f6a2cf9fda90e42433e0380c2c59f68272a3c3cf624cdc2433c320',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-rest[5]',
    step: 'Affected checks and profile-selected candidate preflight',
    review:
      'Runs the release profile gate and the side of the partitioned affected plan outside test:cli (ADR-CHK-0007 rule 11), writing its report under the runner temp directory; makes no external write.',
    files: [
      {
        path: 'package.json',
        sha256: 'e0fa5ba3b04195514dc2c71987092e3355e224e42a8b4c8d2a54012f7a9089b2',
      },
      {
        path: 'scripts/check-commit-range.mjs',
        sha256: '24b9264694666133329ff30a0c87399c6c3118592b3a49541cb491c4392fce30',
      },
      {
        path: 'scripts/pr-failure-diagnostics.mjs',
        sha256: '07eab47fcd5e1c634f622cb764a4edfee044021b2aedd40d870f98477777c587',
      },
      {
        path: 'scripts/process/summarize-check-report.mjs',
        sha256: '61d42e1bc0cdaf3a9e68f7950be0ef49f5797e43a348b26415062f0bae37323f',
      },
      {
        path: 'scripts/run-pr-release-gate.mjs',
        sha256: '9986877ced443848d2e1e72cdfb40c13c667469eb0d4e91846e465c4cbda6da1',
      },
    ],
  },
  {
    sha256: '2b445cc112826576ef05d97afa1b7e462232c347423486d331f7ceaa1cfcedbc',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate-rest[6]',
    step: 'Upload the partition report',
    review:
      "Uploads this partition's report from the runner temp directory as an artifact of the same workflow run (devai-gate-report-rest), which only the aggregator job reads; writes no release surface.",
    files: [],
  },
  {
    sha256: '8eed4a18e94d2b0ad0360e876bb574e8dcb8c2ee735536381a437fb00667d16d',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate[0]',
    step: 'Check out exact candidate',
    review:
      "Checks out ${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }} at depth 1 into the workspace without persisted credentials, only to read the aggregator script; selects source, publishes nothing.",
    files: [],
  },
  {
    sha256: '18525e42de63e157903e8af3c42d8f99f426ca640332f85001babf6d902bd4c7',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate[2]',
    step: 'Download the partition reports',
    review:
      "Downloads the run's own devai-gate-report-* artifacts into the runner temp directory; reads artifacts of this workflow run and writes only runner files.",
    files: [],
  },
  {
    sha256: '5e9f0dd12c5ae611711a2a29c8667fea0ef3802731af48e7a75353d19559278d',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#gate[3]',
    step: 'Aggregate the partition reports',
    review:
      'Runs scripts/aggregate-gate-partitions.mjs over the two downloaded partition reports; reads them, runs no check node, and prints one JSON line; makes no external write.',
    files: [
      {
        path: 'scripts/aggregate-gate-partitions.mjs',
        sha256: '3db39086d9afc41612514a8b6eee066e3315fc8f3cc750108558b32000836cb2',
      },
    ],
  },
  {
    sha256: 'a2c74c1d2c667cf8ff33ab0b80ea5992ab3c32314e49bde158da7a8ea92ae4e3',
    effect: 'read-only',
    workflow: 'release.yml#control-commit-summary[0]',
    step: 'Check out the prerequisites script from the workflow commit',
    review:
      'Checks out ${{ github.workflow_sha }} into the workspace without persisted credentials; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: '1543145122b264f44a5913635797b3cfa8c1f3942a6c409eb1eb41aab7592ce6',
    effect: 'read-only',
    workflow: 'release.yml#control-commit-summary[1]',
    step: 'Print approved process control commit before the first stop',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/release-prerequisites.mjs',
        sha256: '14573fc97c0804462c4be5bc92a3e9301bbe20ffa2fb3dc4141ba206ff5e605b',
      },
    ],
  },
  {
    sha256: '37b18a55c939098404427dd7a34d9dea1c2834839a342db1a1a10c9b0a867fb5',
    effect: 'read-only',
    workflow: 'release.yml#verify-ledger[0]',
    step: 'Check out exact release commit',
    review:
      'Checks out ${{ env.CANDIDATE_REF }} into candidate without persisted credentials; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: '51f95479eb2513d416bc96aa162427cf0086f0a6e6f870586e8ec0b39c73f357',
    effect: 'read-only',
    workflow: 'release.yml#verify-ledger[2]',
    step: 'Probe declared credential prerequisites',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/release-prerequisites.mjs',
        sha256: '14573fc97c0804462c4be5bc92a3e9301bbe20ffa2fb3dc4141ba206ff5e605b',
      },
    ],
  },
  {
    sha256: '1b7bc42a4d27e6377983e18f313d69d13a3022c88b9f5836949f63a853b5a498',
    effect: 'read-only',
    workflow: 'release.yml#verify-ledger[6]',
    step: 'Materialize protected ledger inputs',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/evidence_transport.py',
        sha256: '21a56bdc1df376418918ce761c873a6fb63aaf8a254dd0d9996ce27a3773c3ba',
      },
    ],
  },
  {
    sha256: 'c79216e70359e6f0929bb8473c478c55d79a5dacfe4731548b74b642377185f2',
    effect: 'read-only',
    workflow: 'release.yml#verify-ledger[7]',
    step: 'Bind and verify exact release evidence',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: '7149c71c255af9e9501807abb70b803ac615564559d27ec2715c39c1fb6fa99f',
    effect: 'read-only',
    workflow: 'release.yml#verify-ledger[8]',
    step: 'Verify selected rehearsal',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/rehearsal.mjs',
        sha256: 'f639f3484e7260ea57523ff2c4d9a1dddc1b04e843150919e0a3c2962dc8c175',
      },
    ],
  },
  {
    sha256: 'cf4eec8cb2577daa79481a7b04dfc44cf0e6daf06070b3ab88ad82f08d47f644',
    effect: 'read-only',
    workflow: 'release.yml#build-release[0]',
    step: 'Check out exact tagged source',
    review:
      'Checks out ${{ needs.verify-ledger.outputs.commit }} into the workspace without persisted credentials; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: '2c8af79b77fe6d045d8c73b4381516c626daadc02a6b56492ea4b9e7f878f60d',
    effect: 'read-only',
    workflow: 'release.yml#build-release[1]',
    step: 'Set up pnpm and Node with GitHub Packages',
    review:
      'Repository toolchain action with declared inputs: installs Node and optionally pnpm and a registry scope; publishes nothing.',
    files: [
      {
        path: '.github/actions/setup-node-toolchain/action.yml',
        sha256: 'fd52623680a69ece95939fbc4e3e023b223205b3fc0381043a7ebffd1046bada',
      },
    ],
  },
  {
    sha256: '012039e8c375a3b27b9203954f8991122f008814e7812c19b0dacffd27d57dd6',
    effect: 'read-only',
    workflow: 'release.yml#build-release[2]',
    step: 'Verify immutable source identity',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/release-channel.mjs',
        sha256: '944783e880f755afe140e935ba5e11bb37269bce9c3af848fff444d643a94304',
      },
    ],
  },
  {
    sha256: '0e07b6a466b9eb1b2258756b9ca3010a1db353f5653f152ed0e6177526557350',
    effect: 'read-only',
    workflow: 'release.yml#build-release[3]',
    step: 'Install frozen dependencies',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'package.json',
        sha256: 'e0fa5ba3b04195514dc2c71987092e3355e224e42a8b4c8d2a54012f7a9089b2',
      },
    ],
  },
  {
    sha256: 'd7e834d61f567e9f76d6dc77c6f37a758c943fa29779116c49745d29a1412c4b',
    effect: 'read-only',
    workflow: 'release.yml#build-release[4]',
    step: 'Build package and site once',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'docs/site/package.json',
        sha256: 'd6f40c119dc4957119d82e67b8d1ada2ca99561d7ca0302bd73f60e09c665735',
      },
      {
        path: 'docs/site/scripts/check-dependency-audit.mjs',
        sha256: 'f7ad8d6971f03e0a3bfa87122bfd87d842e1749072cb4895449d8e6f4460e0f5',
      },
      {
        path: 'docs/site/scripts/check-image-size-patch.mjs',
        sha256: 'ee9966baddcb44969e6247668733f418db68b193f699945b67b6943dd2966f81',
      },
      {
        path: 'docs/site/scripts/sync-docs.mjs',
        sha256: '6f5d024f7ada2c166f0fa14642a2bbeb45b6ba7fa068b03165f0fe2dcf342360',
      },
      {
        path: 'package.json',
        sha256: 'e0fa5ba3b04195514dc2c71987092e3355e224e42a8b4c8d2a54012f7a9089b2',
      },
      {
        path: 'packages/authority/package.json',
        sha256: '18a1316615ca97e9e23d636901d5241d184764b42b8ce9ea98ebeaf41972ea3f',
      },
      {
        path: 'packages/cli/package.json',
        sha256: '3ab1863b71c9bb588d12b75cf6079ec6f23492c4e0d899d946a7f05b22542142',
      },
      {
        path: 'packages/cli/scripts/assemble-package.mjs',
        sha256: 'a2f9d29b0547a90df4c745a869e263f87699ccca21d6611a0c7254249362ea42',
      },
      {
        path: 'packages/effects-check/package.json',
        sha256: '8023fe1c7d76acf954f7e3a72ea488f6414ea33738a5f37d1c9e721de235dd6f',
      },
      {
        path: 'packages/evidence/package.json',
        sha256: 'ba2f37fd27b2d60449b56f6067991106314db0ef4303cc7c6456c0bae042461a',
      },
      {
        path: 'packages/loop/package.json',
        sha256: 'a8243353d485251e1d484f22a3e901886ddf0997108e112b277146db5811850e',
      },
      {
        path: 'packages/schemas/package.json',
        sha256: '5293fc1ed7186095cb27b3808e266d80225abacdf1148c69946f1b0d12aa5087',
      },
      {
        path: 'packages/schemas/scripts/copy-law.mjs',
        sha256: 'a5e6cc4332f91d67026fa554c610372c1bfb2e5ce20b4e8673578f1537f0f6f3',
      },
      {
        path: 'packages/sensors/package.json',
        sha256: 'd36408de144faceac5d6c26ac8c453a438c7e6b97474287b00755d4c54e84048',
      },
      {
        path: 'packages/sensors/scripts/copy-law.mjs',
        sha256: 'edea57fb8021f6225fd9120b2e35d4404d23f338b585d50e9f20ed4dca124370',
      },
      {
        path: 'packages/skills/package.json',
        sha256: 'f355134f6574e0b4791f968a9085e72a20a62e6b31cc2d36b8371fd87e87c277',
      },
      {
        path: 'packages/skills/scripts/copy-constitution.mjs',
        sha256: '63d4dcaee5b8c9e1ca70f187c43af8f875d8a91bb358855e4797dbbdf97fb1bc',
      },
      {
        path: 'packages/skills/scripts/copy-policy.mjs',
        sha256: '7735b788871420979c9a7941b13b615a12e4df05a44ecabc554ed21a295d9e8e',
      },
      {
        path: 'packages/skills/src/operations/catalog.ts',
        sha256: '0e8e7a4cdb518d579d7af13d0461f3210d179c202e331627f8d2aed8be858aa1',
      },
      {
        path: 'packages/skills/src/operations/types.ts',
        sha256: 'acf1ea43bef8370acf5e770bf30769a02eabf152d6e7a276e4569ef842038a25',
      },
      {
        path: 'packages/skills/src/recipes/loader.ts',
        sha256: '142e645da29e5113afa97e1bf4bd770b8d0ed2bf6a73703bc4674b3e9ad352ac',
      },
      {
        path: 'packages/skills/src/recipes/types.ts',
        sha256: 'a9dcd5bc77feb8441474dadd5086a8d19b15ce316b2d79a05b73719b69e5b040',
      },
      {
        path: 'packages/skills/src/recipes/validate.ts',
        sha256: '60d443b35e24d81fe59ff4fff6ea7ca267e8157e78effd42bba56a24db9a555a',
      },
      {
        path: 'packages/spec/package.json',
        sha256: '31f8d7bffc6dc8dd4184ec7133fcfeeffc7eabc099f7af02831bb01c04729282',
      },
      {
        path: 'packages/utils/package.json',
        sha256: '80ee9be4c10802f8eb42895f04475d41298247f6a37790eee87dbd1eb3db51bd',
      },
      {
        path: 'scripts/check-formatting.mjs',
        sha256: 'a9cae7b794ba08de3a795ae376018d7424d9984e5fb7678b0430f3061be79e55',
      },
      {
        path: 'scripts/check-mutation-free-delivery.mjs',
        sha256: '55ef4b0c1558e6b8dbce75e60a8731d52dc4d32703f6607e2f45e05e49cef920',
      },
      {
        path: 'scripts/check-policy-materialization.mjs',
        sha256: 'e906aff0ebdf1bbb6c2a8ded2f6a7481f70d7d1f5fd3c8554d95179d865e3832',
      },
      {
        path: 'scripts/check-publishable-closure.mjs',
        sha256: '6c8bdd8adc6211fb0ccc35abb3280ebe5edfb5ba4b573c30a905772b66de7b74',
      },
      {
        path: 'scripts/check-release-static-integrity.mjs',
        sha256: 'd65d1622dbf56c590702b4cd152ac5b6a8f7082ac48bad6a9b265133c2562ead',
      },
      {
        path: 'scripts/check-test-task-workspace-selectors.mjs',
        sha256: '1088a5f6ed6b7e6734f3717f8297743da23daec4e88f18d3cb1fb4cb7f0e7151',
      },
      {
        path: 'scripts/error-code-sources.mjs',
        sha256: '4eed494d0d3e2cf423d1872331e588305075ec26fffab307d3fe82b87dc4b79f',
      },
      {
        path: 'scripts/generate-action-registry.mjs',
        sha256: '6c6ff06564fa19539adec3c750351b78e4f3383e102dca60799ec87af78a82ea',
      },
      {
        path: 'scripts/generate-error-code-reference.mjs',
        sha256: '3b5f04790e8bf7933ff668790c48df3ef65126b59c5602b8d947eb6dea71686f',
      },
      {
        path: 'scripts/generate-scorecard-page.mjs',
        sha256: 'd558520cc9a8883d069205a3069777c075d93c1a2a8602de10267913ed243e40',
      },
    ],
    computed_imports: [
      {
        from: 'scripts/check-publishable-closure.mjs',
        reason:
          'Loads packages/skills/dist/operations/catalog.js, compiled from the operation catalog source and the modules it imports statically.',
        files: [
          'packages/skills/src/operations/catalog.ts',
          'packages/skills/src/operations/types.ts',
          'packages/skills/src/recipes/loader.ts',
          'packages/skills/src/recipes/types.ts',
          'packages/skills/src/recipes/validate.ts',
        ],
      },
    ],
  },
  {
    sha256: 'a64db5042d93fc6db8f3d5c308e5d9c20bbe83459637e93176fb262b0b52dc35',
    effect: 'read-only',
    workflow: 'release.yml#build-release[5]',
    step: 'Assemble immutable release artifacts',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'packages/cli/scripts/installed-tarball-smoke.mjs',
        sha256: '8cda2e9f9c558a72ff7b3cb7d36f295eee12ec4812882dd47360a0186d8334a1',
      },
      {
        path: 'scripts/create-release-manifest.mjs',
        sha256: '495787f4705c8f8ddfbb6db148a8fb41f8334e149fa27a3d9910d48606c15cc4',
      },
      {
        path: 'scripts/npm-pack-output.mjs',
        sha256: '9b17e820eae545c816c7620a7f219e731f63ebeaa44b5e70e2d39bbddab54341',
      },
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
      {
        path: 'scripts/release-channel.mjs',
        sha256: '944783e880f755afe140e935ba5e11bb37269bce9c3af848fff444d643a94304',
      },
      {
        path: 'scripts/stage-release-package.mjs',
        sha256: '42743ce917956fd0d4020d76cde8b20807af44478b361c70e05078c9f324cd69',
      },
    ],
    computed_imports: [
      {
        from: 'packages/cli/scripts/installed-tarball-smoke.mjs',
        reason:
          'Every computed import loads the installed package under test from its temporary install directory (or sits in a script the smoke test writes there); none reaches a repository file.',
        files: [],
      },
    ],
  },
  {
    sha256: '78cf0fd02d981507a2d3975ff53a64d366c2b470809c9737332aeb7a486746f0',
    effect: 'read-only',
    workflow: 'release.yml#build-release[7]',
    step: 'Download exact release assets',
    review:
      'Downloads same-run release assets by name or id into a declared path; the following run steps verify their digests before use.',
    files: [],
  },
  {
    sha256: 'b7177aeb2b1551e440f85af14a80678ff5552c0e334bc9e12242ae5b353ccff0',
    effect: 'read-only',
    workflow: 'release.yml#build-release[8]',
    step: 'Exercise fresh npm adoption, execution, and reuse',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'package.json',
        sha256: 'e0fa5ba3b04195514dc2c71987092e3355e224e42a8b4c8d2a54012f7a9089b2',
      },
    ],
  },
  {
    sha256: '3f0529725bc22e2e89c7bb3a794c61e38ab7c911ca978a46230a97ac33ad6765',
    effect: 'read-only',
    workflow: 'release.yml#build-release[11]',
    step: 'Record completed rehearsal',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/rehearsal.mjs',
        sha256: 'f639f3484e7260ea57523ff2c4d9a1dddc1b04e843150919e0a3c2962dc8c175',
      },
    ],
  },
  {
    sha256: '72a412a3141ecc2e81d65fbf0d7bd17e34874a291a5f191e9e6a55f9f2b1c53d',
    effect: 'read-only',
    workflow: 'release.yml#finalize-release[0]',
    step: 'Check out exact release commit',
    review:
      'Checks out ${{ env.RELEASE_TAG }} into the workspace without persisted credentials; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: '7f25b9d08edef1768b8eb237b6fed4d57e75739ce2eaa6a8193a9f173621b41e',
    effect: 'read-only',
    workflow: 'release.yml#finalize-release[3]',
    step: 'Set up Node and GitHub Packages',
    review:
      'Repository toolchain action with declared inputs: installs Node and optionally pnpm and a registry scope; publishes nothing.',
    files: [
      {
        path: '.github/actions/setup-node-toolchain/action.yml',
        sha256: 'fd52623680a69ece95939fbc4e3e023b223205b3fc0381043a7ebffd1046bada',
      },
    ],
  },
  {
    sha256: '6d61d3eba177043b2b1027e0b4b0944df13adf6521f5415601d11a96078e905d',
    effect: 'read-only',
    workflow: 'release.yml#finalize-release[4]',
    step: 'Bind parameterized release identity',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/release-channel.mjs',
        sha256: '944783e880f755afe140e935ba5e11bb37269bce9c3af848fff444d643a94304',
      },
    ],
  },
  {
    sha256: 'be7b56447806bbb2c1de4d4c2ec0664f2921e0ce6273011a7baec9b34e40bc01',
    effect: 'read-only',
    workflow: 'release.yml#finalize-release[5]',
    step: 'Download exact release assets',
    review:
      'Downloads same-run release assets by name or id into a declared path; the following run steps verify their digests before use.',
    files: [],
  },
  {
    sha256: '078827565f120f3b532f009637e7e1f9f0a39244f82d5602e7697aa4bc522f1c',
    effect: 'read-only',
    workflow: 'release.yml#finalize-release[6]',
    step: 'Verify canonical asset set',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: '44d0a45e0b1371d8c72f3a33d24fec35eb441c34866e6e41d8103bc987f46aee',
    effect: 'publication',
    workflow: 'release.yml#finalize-release[7]',
    step: 'Create or verify immutable GitHub Release',
    review:
      'Publishes or reconciles an external release surface (GitHub Release, GitHub Packages, or Pages) after its candidate and journal checks; runs only in a job with its environment and a non-cancelling lock.',
    files: [
      {
        path: 'scripts/process/publication-state.mjs',
        sha256: 'a8eae12262dd6e755433038a4bb1b4204280af4b899be25ca42d3d43d8b212f0',
      },
      {
        path: 'scripts/process/release-recovery.mjs',
        sha256: 'e09aa8bb5da1dc5f484f285c32596df0b7f83e91987dfadf3a4ff0d148a40b64',
      },
    ],
  },
  {
    sha256: '0a5ff9736e3c6d1ae9b4c9f81526d3e864d224927d7a123fe5afc5ef5c7f7225',
    effect: 'publication',
    workflow: 'release.yml#finalize-release[8]',
    step: 'Publish or verify exact GitHub Packages mirror',
    review:
      'Publishes or reconciles an external release surface (GitHub Release, GitHub Packages, or Pages) after its candidate and journal checks; runs only in a job with its environment and a non-cancelling lock.',
    files: [
      {
        path: 'package.json',
        sha256: 'e0fa5ba3b04195514dc2c71987092e3355e224e42a8b4c8d2a54012f7a9089b2',
      },
      {
        path: 'scripts/process/publication-state.mjs',
        sha256: 'a8eae12262dd6e755433038a4bb1b4204280af4b899be25ca42d3d43d8b212f0',
      },
    ],
  },
  {
    sha256: '21cd85ad1123d2e39db878db3af97be58ed6d5665448433ec1b2542651e591a2',
    effect: 'read-only',
    workflow: 'release.yml#deploy-pages[0]',
    step: 'Check out approved Pages verification controls',
    review:
      'Checks out ${{ vars.DEVAI_PROCESS_CONTROL_COMMIT }} into release-control without persisted credentials; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: 'eebbe0d6189b55bbcc3aad7cf09dfe031775db53d76f60bbac1216a798340ce2',
    effect: 'read-only',
    workflow: 'release.yml#deploy-pages[1]',
    step: 'Bind approved Pages verification controls',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: 'af3c055e2ddb413a2dc2687cb65ba75e322d406930b5b08ca0ed7a34d5f1edf2',
    effect: 'read-only',
    workflow: 'release.yml#deploy-pages[3]',
    step: 'Download canonical release assets',
    review:
      'Downloads same-run release assets by name or id into a declared path; the following run steps verify their digests before use.',
    files: [],
  },
  {
    sha256: 'dd71bdcc29b7959a841b351079cfb1f88c83c9fe7dc6659b09590d087430be92',
    effect: 'read-only',
    workflow: 'release.yml#deploy-pages[4]',
    step: 'Materialize the manifest-bound site archive',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
    ],
  },
  {
    sha256: '527ed39c6d1b4f5eeaf84a4763b78bdd9acbfcc5335bc9d4a50398f934439081',
    effect: 'publication',
    workflow: 'release.yml#deploy-pages[6]',
    step: 'Reconcile and deploy exact Pages artifact',
    review:
      'Publishes or reconciles an external release surface (GitHub Release, GitHub Packages, or Pages) after its candidate and journal checks; runs only in a job with its environment and a non-cancelling lock.',
    files: [
      {
        path: 'scripts/process/github-pages-journal.mjs',
        sha256: '6ab7939892293bb43eeb64f9f3af78193654b2833ac4efe25e8b246c157af35b',
      },
      {
        path: 'scripts/process/pages-publication.mjs',
        sha256: '4a8aea3498e9788445bcf2640762baa3634764a18ee87e9f61b2cf2ab4822e48',
      },
      {
        path: 'scripts/process/pages-runtime.mjs',
        sha256: '705283bca49745b620444c142622f411c4ee0402d3370e2fbea6d8eaf7fc25cf',
      },
      {
        path: 'scripts/process/publish-pages.mjs',
        sha256: 'dba4da9070d2e9742dd507deac35810f67e757532bbaf0b4933e94f86b9abf82',
      },
      {
        path: 'scripts/process/rehearsal.mjs',
        sha256: 'f639f3484e7260ea57523ff2c4d9a1dddc1b04e843150919e0a3c2962dc8c175',
      },
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
    ],
  },
  {
    sha256: '198f7c28ab96c2602f714bbab717163c57bcac5b52a8569334a958c098749f79',
    effect: 'read-only',
    workflow: 'release.yml#deploy-pages[8]',
    step: 'Verify live documentation',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
    ],
  },
  {
    sha256: '8a71e105e772ef59fcaa00273ebae0f22c91fc0943d20f69e9db52f42ff1ed6d',
    effect: 'read-only',
    workflow: 'site-publish.yml#prepare-site[0], site-publish.yml#publish-site[0]',
    step: 'Check out the dispatched main commit',
    review:
      'Checks out ${{ github.sha }} into the workspace without persisted credentials; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: 'ee55209cb6bca367dafa104dc204ea18901bc44861c17e377f6db04c311dc99a',
    effect: 'read-only',
    workflow:
      'pull-request-checks.yml#gate[1], site-publish.yml#prepare-site[1], site-publish.yml#publish-site[1]',
    step: 'Set up Node',
    review:
      'Repository toolchain action with declared inputs: installs Node and optionally pnpm and a registry scope; publishes nothing.',
    files: [
      {
        path: '.github/actions/setup-node-toolchain/action.yml',
        sha256: 'fd52623680a69ece95939fbc4e3e023b223205b3fc0381043a7ebffd1046bada',
      },
    ],
  },
  {
    sha256: '078ae5dc007b840d610dbc03e0d122191546bfd80d5d8a9c6af945a0d8779440',
    effect: 'read-only',
    workflow: 'site-publish.yml#prepare-site[2]',
    step: 'Bind source identity',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: 'd455b4369c10b3ff874c129d3baf75174454e1ba5357493b64ded810974113dc',
    effect: 'read-only',
    workflow: 'site-publish.yml#prepare-site[3]',
    step: 'Build and verify the documentation site',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'docs/site/package.json',
        sha256: 'd6f40c119dc4957119d82e67b8d1ada2ca99561d7ca0302bd73f60e09c665735',
      },
      {
        path: 'docs/site/scripts/check-dependency-audit.mjs',
        sha256: 'f7ad8d6971f03e0a3bfa87122bfd87d842e1749072cb4895449d8e6f4460e0f5',
      },
      {
        path: 'docs/site/scripts/check-image-size-patch.mjs',
        sha256: 'ee9966baddcb44969e6247668733f418db68b193f699945b67b6943dd2966f81',
      },
      {
        path: 'docs/site/scripts/sync-docs.mjs',
        sha256: '6f5d024f7ada2c166f0fa14642a2bbeb45b6ba7fa068b03165f0fe2dcf342360',
      },
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
    ],
  },
  {
    sha256: '55b94efd4b602a55d361848157aab6a9d4831cf73cb63dcdcb75d6cbb336dab1',
    effect: 'read-only',
    workflow: 'site-publish.yml#prepare-site[4]',
    step: 'Bind exact preparation population',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'packages/sensors/src/ci-invariant-gate.ts',
        sha256: '947eb7e5250b446d2ddb8578cfcfb171e8fe99a3af34d264e9adba6c896e44e2',
      },
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
      {
        path: 'scripts/process/verify-site-preparation-artifact.mjs',
        sha256: '6e1e2593935a208d5b0eb47ac655ba32be6cc4ef2042be340dfe55c956329853',
      },
    ],
    computed_imports: [
      {
        from: 'scripts/process/verify-site-preparation-artifact.mjs',
        reason:
          'Loads the CI invariant gate from packages/sensors/dist when built, else from its source; the built module is compiled from this source, which has no local imports.',
        files: ['packages/sensors/src/ci-invariant-gate.ts'],
      },
    ],
  },
  {
    sha256: 'e1132817ebbdbc8770aa8d275287eb7f49ad05ca15fa05d40a0e104caec5bb9a',
    effect: 'publication',
    workflow: 'site-publish.yml#publish-site[2]',
    step: 'Reconcile and deploy exact Pages artifact',
    review:
      'Publishes or reconciles an external release surface (GitHub Release, GitHub Packages, or Pages) after its candidate and journal checks; runs only in a job with its environment and a non-cancelling lock.',
    files: [
      {
        path: 'packages/sensors/src/ci-invariant-gate.ts',
        sha256: '947eb7e5250b446d2ddb8578cfcfb171e8fe99a3af34d264e9adba6c896e44e2',
      },
      {
        path: 'scripts/process/github-pages-journal.mjs',
        sha256: '6ab7939892293bb43eeb64f9f3af78193654b2833ac4efe25e8b246c157af35b',
      },
      {
        path: 'scripts/process/pages-publication.mjs',
        sha256: '4a8aea3498e9788445bcf2640762baa3634764a18ee87e9f61b2cf2ab4822e48',
      },
      {
        path: 'scripts/process/pages-runtime.mjs',
        sha256: '705283bca49745b620444c142622f411c4ee0402d3370e2fbea6d8eaf7fc25cf',
      },
      {
        path: 'scripts/process/publish-site.mjs',
        sha256: 'e88d9eeb6734adee1783ef7da410b65e36f6ddfaa12d7f9c26478f8c40987a7c',
      },
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
      {
        path: 'scripts/process/verify-site-preparation-artifact.mjs',
        sha256: '6e1e2593935a208d5b0eb47ac655ba32be6cc4ef2042be340dfe55c956329853',
      },
    ],
    computed_imports: [
      {
        from: 'scripts/process/verify-site-preparation-artifact.mjs',
        reason:
          'Loads the CI invariant gate from packages/sensors/dist when built, else from its source; the built module is compiled from this source, which has no local imports.',
        files: ['packages/sensors/src/ci-invariant-gate.ts'],
      },
    ],
  },
  {
    sha256: 'c0fef72210c7fac0aa7ebc14e2c501c2ded95def1ca68910bc24821cf5038171',
    effect: 'read-only',
    workflow: 'site-publish.yml#publish-site[4]',
    step: 'Verify live documentation',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
    ],
  },
  {
    sha256: '1e00be750d7d9f4d8b478d0f80c1d29f0fa9ebdbdaa3391ab414bb814d03634f',
    effect: 'read-only',
    workflow: 'update-pull-request-branches.yml#update-branches[0]',
    step: 'Probe the update-branch App credentials',
    review:
      'Reads presence flags for the two update-branch App secrets, never their values, and sets a present output; on absence it writes a notice and a step-summary line so the run skips the update (absence: degrade). It changes nothing outside step outputs and the summary.',
    files: [],
  },
  {
    sha256: '61d6607ba9aaac3fd8a8fb06801836775c17735eeeb98ced3e89579172c443b7',
    effect: 'read-only',
    workflow: 'update-pull-request-branches.yml#update-branches[1]',
    step: 'Mint the update-branch App token',
    review:
      'Runs only when both credentials are present; mints a short-lived installation token for the update-branch GitHub App, scoped to this repository with contents and pull-requests write. It changes nothing itself and only sets a step output.',
    files: [],
  },
  {
    sha256: '1ba1bc979396c149549d2bb397aebe6edc0661a58b534e739410e9d310449921',
    effect: 'repository-write',
    workflow: 'update-pull-request-branches.yml#update-branches[2]',
    step: 'Rebase each open pull request behind main',
    review:
      "Runs only when both credentials are present; on push it rebases each open, non-draft, same-repository pull request behind main, and on pull_request_target only the event pull request (the job guard has required it same-repository and non-draft), through PUT pulls/{n}/update-branch with update_method rebase and the expected head sha, authenticated by the App token. Event values arrive only through env and the script checks out and runs no pull-request content. It changes only this repository's pull-request branches, never a fork and never a release surface, and reports a pull request it cannot compare or update without failing the others.",
    files: [],
  },
];

const READ_ONLY_CHECKOUT =
  'Checks out a fixed ref into its own path without persisted credentials; selects source, publishes nothing.';
const READ_ONLY_LOCAL =
  'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.';
const READ_ONLY_ARTIFACT =
  'Uploads a workflow run artifact of this run; the artifact belongs to the run, not to a release surface or this repository, so it makes no external write.';

/**
 * The steps of the workflows DEVAI generates into an adopter repository (#390): the
 * attested-RC verifier (`devai-local-rc-verify.yml`, from ci-scaffold) and the main
 * observation (`devai-main-observation.yml`, from the GitHub Actions host adapter). Their
 * occurrences read `generated:<workflow file>#<job>[<step index>]`, since they live in no
 * workflow of this repository; the registry test regenerates both workflows and checks every
 * occurrence against them. They execute no adopter repository file, so `files` is empty.
 */
const GENERATED_WORKFLOW_STEPS: readonly ReviewedWorkflowStep[] = [
  {
    sha256: '2564088d4cdb19c64d8b3ab1845af8f178c80eb9ba68a0adb23a8d9e76599714',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[0]',
    step: 'Check out candidate as inert data',
    review: READ_ONLY_CHECKOUT,
    files: [],
  },
  {
    sha256: '62b0e5adec89b9ec6bbd0a5efd3eed70b2f95b6f523dd8015b6f192a76d1dae6',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[1]',
    step: 'Check out default-branch controls',
    review: READ_ONLY_CHECKOUT,
    files: [],
  },
  {
    sha256: 'd50453121afe926a4974e35bd9ce4ecc58b2adb539b98a1eba1f4f2214b459fc',
    effect: 'read-only',
    // Byte-identical to the verifier runtime step of DEVAI's own ledger verification, which
    // the registry had not listed, so this one entry names all three occurrences.
    workflow:
      'devai-ledger-verify.yml#verify-ledger[1], release.yml#verify-ledger[1], generated:devai-local-rc-verify.yml#verify-attested-rc[2]',
    step: 'Set up verifier runtime',
    review: 'Installs the pinned Node.js runtime on the runner; writes only runner files.',
    files: [],
  },
  {
    sha256: 'ffb556b0e44a212cd031505dbb756ec4a6730a0ffe7464b26d84a234ba33ea83',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[3]',
    step: 'Materialize protected DEVAI verifier package',
    review: READ_ONLY_LOCAL,
    files: [],
  },
  {
    sha256: '021c2f0c64db13239986fbe2d017c9445d5bf7ded6c041647d81a152e2702105',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[4]',
    step: 'Bind candidate and protected evidence tag',
    review:
      'Reads the candidate checkout and the protected evidence tag through GET API calls and writes only step outputs; makes no external write.',
    files: [],
  },
  {
    sha256: '1b8a008c09ce4ada400dd7f30b0eb80acd1c115374f649a7c26f9f349bcc949e',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[5]',
    step: 'Check out immutable proof commit',
    review: READ_ONLY_CHECKOUT,
    files: [],
  },
  {
    sha256: 'afb8b1c21feebcf5eb3a4f28d3202158f56367795505acbcdba1e726f2c09e8c',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[6]',
    step: 'Materialize inert versioned proof payload',
    review: READ_ONLY_LOCAL,
    files: [],
  },
  {
    sha256: 'a96feb923517b0075749ddc83c3cb689bbafaaa20e9ccb6aae907a52c43d2d0a',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[7]',
    step: 'Reconstruct exact RC task policy',
    review: READ_ONLY_LOCAL,
    files: [],
  },
  {
    sha256: 'c7ea134693c69c74f570ab50d13cef4e5ce20cdeb5d7391a69fee1f9fd977a45',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[8]',
    step: 'Verify complete trusted local RC bundle',
    review: READ_ONLY_LOCAL,
    files: [],
  },
  {
    sha256: 'f95fb88abfd9c1dc7eaa2942d64048312eb130ca5a9bac4437cf4e30cedf34f7',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[9]',
    step: 'Build concise verification artifact',
    review: READ_ONLY_LOCAL,
    files: [],
  },
  {
    sha256: '48b68067200275b43233f105a4b05c52dcc5bee81834addf6b1c6abd0f8871dc',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[10]',
    step: 'Upload verification summary',
    review: READ_ONLY_ARTIFACT,
    files: [],
  },
  {
    sha256: '6a5c7cd4c075f80827e21a334c173b2fb3c60e402f4c532e786359602bc559e9',
    effect: 'publication',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[11]',
    step: 'Publish candidate check',
    review:
      'POSTs the verified-local-rc check run for the candidate commit to the repository check-runs API: an externally visible verification surface, so it runs only under the commit-keyed, non-cancelling lock.',
    files: [],
  },
  {
    sha256: 'd2c31f82fcea6edb2bd3d5892aebe74c3c303c2abbe547bdef2a23fcd0f2f3c1',
    effect: 'read-only',
    workflow: 'generated:devai-local-rc-verify.yml#verify-attested-rc[12]',
    step: 'Enforce verification result',
    review: 'Fails the job unless verification succeeded; writes nothing.',
    files: [],
  },
  {
    sha256: 'f38a912061e93f32b99bdff0ffcc346114049b38295a4b6a445c46c55d9f42d6',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[0]',
    step: 'actions/checkout',
    review:
      'Checks out the exact pushed commit with full history; selects source, publishes nothing.',
    files: [],
  },
  {
    sha256: 'fb7d213d16a53d2bfce50d488f1e18273dc28fbd9ae3e294479030b6bb834884',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[1]',
    step: 'actions/setup-node',
    review:
      'Installs the pinned Node.js runtime and writes the GitHub Packages registry configuration on the runner; writes only runner files.',
    files: [],
  },
  {
    sha256: '8443c17d577cbd5dc4941b15f4d78f3eb8bc114d1752f9749802d3d1d4a35e0f',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[2]',
    step: 'Install exact workspace',
    review:
      'Fails closed without the packages read token, then installs the frozen lockfile with --ignore-scripts, so no dependency or repository lifecycle script runs; writes only the workspace.',
    files: [],
  },
  {
    sha256: '0b342bf01479e1fcf8839544d62a12175f34d591f119279f47e1a5170df07268',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[3]',
    step: 'Verify bound posture',
    review: 'Runs devai doctor, which reads the repository and reports; writes nothing.',
    files: [],
  },
  {
    sha256: 'b27386d977b5db8c76c40d85ce8ade5552c00789e288108f1447c69f72e49285',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[4]',
    step: 'Observe exact main SHA',
    review:
      'Runs the auditor observation of the exact pushed commit, writing only its observation under .devai/state in the workspace.',
    files: [],
  },
  {
    sha256: '9b7866fc3bbb7b43699e79a0842e6f6beccd279e4613d0c937dd94f344159526',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[5]',
    step: 'Select supported provenance mode',
    review:
      'Selects the provenance mode from the event repository facts; writes only step outputs.',
    files: [],
  },
  {
    sha256: '34fd4a179792a4e8f80a4dd3cdbbaabd31064c8cf3ae1d7b9ff2ec0381291162',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[6]',
    step: 'Prepare exact observation provenance',
    review: READ_ONLY_LOCAL,
    files: [],
  },
  {
    sha256: '24a8403364f22010b858bc0716ddbe5b1f823cf957f52807012dbc01478d919d',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[7]',
    step: 'actions/upload-artifact',
    review: READ_ONLY_ARTIFACT,
    files: [],
  },
  {
    sha256: '3fdc0c4bb7f0fd0098353ad370da327cd505d938d5ce8e1651f1297004d1721b',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[8]',
    step: 'Verify immutable observation artifact binding',
    review: READ_ONLY_LOCAL,
    files: [],
  },
  {
    sha256: '9f74063bf6492a716b153e88f17ea823ec06c60765fcfd6540fabb28e705ad1b',
    effect: 'publication',
    workflow: 'generated:devai-main-observation.yml#observe[9]',
    step: 'actions/attest-build-provenance',
    review:
      'Creates a signed build-provenance attestation for the observation files through the OIDC token: an external attestation surface, so it runs only under the commit-keyed, non-cancelling lock.',
    files: [],
  },
  {
    sha256: 'c539bd1949ab2306502d020edd30eda874578730dc1870f224fec712c5b2d230',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[10]',
    step: 'Record explicit provenance result',
    review: READ_ONLY_LOCAL,
    files: [],
  },
  {
    sha256: 'cfc884ad7843cc71fa73936e87958faadfb13820d8838c52774cc4582e23ea6d',
    effect: 'read-only',
    workflow: 'generated:devai-main-observation.yml#observe[11]',
    step: 'actions/upload-artifact',
    review: READ_ONLY_ARTIFACT,
    files: [],
  },
  {
    sha256: '926ee0c07d725daed025486a481f5438345d0de9db603c990e644e983424ba59',
    effect: 'publication',
    workflow: 'generated:devai-main-observation.yml#observe[12]',
    step: 'Publish dedicated audit ref with explicit consent',
    review:
      'Runs only on a dispatch with publish_observation and the repository consent variable; pushes the observation commit to refs/devai/post-merge/<sha>, never a branch: an external audit surface, so it runs only under the commit-keyed, non-cancelling lock.',
    files: [],
  },
];

/**
 * Both sections keyed by digest. A generated step byte-identical to a repository step shares
 * its entry: the occurrence is added to that entry rather than registering the digest twice.
 */
function mergeByDigest(
  sections: readonly (readonly ReviewedWorkflowStep[])[],
): readonly ReviewedWorkflowStep[] {
  const merged = new Map<string, ReviewedWorkflowStep>();
  for (const entry of sections.flat()) {
    const existing = merged.get(entry.sha256);
    if (existing === undefined) merged.set(entry.sha256, entry);
    else if (existing.effect !== entry.effect) {
      throw new Error(`reviewed workflow step ${entry.sha256} is reviewed with two effects`);
    } else
      merged.set(entry.sha256, {
        ...existing,
        workflow: `${existing.workflow}, ${entry.workflow}`,
      });
  }
  return [...merged.values()];
}

export const REVIEWED_WORKFLOW_STEPS: readonly ReviewedWorkflowStep[] = Object.freeze(
  mergeByDigest([REPOSITORY_WORKFLOW_STEPS, GENERATED_WORKFLOW_STEPS]),
);
