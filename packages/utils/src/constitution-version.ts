const CONSTITUTION_VERSION_PATTERN =
  /^\*\*(?:Candidate version|Version):\*\*\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/mu;

export function parseConstitutionVersion(text: string): string | null {
  return CONSTITUTION_VERSION_PATTERN.exec(text)?.[1] ?? null;
}
