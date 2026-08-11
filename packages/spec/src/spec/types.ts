export interface SpecValidationError {
  readonly file: string;
  /** JSON pointer to the offending field (RFC 6901) when applicable. */
  readonly pointer?: string;
  readonly message: string;
  /**
   * Phase 30 lane D: optional stable machine-readable code so downstream
   * consumers (e.g. `sense-spec-idiomaticity`) can distinguish
   * warning-grade signals (like `STATEMENT_LACKS_CNL_MODAL`) from
   * hard-fail errors without parsing the message text.
   */
  readonly code?: string;
  /** Optional severity. Defaults to 'error' when absent (back-compat). */
  readonly severity?: 'error' | 'warning' | 'info';
}

export interface SpecValidationResult {
  readonly ok: boolean;
  readonly errors: readonly SpecValidationError[];
  readonly files_scanned: number;
  /**
   * Phase 23.E (D-A-22): count of files matched by the prefix walker
   * but excluded by a companion-pattern filter (e.g. `*-allowlist.json`,
   * `*-data.json`). Used by callers that surface a "skipped N companion
   * file(s)" line in their summary. Optional + default `0` for
   * back-compat with pre-23.E callers.
   */
  readonly files_skipped?: number;
  readonly skipped_files?: readonly string[];
}
