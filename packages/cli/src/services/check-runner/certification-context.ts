// Internal host-only context; never selected from arguments or environment.
let active: string | undefined;
export function isDevaiRcCertification(): boolean {
  return active !== undefined;
}
export function devaiRcCertificationCacheRoot(): string | undefined {
  return active;
}
export async function withDevaiRcCertification<T>(
  cacheRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (active !== undefined) throw new Error('CHECK_RUNNER_RC_CERTIFICATION_ACTIVE');
  active = cacheRoot;
  try {
    return await operation();
  } finally {
    active = undefined;
  }
}
