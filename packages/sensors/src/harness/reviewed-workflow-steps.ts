/**
 * Reviewed workflow steps (#325). The harness effect analysis cannot prove every step the
 * DEVAI workflows run: checkouts select a ref and path, the toolchain action takes inputs,
 * and the run scripts use shell the closed command grammar refuses. Each entry below names
 * one exact step by the sha256 of its canonical YAML and records the effect a reviewer
 * assigned it. Any edit to the step changes its digest, so an edited step is analysed again
 * and reads unknown until it is reviewed anew; ADR-REL-0034 keeps unknown effects findings.
 *
 * `publication` marks a step that writes an external release surface; every other entry
 * writes only the workspace, runner files or step outputs. The registry test
 * (packages/sensors/tests/unit/reviewed-workflow-steps.test.ts) fails on an entry whose
 * occurrences differ from the current workflows and names every job left unproved; the
 * digests of a job's steps come from `workflowStepInventory` in workflow-parser.ts.
 */
export interface ReviewedWorkflowStep {
  readonly sha256: string;
  readonly effect: 'read-only' | 'publication';
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
}

export const REVIEWED_WORKFLOW_STEPS: readonly ReviewedWorkflowStep[] = Object.freeze([
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
    workflow: 'pull-request-checks.yml#preflight[0]',
    step: 'Check out exact candidate',
    review:
      "Checks out ${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }} into the workspace without persisted credentials; selects source, publishes nothing.",
    files: [],
  },
  {
    sha256: 'b7ed7ae3efcf18f796d7496b73aa9531724d8c844932e1d114d38937fa9b7018',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#preflight[1]',
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
    workflow: 'pull-request-checks.yml#preflight[2]',
    step: 'Restore the check runner bootstrap',
    review:
      'Restores the bootstrap runner keyed by the hash of every input it compiles (ADR-CHK-0003); a stale key only recompiles. The following run steps are reviewed with this restore in view.',
    files: [],
  },
  {
    sha256: 'cc1e66490d45c8a0c7e27631e02d7ae958794240fc4ba39f1827940befb20643',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#preflight[3]',
    step: 'Compile the check runner bootstrap',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'package.json',
        sha256: 'e25301e562bbe9938a02f44aab6937c7aa177b30b3bf6b207b5c285ccf9137e3',
      },
      {
        path: 'scripts/process/bootstrap-check-runner.mjs',
        sha256: 'cc2e1f307390ba7db8c0666a0a2ea15780d19c4657d8d3cd656d796b6a63e4e6',
      },
    ],
  },
  {
    sha256: '8b7b48e343a0f1e593f5ee0c40d28158841a79e234c03f1deb517340f540bc2b',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#preflight[4]',
    step: 'Preflight probes',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [],
  },
  {
    sha256: '2a80e1d207149e628fa84709334191b84bce4640415da8576adb4c6f10d51da2',
    effect: 'read-only',
    workflow: 'pull-request-checks.yml#preflight[5]',
    step: 'Affected checks and profile-selected candidate preflight',
    review:
      'Local verification, build, or binding step: writes only the workspace, runner files, or step outputs, and makes no external write.',
    files: [
      {
        path: 'package.json',
        sha256: 'e25301e562bbe9938a02f44aab6937c7aa177b30b3bf6b207b5c285ccf9137e3',
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
        sha256: 'e25301e562bbe9938a02f44aab6937c7aa177b30b3bf6b207b5c285ccf9137e3',
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
        sha256: '5a75e4f36f8d603efe7e1449bfa60ab4d0413d790360df119f4f716aa9a08168',
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
        sha256: 'e25301e562bbe9938a02f44aab6937c7aa177b30b3bf6b207b5c285ccf9137e3',
      },
      {
        path: 'packages/authority/package.json',
        sha256: '18a1316615ca97e9e23d636901d5241d184764b42b8ce9ea98ebeaf41972ea3f',
      },
      {
        path: 'packages/cli/package.json',
        sha256: '0cdc5824b1047d911fd6088dcd34b1438c381fe2fb645c94d354ef4f3114978d',
      },
      {
        path: 'packages/cli/scripts/assemble-package.mjs',
        sha256: 'b7ccff5df58df6f47fa38c2d903870e2202464c3512439b3b1218272abe5dcc1',
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
        sha256: 'e9bf0e8593584e7b87ee31f30c4435a9bd644c699bc6cde779a2327829b15a17',
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
        sha256: '7e6f11eb5fedcd4146737a5f1b49d06a7c6772a4cd3fa3f24bfc80037242352a',
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
        path: 'scripts/generate-action-registry.mjs',
        sha256: '6c6ff06564fa19539adec3c750351b78e4f3383e102dca60799ec87af78a82ea',
      },
      {
        path: 'scripts/generate-error-code-reference.mjs',
        sha256: '5ebbd049a38676d8d205cbe04a10dd7bddbc7564e9d7822c4f4c326b3b74b96d',
      },
      {
        path: 'scripts/generate-scorecard-page.mjs',
        sha256: 'd558520cc9a8883d069205a3069777c075d93c1a2a8602de10267913ed243e40',
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
        sha256: '55015927c7a23b5a1ab21d2c60a59df9394340905ef3ee6eb90e4edc2493abd2',
      },
      {
        path: 'scripts/create-release-manifest.mjs',
        sha256: '495787f4705c8f8ddfbb6db148a8fb41f8334e149fa27a3d9910d48606c15cc4',
      },
      {
        path: 'scripts/process/verify-pages-bytes.mjs',
        sha256: 'ffc5f0f64d50c410deb5011c2b532e28305887c60e532e26be4019d4b2a8bec7',
      },
      {
        path: 'scripts/stage-release-package.mjs',
        sha256: '42743ce917956fd0d4020d76cde8b20807af44478b361c70e05078c9f324cd69',
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
        sha256: 'e25301e562bbe9938a02f44aab6937c7aa177b30b3bf6b207b5c285ccf9137e3',
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
        sha256: 'e25301e562bbe9938a02f44aab6937c7aa177b30b3bf6b207b5c285ccf9137e3',
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
        path: 'scripts/process/publish-pages.mjs',
        sha256: 'dba4da9070d2e9742dd507deac35810f67e757532bbaf0b4933e94f86b9abf82',
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
    workflow: 'site-publish.yml#prepare-site[1], site-publish.yml#publish-site[1]',
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
        sha256: '5a75e4f36f8d603efe7e1449bfa60ab4d0413d790360df119f4f716aa9a08168',
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
        path: 'scripts/process/verify-site-preparation-artifact.mjs',
        sha256: '6e1e2593935a208d5b0eb47ac655ba32be6cc4ef2042be340dfe55c956329853',
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
        path: 'scripts/process/publish-site.mjs',
        sha256: 'e88d9eeb6734adee1783ef7da410b65e36f6ddfaa12d7f9c26478f8c40987a7c',
      },
      {
        path: 'scripts/process/verify-site-preparation-artifact.mjs',
        sha256: '6e1e2593935a208d5b0eb47ac655ba32be6cc4ef2042be340dfe55c956329853',
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
]);
