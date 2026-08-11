import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '@devai-nyx/authority';
import { dirname, join } from 'node:path';
import { validators } from '@devai-nyx/schemas';
import { buildSensorReading, type SensorReading, type SensorStatus } from './sensor-reading.js';
import type { DataModelBody, DataModelColumn, DataModelTable } from './inventory-data-model.js';

/**
 * Inventory sensor: data-handling / PII column classification
 * (DEVAI-native, Phase 17.C3).
 *
 * Consumes a data-model body (record/proofs/sensors/inventory_data_model/
 * data-model.json by default) and produces a *seeded* data-model with
 * each column's `pii_class` set via name + type heuristics:
 *
 *   - contact      → email, phone, telephone, cellphone, whatsapp, fax
 *   - identity     → cpf, cnpj, rg, ssn, passport, national_id, document
 *   - credentials  → password, password_hash, password_digest, secret, api_key, token, recovery_code
 *   - financial    → credit_card, card_number, iban, account_number, bank_code, routing_number
 *   - location     → address, street, postal_code, zip, latitude, longitude, city, state, country
 *   - personal     → full_name, first_name, last_name, birth_date, dob, gender
 *   - health       → diagnosis, medical_record, prescription, blood_type
 *   - ip           → ip_address, remote_addr, user_agent
 *
 * The output is a re-emission of the data-model body with `pii_class`
 * set on matching columns; `legal_basis` and `retention` are left
 * unset so the Architect (or a stack-adapter pack) can supply them.
 *
 * INV-INVENTORY-002 (Phase 17.D, severity hard-fail) consumes this
 * output: every column with a non-empty pii_class must also have
 * legal_basis and retention. The Architect's curation closes that gap.
 *
 * Per Constitution Article 17 (sensor adapter uniformity); per D-57.
 */

interface PiiRule {
  readonly piiClass: string;
  readonly namePatterns: readonly RegExp[];
}

const PII_RULES: readonly PiiRule[] = [
  {
    piiClass: 'contact',
    namePatterns: [
      /^email$/i,
      /_email$/i,
      /^phone$/i,
      /_phone$/i,
      /^telephone$/i,
      /^cellphone$/i,
      /^whatsapp$/i,
      /^fax$/i,
    ],
  },
  {
    piiClass: 'identity',
    namePatterns: [
      /^cpf$/i,
      /^cnpj$/i,
      /^rg$/i,
      /^ssn$/i,
      /^passport$/i,
      /^national_id$/i,
      /^document(_number)?$/i,
      /^tax_id$/i,
    ],
  },
  {
    piiClass: 'credentials',
    namePatterns: [
      /^password(_hash|_digest)?$/i,
      /^secret$/i,
      /_secret$/i,
      /^api_?key$/i,
      /^token$/i,
      /_token$/i,
      /^recovery_code$/i,
      /^otp_secret$/i,
    ],
  },
  {
    piiClass: 'financial',
    namePatterns: [
      /^credit_card(_number)?$/i,
      /^card_number$/i,
      /^iban$/i,
      /^account_number$/i,
      /^bank_code$/i,
      /^routing_number$/i,
    ],
  },
  {
    piiClass: 'location',
    namePatterns: [
      /^address$/i,
      /^street$/i,
      /^postal_code$/i,
      /^zip(_code)?$/i,
      /^latitude$/i,
      /^longitude$/i,
      /^city$/i,
      /^state$/i,
      /^country$/i,
    ],
  },
  {
    piiClass: 'personal',
    namePatterns: [
      /^full_?name$/i,
      /^first_?name$/i,
      /^last_?name$/i,
      /^birth_?date$/i,
      /^dob$/i,
      /^gender$/i,
    ],
  },
  {
    piiClass: 'health',
    namePatterns: [
      /^diagnosis$/i,
      /^medical_record$/i,
      /^prescription$/i,
      /^blood_type$/i,
      /^allergies$/i,
    ],
  },
  { piiClass: 'ip', namePatterns: [/^ip_address$/i, /^remote_addr$/i, /^user_agent$/i] },
];

function classifyColumn(col: DataModelColumn): string | null {
  for (const rule of PII_RULES) {
    if (rule.namePatterns.some((re) => re.test(col.name))) return rule.piiClass;
  }
  return null;
}

export interface InventoryDataHandlingOptions {
  readonly repoRoot: string;
  readonly dataModelPath?: string;
  readonly bodyPath?: string;
  /** False for pure observation callers that must not materialize canonical state. */
  readonly persistBody?: boolean;
  readonly now?: string;
}

