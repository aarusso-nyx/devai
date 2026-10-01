# Export-intent fixtures

Fixtures for `packages/cli/tests/unit/evidence-export-intent-receipt.test.ts`, the inspector
acceptance of ADR-REL-0031 (IA-001 to IA-005). The test runs a real release-intent
preflight and certify run of the check runner over a throwaway candidate repository, then
drives the vendored `devai-evidence-export` CLI in
`packages/cli/vendor/evidence-verification/src/export-cli.js` against that run's receipts.

Nothing here is a credential, a host path, or a signing key. Commit and tree identities
are only known once the candidate repository exists, so the release intent and every
receipt are built at test time; the files below are the fixed inputs.

## Files

| File                   | Role                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test-tasks.json`      | The task descriptor committed as the candidate's `test-tasks.json`. Repository id `fixture/repository`; nodes `prepare`, `unit` (depends on `prepare`), and `docs`. |
| `release-profile.json` | The release verification profile. The eight preflight capabilities select `prepare`; `affected-checks`, `dependent-checks`, and `build-integrity` select `unit`.    |
| `toolchain.json`       | The toolchain map the run binds and the exporter receives as `--toolchain`.                                                                                         |
| `environment.json`     | The empty environment map passed as `--environment`; no task allowlists a variable.                                                                                 |

Every task's argv would write a sentinel file named `export-ran-a-task` beside the
candidate repository if it were ever executed. The run replaces execution with a stub, so
the sentinel can only appear if the exporter executes a task; its absence after an export
is the proof that no second `--rc` execution happens (IA-001).

The descriptor also declares two fixed profiles, `rc` (`prepare`, `unit`) and
`preflight-floor` (`prepare`). The intent path never names them. They let the test build an
independent oracle: with no mutation binding, protected executable identity, or preflight
probe node selected, the release task policy equals the schema 1.1 policy of the same node
set re-versioned to 1.2.0 with the exact-candidate-tree input projection. The test asserts
that premise against the run itself, and the canonical verifier tests rely on it.

## Repository built at test time

| Commit      | Content                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `genesis`   | `.gitignore` (ignores `.devai/state/`) and `docs/notes.md`. Used as a foreign base.         |
| `base`      | Adds `package.json` at version `1.0.0`, `src/a.js`, and `test-tasks.json` from this folder. |
| `candidate` | Bumps `package.json` to `1.0.1` and changes `src/a.js`.                                     |

The release intent is a stable patch (`1.0.0` to `1.0.1`, support `current`) with
`changed_paths` `package.json` and `src/a.js`, pinning `base` and `candidate`. The run
plans the certify population `prepare` and `unit` and the preflight population `prepare`.
The receipts, the release intent, the release profile, the copied task results, and
throwaway Ed25519 keys are written outside the candidate repository in the test's own
temporary directory, which is removed after each test.

## Alterations

Each rejection alters exactly one input of a passing export. Where the alteration would
otherwise be caught first by a pin, the test moves the preflight receipt's
`releaseIntentDigest` or `releaseProfileDigest` onto the altered value ("re-pin"), so the
named code is the only reason to refuse.

| Item   | Alteration                                                               | Expected code                  |
| ------ | ------------------------------------------------------------------------ | ------------------------------ |
| IA-001 | none                                                                     | export succeeds                |
| IA-002 | intent `changed_packages` edited after the run                           | `INTENT_DIGEST_MISMATCH`       |
| IA-002 | intent `channel` set to `beta` for a stable target, re-pinned            | `INTENT_DECISION_BLOCKED`      |
| IA-003 | `--release-stage preflight`                                              | `INTENT_STAGE_MISMATCH`        |
| IA-003 | the release preflight receipt passed as `--receipt`                      | `INTENT_STAGE_MISMATCH`        |
| IA-003 | release profile `policy_version` edited after the run                    | `INTENT_POLICY_STALE`          |
| IA-003 | candidate receipt `taskPolicyDigest` replaced                            | `POLICY_DIGEST_MISMATCH`       |
| IA-004 | `--base` set to `genesis`                                                | `INTENT_BASE_MISMATCH`         |
| IA-004 | preflight receipt `repository` set to the base commit and tree           | `INTENT_CANDIDATE_MISMATCH`    |
| IA-004 | candidate receipt `tasks` without `unit`                                 | `INTENT_POPULATION_INCOMPLETE` |
| IA-005 | `--profile` given a file path, a slash-separated id, or a bare file name | `PROFILE_ID_INVALID`           |
| IA-005 | `--profile not-declared`                                                 | `PROFILE_UNKNOWN`              |
| IA-005 | `--profile rc` on the receipt of an ordinary `rc` run                    | export succeeds, unchanged     |
| usage  | `--profile` mixed with the intent set, or one intent flag omitted        | `USAGE`                        |

The canonical verifier tests in `packages/cli/vendor/evidence-verification/test/` cover the
same codes with further alterations against the verifier source alone.
