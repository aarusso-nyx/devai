export const EXIT_PASS = 0;
export const EXIT_REVIEW = 1;
export const EXIT_FAIL = 2;
// R18.C.4 (D-133/M3): one usage contract, one code. D-129 made the router
// exit 2 on usage failures before side effects; the command layer kept the
// legacy sysexits EX_USAGE (64), so the CLI had two usage codes depending on
// which layer caught the mistake. Usage failures are fail-shaped by design
// (fail-closed): 64 is retired.
export const EXIT_USAGE = 2;
export const EXIT_CONFIG = 65;

export type ExitCode =
  typeof EXIT_PASS | typeof EXIT_REVIEW | typeof EXIT_FAIL | typeof EXIT_USAGE | typeof EXIT_CONFIG;
