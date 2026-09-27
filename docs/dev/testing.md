---
title: Writing and classifying tests
---

# Writing and classifying tests

This guide covers how a test's _content_ should be shaped and named so the F3 (Observation)
coverage sensors can measure it. For running test lanes, selecting suites, and the RC gate,
see [Testing operations](operations/testing.md).

## Security, performance, and robustness classification

`packages/sensors/src/test-security-coverage.ts`, `test-performance-coverage.ts`, and
`test-robustness-coverage.ts` each walk the test roots declared in
`.devai/config/sensor-inputs.json` (`packages/*/tests` and `tests`) and count how many test
files match a short list of keywords, either in their path or in their content
(`packages/sensors/src/test-pattern-walker.ts`). A file counts once it matches; thresholds are
read from the sensor itself (security pass at 5%, performance pass once at least one file
matches and coverage reaches 1%, robustness pass at 10%).

Rather than rely on those keywords matching by accident, classify a test deliberately with one
of two mechanisms, in order of preference:

1. **Filename segment.** Append `.sec`, `.perf`, or `.robust` immediately before `.test.ts`,
   e.g. `protected-sink-filesystem.sec.test.ts`, `dependency-security.sec.test.ts` (existing
   precedent), or `authority-final-boundary.red.robust.test.ts` (stacked after an existing
   `.red` tag, which marks an expected-refusal test). The bare words `sec`, `perf`, and
   `robust` are in each sensor's pattern list for exactly this purpose.
2. **`describe` prefix.** When a file's path is named in `law/trace.json` and therefore cannot
   be renamed (Inspector-owned trace linkage is outside this convention's boundary), prefix the
   top-level `describe` title with `sec:`, `perf:`, or `robust:` instead, e.g.
   `describe('sec: preflight diagnostics redaction (ADR-CHK-0001 IA-004)', ...)`. The sensor
   matches this the same way, via file content, so no filename change or trace edit is needed.

Apply either mechanism only to a test that is genuinely a security, performance, or robustness
observation:

- **Security** — authority or permission refusals, forbidden-action boundaries, credential or
  secret handling, injection/XSS/CSRF-style input rejection.
- **Performance** — throughput, latency, or benchmark fixtures; load and capacity tests.
- **Robustness** — error-contract tests (a specific failure mode or error code is asserted),
  timeout and retry behavior, chaos/fault-injection cases.

Never rename or wrap a test to force a sensor to pass. Never change an assertion, and never add
a placeholder test, to satisfy a coverage sensor. A test is classified because it already
observes the property in question.
