// Internal host-only context; never selected from arguments or environment.
let active = false;
export function isDevaiRcCertification(): boolean {
  return active;
}
export async function withDevaiRcCertification<T>(operation: () => Promise<T>): Promise<T> {
  if (active) throw new Error('CHECK_RUNNER_RC_CERTIFICATION_ACTIVE');
  active = true;
  try {
    return await operation();
  } finally {
    active = false;
  }
}
