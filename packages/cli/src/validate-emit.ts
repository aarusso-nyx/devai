import { EXIT_CONFIG } from '@devai-nyx/utils';

/**
 * Structural type matching ajv's compiled ValidateFunction. We don't
 * import from `ajv` directly because `@aarusso-nyx/devai` doesn't depend on
 * ajv — the validators are obtained via `@devai-nyx/schemas`. Keeping the
 * type structural avoids dragging ajv into the cli package's dep
 * graph.
 */
interface Validator {
  (instance: unknown): boolean;
  errors?: unknown;
}

/**
 * Validate a contract instance against its JSON Schema before emitting.
 *
 * Every CLI command that emits a JSON instance of a contract type
 * (Task, Scorecard, Triage, PromptComposition, SensorReading, …) must
 * call one of these helpers on the emit path. Schema drift is a hard-gate
 * failure (CLAUDE.md §"Schema instances validate against schemas").
 *
 * Two modes:
 *
 *   - `validateOrExit`: hard-fail. Exits with EXIT_CONFIG (65) on
 *     validation failure. Use for emit paths whose runtime shape is
 *     known to conform.
 *
 *   - `validateOrWarn`: soft-fail. Writes a warning to stderr and
 *     continues. Use as a transitional gate while the runtime payload
 *     is being reshaped to conform; drift is visible without breaking
 *     production. Returns `true` when the payload validates.
 */

export function validateOrExit(
  validator: Validator,
  instance: unknown,
  contractName: string,
  commandLabel: string,
): void {
  const ok = validator(instance);
  if (!ok) {
    process.stderr.write(
      `${commandLabel}: output does not validate against ${contractName}.schema.json: ${JSON.stringify(validator.errors)}\n`,
    );
    process.exit(EXIT_CONFIG);
  }
}

export function validateOrWarn(
  validator: Validator,
  instance: unknown,
  contractName: string,
  commandLabel: string,
): boolean {
  const ok = validator(instance);
  if (!ok) {
    process.stderr.write(
      `${commandLabel}: WARN schema drift — output does not validate against ${contractName}.schema.json (Batch A.1 will reshape): ${JSON.stringify(validator.errors)}\n`,
    );
  }
  return ok === true;
}
