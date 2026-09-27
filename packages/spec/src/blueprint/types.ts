// ---------------------------------------------------------------------
// Types — public surface for the blueprint module.
// Mirrors module-blueprint.schema.json; uses unknown for opaque
// fields (abac.rules[].when) to preserve the schema's design intent.
// ---------------------------------------------------------------------

export type PiiLevel = 'none' | 'low' | 'high';
export type Retention = 'default' | '90d' | '1y' | 'forever';
export type Operation = 'list' | 'get' | 'create' | 'update' | 'delete';

export interface BlueprintField {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
  readonly default?: string;
  readonly unique?: boolean;
  readonly check?: string;
  readonly pii?: PiiLevel;
  readonly retention?: Retention;
}

export interface BlueprintRelation {
  readonly type: 'many-to-one' | 'one-to-many' | 'many-to-many' | 'one-to-one';
  readonly target: string;
  readonly onDelete?: 'no action' | 'cascade' | 'restrict' | 'set null';
  readonly joinTable?: string;
  readonly field?: string;
}

export interface BlueprintEntity {
  readonly name: string;
  readonly table?: string;
  readonly primaryKey?: readonly string[];
  readonly fields: readonly BlueprintField[];
  readonly relations?: readonly BlueprintRelation[];
  readonly indexes?: ReadonlyArray<{
    readonly name?: string;
    readonly columns: readonly string[];
    readonly unique?: boolean;
  }>;
}

export interface BlueprintResource {
  readonly entity: string;
  readonly path?: string;
  readonly operations?: readonly Operation[];
  readonly pagination?: 'limit-offset' | 'cursor' | 'none';
  readonly sort?: readonly string[];
  readonly filter?: readonly string[];
}

export interface BlueprintRbacPermission {
  readonly role: string;
  readonly allow: readonly string[];
}

export interface Blueprint {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly module: {
    readonly name: string;
    readonly namespace: string;
    readonly version: string;
    readonly owners?: readonly string[];
    readonly description?: string;
  };
  readonly database: {
    readonly entities: readonly BlueprintEntity[];
    readonly enums?: ReadonlyArray<{ readonly name: string; readonly values: readonly string[] }>;
  };
  readonly api?: {
    readonly basePath?: string;
    readonly resources?: readonly BlueprintResource[];
  };
  readonly auth?: {
    readonly rbac?: {
      readonly roles: readonly string[];
      readonly permissions: readonly BlueprintRbacPermission[];
    };
    readonly abac?: {
      readonly rules?: ReadonlyArray<{ readonly id: string; readonly when: unknown }>;
    };
  };
  readonly ui?: unknown;
  readonly events?: unknown;
  readonly audit?: unknown;
  readonly seed?: unknown;
  readonly ops?: unknown;
}
