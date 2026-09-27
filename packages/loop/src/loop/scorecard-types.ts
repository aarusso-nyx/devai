/** Verdict values per scorecard.schema.json (UPPERCASE). */
export type CellVerdict = 'PASS' | 'REVIEW' | 'FAIL' | 'N/A' | 'UNKNOWN';
export type AggregateVerdict = 'PASS' | 'REVIEW' | 'FAIL' | 'UNKNOWN';
export type Substrate = 'F1' | 'F2' | 'F3' | 'F4' | 'F5';
export type Property = 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9';

export interface ScorecardCell {
  substrate: Substrate;
  property: Property;
  verdict: CellVerdict;
  deterministic: boolean;
  score?: number | null;
  confidence?: { score?: number; interval_low?: number; interval_high?: number };
  sensor_readings?: string[]; // SR-... ids
  evidence_refs?: string[]; // EV-... ids
  notes?: string;
}

export interface SubstrateAggregate {
  verdict: AggregateVerdict;
  score?: number;
}

export interface InvariantRollup {
  invariant_id: string; // INV-...
  verdict: 'PASS' | 'REVIEW' | 'FAIL' | 'UNCOVERED';
  test_pass_count?: number;
  test_fail_count?: number;
  trace_resolved?: boolean;
}

export interface Scorecard {
  schemaVersion: '1.0.0';
  id: string; // SC-YYYYMMDDThhmmss-NNN
  generated_at: string;
  integration_head: string;
  previous_scorecard_id?: string | null;
  thresholds_used: { source: string; hash?: string };
  cells: ScorecardCell[];
  substrate_aggregates: Partial<Record<Substrate, SubstrateAggregate>>;
  invariant_rollups: InvariantRollup[];
  quarantine_count?: number;
  overall: { verdict: AggregateVerdict; score?: number; narrative?: string };
}
