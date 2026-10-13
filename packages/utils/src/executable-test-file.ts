/** Filename conventions shared by trace targets and executable test populations. */
export function executableTestKind(
  path: string,
): 'test' | 'spec' | 'e2e' | 'wiring-spec' | undefined {
  const match = /\.(test|spec|e2e|wiring-spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.exec(path);
  return match?.[1] as 'test' | 'spec' | 'e2e' | 'wiring-spec' | undefined;
}

export function isExecutableTestFile(path: string): boolean {
  return executableTestKind(path) !== undefined;
}
