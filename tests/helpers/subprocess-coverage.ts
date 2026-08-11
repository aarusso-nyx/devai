export function subprocessCoverageEnvironment(): NodeJS.ProcessEnv {
  const directory = process.env['DEVAI_V8_SUBPROCESS_COVERAGE_DIR'];
  return directory === undefined ? process.env : { ...process.env, NODE_V8_COVERAGE: directory };
}