export interface InventoryDataHandlingResult {
  readonly reading: SensorReading;
  readonly body: DataModelBody | null;
  readonly bodyPath: string | null;
}

export function senseInventoryDataHandling(
  opts: InventoryDataHandlingOptions,
): InventoryDataHandlingResult {
  const t0 = Date.now();
  const generatedAt = opts.now ?? new Date().toISOString();
  const dataModelPath =
    opts.dataModelPath ??
    join(opts.repoRoot, 'record/proofs/sensors/inventory_data_model/data-model.json');

  const findings: Array<{
    readonly severity: 'info' | 'warning' | 'error' | 'critical';
    readonly code: string;
    readonly message: string;
  }> = [];

  let status: SensorStatus = 'pass';
  let dataModel: DataModelBody | null = null;

  if (!existsSync(dataModelPath)) {
    status = 'review';
    findings.push({
      severity: 'warning',
      code: 'DATA_HANDLING_REQUIRES_DATA_MODEL',
      message: `Data-model body not found at ${dataModelPath}. Run 'devai sense run inventory_data_model' first.`,
    });
  } else {
    try {
      dataModel = JSON.parse(readFileSync(dataModelPath, 'utf8')) as DataModelBody;
    } catch (err) {
      status = 'error';
      findings.push({
        severity: 'critical',
        code: 'DATA_HANDLING_INVALID_DATA_MODEL',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let body: DataModelBody | null = null;
  let piiColumnCount = 0;
  let unlabeledPiiColumns = 0;
  if (dataModel !== null) {
    const tables: DataModelTable[] = dataModel.tables.map((t) => {
      const columns = t.columns.map((c) => {
        const piiClass = classifyColumn(c);
        if (piiClass === null) return c;
        piiColumnCount += 1;
        if (c.legal_basis === undefined || c.retention === undefined) unlabeledPiiColumns += 1;
        return { ...c, pii_class: piiClass };
      });
      return { ...t, columns };
    });
    body = { ...dataModel, generatedAt, tables };

    if (status === 'pass') {
      const ok = validators.dataModelInventory(body);
      if (!ok) {
        status = 'error';
        findings.push({
          severity: 'critical',
          code: 'DATA_HANDLING_SCHEMA_INVALID',
          message: `body fails data-model-inventory.schema.json: ${JSON.stringify(validators.dataModelInventory.errors)}`,
        });
      }
    }

    if (status === 'pass' && piiColumnCount === 0) {
      status = 'review';
      findings.push({
        severity: 'warning',
        code: 'DATA_HANDLING_NO_PII_DETECTED',
        message:
          "No columns matched any PII heuristic. Either the schema is genuinely PII-free, or the heuristics did not match the adopter's naming conventions.",
      });
    }
  }

  let bodyPath: string | null = null;
  if ((status === 'pass' || status === 'review') && body !== null && opts.persistBody !== false) {
    bodyPath =
      opts.bodyPath ??
      join(opts.repoRoot, 'record/proofs/sensors/inventory_data_handling/data-model-pii.json');
    try {
      mkdirSync(dirname(bodyPath), { recursive: true });
      writeFileSync(bodyPath, JSON.stringify(body, null, 2) + '\n');
    } catch (err) {
      status = 'error';
      bodyPath = null;
      findings.push({
        severity: 'critical',
        code: 'DATA_HANDLING_WRITE_FAILED',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const dhHash = createHash('sha256')
    .update(
      JSON.stringify(
        (body?.tables ?? []).flatMap((t) =>
          t.columns.map((c) => [t.name, c.name, c.pii_class ?? '']),
        ),
      ),
    )
    .digest('hex');

  const reading = buildSensorReading({
    sensorName: 'inventory:data-handling',
    sensorKind: 'inventory_data_handling',
    sensorVersion: '1.0.0',
    command: ['devai', 'sense', 'data-handling', '--repo-root', opts.repoRoot],
    status,
    deterministic: true,
    tier: 'L0',
    duration_ms: Date.now() - t0,
    timestamp: generatedAt,
    ...(findings.length > 0 && { findings }),
    metrics: {
      table_count: body?.tables.length ?? 0,
      pii_column_count: piiColumnCount,
      unlabeled_pii_column_count: unlabeledPiiColumns,
      data_handling_hash: dhHash,
    },
    ...(bodyPath !== null && { evidence_path: bodyPath }),
  });

  return { reading, body, bodyPath };
}
