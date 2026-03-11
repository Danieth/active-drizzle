/**
 * Takes validated ProjectMeta and emits generated file contents as strings.
 * Pure function: (ProjectMeta) → GeneratedFile[]
 *
 * Per model generates:
 *   - <ModelName>.model.gen.d.ts   (type declarations, module augmentation, interfaces)
 *   - <ModelName>.model.gen.ts     (Asset.Client runtime class — executable code)
 */

import type {
  ModelMeta,
  ProjectMeta,
  EnumMeta,
  EnumGroupMeta,
  AssociationMeta,
  ScopeMeta,
  ColumnMeta,
  InstanceMethodMeta,
} from './types.js';

import pluralize from 'pluralize';

export type GeneratedFile = {
  path: string;
  content: string;
};

export function generate(project: ProjectMeta): GeneratedFile[] {
  // Cache association → class-name lookups within a single generate() pass.
  // resolveAssocClass is called 5-6× per association, so this avoids O(n·assocs) scans.
  _resolveAssocCache = new Map();

  const files: GeneratedFile[] = [];

  for (const model of project.models) {
    const base = model.filePath.split('/').pop()!.replace('.model.ts', '.model.gen');
    files.push({ path: `${base}.d.ts`, content: generateModelTypes(model, project) });
    files.push({ path: `${base}.ts`, content: generateClientRuntime(model, project) });
  }

  files.push({
    path: '_registry.gen.ts',
    content: generateRegistry(project),
  });

  files.push({
    path: '.active-drizzle/schema.md',
    content: generateDocs(project),
  });

  files.push({
    path: '_globals.gen.d.ts',
    content: generateGlobals(project),
  });

  return files;
}

/**
 * Generates the `.gen.d.ts` file for a model: pure type declarations.
 *
 * Structure:
 *   declare module './Model.model' {
 *     interface Model { ...instance augmentation... }
 *     namespace Model { ...static augmentation (scopes, where, etc.)... }
 *   }
 *   export type ModelRecord = ...
 *   export interface ModelAssociations { ... }
 *   export interface ModelWhere { ... }
 *   export interface ModelCreate { ... }
 *   export type ModelUpdate = ...
 */
export function generateModelTypes(model: ModelMeta, project: ProjectMeta): string {
  const lines: string[] = [];
  const recordName = `${model.className}Record`;
  const table = project.schema.tables[model.tableName];

  lines.push(`// AUTO-GENERATED — do not edit manually`);
  lines.push(`import type { Relation, IncludeArg, MapInclude } from 'active-drizzle'`);
  lines.push('');

  // ── Instance augmentation ─────────────────────────────────────────────
  lines.push(`declare module './${model.className}.model' {`);
  lines.push(`  interface ${model.className} {`);
  lines.push(`    readonly _associations: ${model.className}Associations;`);

  for (const assoc of model.associations) {
    const assocLine = generateAssociationType(assoc, model, project);
    if (assocLine) lines.push(`    ${assocLine}`);
  }

  for (const enumDef of model.enums) {
    for (const key of Object.keys(enumDef.values)) {
      const pascal = capitalize(key);
      lines.push(`    is${pascal}(): boolean`);
      lines.push(`    to${pascal}(): ${recordName}`);
    }
    lines.push(`    readonly ${enumDef.propertyName}: ${JSON.stringify(enumDef.values).replace(/"/g, '')}`);
  }

  for (const group of model.enumGroups) {
    lines.push(`    is${capitalize(group.propertyName)}(): boolean`);
  }

  if (table) {
    for (const col of table.columns) {
      if (col.primaryKey) continue;
      const tsType = columnToTsType(col);
      lines.push(`    ${col.name}Changed(): boolean`);
      lines.push(`    ${col.name}Was(): ${tsType}`);
      lines.push(`    ${col.name}Change(): [${tsType}, ${tsType}] | null`);
    }
  }

  lines.push(`    isChanged(): boolean`);
  lines.push(`    changedFields(): string[]`);
  lines.push(`    changes: Record<string, [unknown, unknown]>`);
  lines.push(`    previousChanges: Record<string, [unknown, unknown]>`);
  lines.push(`    restoreAttributes(): void`);

  for (const method of model.instanceMethods) {
    const paramStr = method.parameters.map(p => `${p.name}: ${p.type}`).join(', ');
    lines.push(`    ${method.name}(${paramStr}): ${method.returnType}`);
  }

  lines.push(`  }`);

  // ── Static augmentation — uses namespace merging ──────────────────────
  lines.push(`  namespace ${model.className} {`);
  lines.push(`    function all(): Relation<${recordName}, ${model.className}Associations>`);
  lines.push(`    function where(condition?: ${model.className}Where): Relation<${recordName}, ${model.className}Associations>`);
  lines.push(`    function includes<TArg extends IncludeArg<${model.className}Associations>, TArgs extends IncludeArg<${model.className}Associations>[]>(arg: TArg, ...args: TArgs): Relation<${recordName} & MapInclude<${model.className}Associations, TArg> & MapInclude<${model.className}Associations, TArgs[number]>, ${model.className}Associations>`);
  lines.push(`    function first(): Promise<${recordName} | null>`);
  lines.push(`    function find(id: number | string): Promise<${recordName}>`);

  const allScopes = collectAllScopes(model, project);
  for (const scope of allScopes) {
    if (scope.isComputed) {
      // @computed scopes return aggregate data, not a Relation
      const paramStr = scope.parameters.map(p => `${p.name}: ${p.type}`).join(', ');
      lines.push(`    function ${scope.name}(${paramStr}): Promise<unknown>`);
    } else if (scope.isZeroArg) {
      lines.push(`    const ${scope.name}: Relation<${recordName}, ${model.className}Associations>`);
    } else {
      const paramStr = scope.parameters.map(p => `${p.name}: ${p.type}`).join(', ');
      lines.push(`    function ${scope.name}(${paramStr}): Relation<${recordName}, ${model.className}Associations>`);
    }
  }

  for (const group of model.enumGroups) {
    lines.push(`    const ${group.propertyName}: Relation<${recordName}, ${model.className}Associations>`);
  }

  for (const enumDef of model.enums) {
    lines.push(`    const ${enumDef.propertyName}: { ${Object.entries(enumDef.values).map(([k, v]) => `${k}: ${v}`).join('; ')} }`);
  }

  // Client class type declaration (implementation lives in .gen.ts)
  lines.push(`    class Client {`);
  if (table) {
    for (const col of table.columns) {
      const tsType = columnToTsType(col);
      const isOptional = col.nullable || col.hasDefault;
      lines.push(`      ${col.name}${isOptional ? '?' : ''}: ${tsType};`);
    }
  }
  for (const assoc of model.associations) {
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass) continue;
    if (assoc.kind === 'hasMany' || assoc.kind === 'habtm') {
      lines.push(`      ${assoc.propertyName}: ${targetClass}.Client[];`);
    } else {
      const nullable = assoc.kind === 'belongsTo' ? isBelongsToNullable(assoc, model, project) : true;
      lines.push(`      ${assoc.propertyName}: ${targetClass}.Client${nullable ? ' | null' : ''};`);
    }
  }
  for (const method of model.instanceMethods) {
    if (method.isServerOnly || method.isValidation) continue;
    const paramStr = method.parameters.map(p => `${p.name}: ${p.type}`).join(', ');
    lines.push(`      ${method.name}(${paramStr}): ${method.returnType}`);
  }
  lines.push(`      constructor(payload?: Record<string, any>)`);
  lines.push(`      toJSON(): Record<string, unknown>`);
  lines.push(`      isChanged(): boolean`);
  lines.push(`      restoreAttributes(): void`);
  lines.push(`      validate(path?: string): Record<string, string[]>`);
  lines.push(`    }`);

  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');

  // ── Stand-alone exports ───────────────────────────────────────────────
  lines.push(`export type ${recordName} = InstanceType<typeof import('./${model.className}.model').${model.className}>`);
  lines.push('');

  lines.push(`// --- Advanced Type Sorcery ---`);
  lines.push(`export interface ${model.className}Associations {`);
  for (const assoc of model.associations) {
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass) continue;
    if (assoc.kind === 'belongsTo' || assoc.kind === 'hasOne') {
      const nullable = assoc.kind === 'belongsTo' ? isBelongsToNullable(assoc, model, project) : true;
      lines.push(`  ${assoc.propertyName}: ${targetClass}Record${nullable ? ' | null' : ''};`);
    } else {
      lines.push(`  ${assoc.propertyName}: ${targetClass}Record[];`);
    }
  }
  lines.push(`}`);
  lines.push('');

  const enumByProp = new Map(model.enums.map(e => [e.propertyName, e]));

  lines.push(`export interface ${model.className}Where {`);
  lines.push(`  [key: string]: unknown`);
  if (table) {
    for (const col of table.columns) {
      const enumDef = enumByProp.get(col.name);
      let baseType: string;
      if (enumDef) {
        const labels = Object.keys(enumDef.values).map(k => `'${k}'`).join(' | ');
        baseType = `${labels} | number`;
      } else {
        baseType = columnToTsType(col).replace(' | null', '');
      }
      lines.push(`  ${col.name}?: (${baseType}) | (${baseType})[] | null | Relation`);
    }
  }
  lines.push(`}`);
  lines.push('');

  lines.push(`export interface ${model.className}Create {`);
  if (table) {
    for (const col of table.columns) {
      // Skip columns the database assigns automatically — providing them would be ignored
      // or rejected (GENERATED ALWAYS AS IDENTITY) by Postgres.
      if (col.isGenerated) continue;
      // Skip serial/identity PKs — auto-assigned by a sequence.
      if (col.primaryKey && (col.type === 'serial' || col.type === 'smallserial' || col.type === 'bigserial')) continue;
      // Skip conventional timestamp columns that always use defaultNow().
      if (['createdAt', 'updatedAt', 'created_at', 'updated_at'].includes(col.name) && col.hasDefault) continue;
      const enumDef = enumByProp.get(col.name);
      let tsType: string;
      if (enumDef) {
        const labels = Object.keys(enumDef.values).map(k => `'${k}'`).join(' | ');
        tsType = col.nullable ? `${labels} | null` : labels;
      } else {
        tsType = columnToTsType(col);
      }
      const isOptional = col.nullable || col.hasDefault;
      lines.push(`  ${col.name}${isOptional ? '?' : ''}: ${tsType};`);
    }
  }
  // acceptsNestedAttributesFor: embed nested Create type recursively
  for (const assoc of model.associations) {
    if (!assoc.acceptsNested) continue;
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass) continue;
    lines.push(`  ${assoc.propertyName}Attributes?: ${targetClass}Create[];`);
  }
  lines.push(`}`);
  lines.push('');

  lines.push(`export type ${model.className}Update = Partial<${model.className}Create> & { id: number };`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Generates the `.gen.ts` file for a model: the executable Asset.Client class.
 *
 * Attaches the Client class to the model constructor at runtime so that
 * `new Asset.Client(payload)` works after importing this file (or the registry).
 * Also re-declares the type shape via `declare module` for TypeScript merging.
 */
export function generateClientRuntime(model: ModelMeta, project: ProjectMeta): string {
  const lines: string[] = [];
  const table = project.schema.tables[model.tableName];

  // Collect all associated model classes that need to be imported
  const assocImports = new Map<string, string>(); // className → filePath basename
  for (const assoc of model.associations) {
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass || targetClass === model.className || assocImports.has(targetClass)) continue;
    const assocModel = project.models.find(m => m.className === targetClass);
    if (assocModel) {
      assocImports.set(targetClass, assocModel.filePath.split('/').pop()!.replace('.ts', ''));
    }
  }

  lines.push(`// AUTO-GENERATED — do not edit manually`);
  lines.push(`import { ${model.className} as _${model.className} } from './${model.className}.model.js'`);
  for (const [cls, basename] of assocImports) {
    lines.push(`import { ${cls} as _${cls} } from './${basename}.js'`);
  }
  lines.push('');
  lines.push(`class ${model.className}Client {`);
  lines.push(`  private _initial: any;`);
  lines.push(`  constructor(payload: Record<string, any> = {}) {`);

  if (table) {
    for (const col of table.columns) {
      // Generated columns are never part of the client payload — they come back from the DB
      if (col.isGenerated) {
        lines.push(`    this.${col.name} = payload.${col.name} ?? null;`);
      } else {
        lines.push(`    this.${col.name} = payload.${col.name} ?? ${columnToDefault(col, model)};`);
      }
    }
  }

  for (const assoc of model.associations) {
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass) continue;
    if (assoc.kind === 'hasMany' || assoc.kind === 'habtm') {
      lines.push(`    this.${assoc.propertyName} = (payload.${assoc.propertyName} || []).map((i: any) => new ((_${targetClass} as any).Client)(i));`);
    } else {
      lines.push(`    this.${assoc.propertyName} = payload.${assoc.propertyName} ? new ((_${targetClass} as any).Client)(payload.${assoc.propertyName}) : null;`);
    }
  }

  lines.push(`    this._initial = JSON.parse(JSON.stringify(this.toJSON()));`);
  lines.push(`  }`);
  lines.push('');

  for (const method of model.instanceMethods) {
    if (method.isServerOnly || method.isValidation) continue;
    const paramStr = method.parameters.map(p => `${p.name}: ${p.type}`).join(', ');
    if (method.body) {
      lines.push(`  ${method.name}(${paramStr}): ${method.returnType} ${method.body}`);
    } else {
      lines.push(`  ${method.name}(${paramStr}): ${method.returnType} { throw new Error('${method.name}: not available on client') }`);
    }
  }

  lines.push(`  toJSON(): Record<string, unknown> {`);
  lines.push(`    const out: Record<string, unknown> = {};`);
  if (table) {
    for (const col of table.columns) lines.push(`    out.${col.name} = (this as any).${col.name};`);
  }
  lines.push(`    return out;`);
  lines.push(`  }`);
  lines.push('');

  lines.push(`  isChanged(): boolean {`);
  lines.push(`    return JSON.stringify(this.toJSON()) !== JSON.stringify(this._initial);`);
  lines.push(`  }`);
  lines.push('');

  lines.push(`  restoreAttributes(): void {`);
  lines.push(`    Object.assign(this, JSON.parse(JSON.stringify(this._initial)));`);
  lines.push(`  }`);
  lines.push('');

  lines.push(`  validate(path = ''): Record<string, string[]> {`);
  lines.push(`    let errors: Record<string, string[]> = {};`);

  for (const [prop, code] of Object.entries(model.propertyValidations)) {
    lines.push(`    { const _v = (this as any).${prop}; const _e = (${code})(_v); if (_e) { const _p = path ? \`\${path}.${prop}\` : '${prop}'; (errors[_p] = errors[_p] || []).push(_e); } }`);
  }

  // Inline @validate instance method bodies directly into validate()
  for (const method of model.instanceMethods) {
    if (!method.isValidation || !method.body) continue;
    lines.push(`    {`);
    lines.push(`      const _result = ((function(this: any) ${method.body}).call(this));`);
    lines.push(`      if (typeof _result === 'string') { const _p = path || 'base'; (errors[_p] = errors[_p] || []).push(_result); }`);
    lines.push(`    }`);
  }

  for (const assoc of model.associations) {
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass) continue;
    const prop = assoc.propertyName;
    if (assoc.kind === 'hasMany' || assoc.kind === 'habtm') {
      lines.push(`    ((this as any).${prop} as any[] || []).forEach((item: any, i: number) => {`);
      lines.push(`      errors = { ...errors, ...item.validate(path ? \`\${path}.${prop}.\${i}\` : \`${prop}.\${i}\`) };`);
      lines.push(`    });`);
    } else {
      lines.push(`    if ((this as any).${prop}) {`);
      lines.push(`      errors = { ...errors, ...(this as any).${prop}.validate(path ? \`\${path}.${prop}\` : '${prop}') };`);
      lines.push(`    }`);
    }
  }

  lines.push(`    return errors;`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');

  // Attach to the model constructor at runtime
  lines.push(`// Attach so that new Asset.Client(payload) works at runtime`);
  lines.push(`;(_${model.className} as any).Client = ${model.className}Client`);
  lines.push('');

  return lines.join('\n');
}

function generateAssociationType(assoc: AssociationMeta, ownerModel: ModelMeta, project: ProjectMeta): string | null {
  const targetClass = resolveAssocClass(assoc, project);
  if (!targetClass) return null;

  if (assoc.kind === 'belongsTo') {
    const nullable = isBelongsToNullable(assoc, ownerModel, project);
    return `${assoc.propertyName}: Promise<${targetClass}Record${nullable ? ' | null' : ''}>`;
  }
  if (assoc.kind === 'hasMany' || assoc.kind === 'habtm') {
    return `${assoc.propertyName}: Relation<${targetClass}Record, ${targetClass}Associations>`;
  }
  if (assoc.kind === 'hasOne') {
    return `${assoc.propertyName}: Promise<${targetClass}Record | null>`;
  }
  return null;
}

function isBelongsToNullable(assoc: AssociationMeta, ownerModel: ModelMeta, project: ProjectMeta): boolean {
  const fkColName = assoc.foreignKey ?? `${assoc.propertyName}Id`;
  const ownerTable = project.schema.tables[ownerModel.tableName];
  const fkCol = ownerTable?.columns.find(c =>
    c.name === fkColName || c.dbName === fkColName.replace(/([A-Z])/g, '_$1').toLowerCase()
  );
  return fkCol ? fkCol.nullable : true;
}

/** Module-level cache, reset at the start of each generate() call. */
let _resolveAssocCache: Map<string, string | null> = new Map();

function resolveAssocClass(assoc: AssociationMeta, project: ProjectMeta): string | null {
  const cacheKey = `${assoc.propertyName}|${assoc.explicitTable ?? ''}|${assoc.resolvedTable ?? ''}`;
  if (_resolveAssocCache.has(cacheKey)) return _resolveAssocCache.get(cacheKey)!;

  const tableName = assoc.explicitTable || assoc.resolvedTable;
  let result: string | null;

  if (tableName) {
    const m = project.models.find(m => m.tableName === tableName);
    if (m) {
      result = m.className;
    } else {
      // Fallback: singularize + capitalize the table name
      result = pluralize.singular(tableName).replace(/^\w/, c => c.toUpperCase());
      if (process.env['NODE_ENV'] !== 'production') {
        // Warn in dev so missing model registrations are surfaced at build time
        // eslint-disable-next-line no-console
        console.warn(
          `[active-drizzle/codegen] Could not resolve model class for table "${tableName}" ` +
          `(association: "${assoc.propertyName}"). Falling back to "${result}". ` +
          'Create a model that maps to this table to suppress this warning.',
        );
      }
    }
  } else {
    // Last resort: infer from propertyName
    const inferred = assoc.propertyName;
    const m = project.models.find(m =>
      m.className === inferred ||
      m.className === pluralize.singular(inferred) ||
      m.tableName === inferred
    );
    result = m ? m.className : pluralize.singular(inferred).replace(/^\w/, c => c.toUpperCase());
  }

  _resolveAssocCache.set(cacheKey, result);
  return result;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function columnToTsType(col: ColumnMeta): string {
  let base: string;

  // Native Postgres enum — emit the string literal union directly
  if (col.type === 'pgEnum') {
    base = col.pgEnumValues && col.pgEnumValues.length > 0
      ? col.pgEnumValues.map(v => `'${v}'`).join(' | ')
      : 'string';
  } else {
    const map: Record<string, string> = {
      // Integers
      integer: 'number',   smallint: 'number',
      serial:  'number',   smallserial: 'number',
      bigint:  'string',   bigserial:   'string',   // exceed JS safe-integer range
      // Floats / decimals
      real: 'number',  doublePrecision: 'number',
      decimal: 'string', numeric: 'string',          // full-precision; use Attr.decimal()
      // Strings
      text: 'string', varchar: 'string', char: 'string', citext: 'string', uuid: 'string',
      // Boolean
      boolean: 'boolean',
      // Date / time — pg driver returns Date for timestamps, string for date/time
      date: 'string', timestamp: 'Date', timestamptz: 'Date',
      time: 'string', interval: 'string',
      // JSON
      json: 'unknown', jsonb: 'unknown',
      // Binary
      bytea: 'Buffer',
      // Network
      inet: 'string', cidr: 'string', macaddr: 'string', macaddr8: 'string',
      // Full-text search
      tsvector: 'string', tsquery: 'string',
      // Bit strings
      bit: 'string', varbit: 'string',
      // Misc
      xml: 'string', money: 'string', oid: 'number',
      // Geometry — base type; wrap with Attr.new() for structured access
      point: '{ x: number; y: number }',
      line: 'string', lseg: 'string', box: 'string',
      path: 'string', polygon: 'string', circle: 'string',
      geometry: 'unknown',   // PostGIS — shape depends on the geometry type arg
      vector:   'number[]',  // pgvector
      // Fallbacks
      unknown: 'unknown',
      array: 'unknown[]',
    };
    base = map[col.type] ?? 'unknown';
  }

  if (col.isArray) base = `(${base})[]`;
  return col.nullable ? `${base} | null` : base;
}

function columnToDefault(col: ColumnMeta, model: ModelMeta): string {
  // Use Attr.* default if defined on the model (e.g. Attr.new({ default: () => 'draft' }))
  if (model.propertyDefaults[col.name]) {
    const d = model.propertyDefaults[col.name]!;
    // Wrap functions in an IIFE so the value is evaluated, not stored as a function ref
    return d.startsWith('(') || d.startsWith('function') ? `(${d})()` : d;
  }
  // Array columns always default to []
  if (col.isArray) return '[]';
  if (col.hasDefault) {
    if (col.type === 'integer' || col.type === 'smallint' || col.type === 'serial' || col.type === 'smallserial') return '0';
    if (col.type === 'boolean') return 'false';
    if (col.type === 'text' || col.type === 'varchar' || col.type === 'char' || col.type === 'citext') return "''";
    if (col.type === 'array') return '[]';
  }
  return 'null';
}

function collectAllScopes(model: ModelMeta, project: ProjectMeta): ScopeMeta[] {
  const scopes: ScopeMeta[] = [...model.scopes];
  let current = model;
  
  while (current.isSti && current.stiParent) {
    const parent = project.models.find(m => m.className === current.stiParent);
    if (!parent) break;
    // Only add scopes that aren't already shadowed
    for (const s of parent.scopes) {
      if (!scopes.some(existing => existing.name === s.name)) {
        scopes.push(s);
      }
    }
    current = parent;
  }
  
  return scopes;
}

export function generateRegistry(project: ProjectMeta): string {
  const lines: string[] = [];
  lines.push(`// AUTO-GENERATED — do not edit manually`);

  for (const model of project.models) {
    const basename = model.filePath.split('/').pop()!.replace('.ts', '');
    lines.push(`import { ${model.className} } from './${basename}.js'`);
  }

  lines.push('');

  // Side-effect imports attach .Client to each model constructor
  for (const model of project.models) {
    const basename = model.filePath.split('/').pop()!.replace('.ts', '');
    lines.push(`import './${basename}.gen.js'`);
  }

  lines.push('');
  lines.push(`export const registry = {`);
  for (const model of project.models) {
    lines.push(`  ${model.className},`);
  }
  lines.push(`} as const`);
  lines.push('');
  lines.push(`export type ModelRegistry = typeof registry`);

  return lines.join('\n');
}

export function generateGlobals(_project: ProjectMeta): string {
  return '// _globals.gen.d.ts — placeholder\n';
}

/**
 * Generates `.active-drizzle/schema.md` — an LLM-optimised documentation file.
 *
 * When an AI agent reads this single file it gets:
 *   - Every model, its columns, virtual Attr transforms, and scopes
 *   - Foreign key / association topology drawn out explicitly
 *   - Enum value mappings
 *   - Lifecycle hooks with conditions
 */
export function generateDocs(project: ProjectMeta): string {
  const lines: string[] = [
    '# active-drizzle Schema Reference',
    '',
    '> Auto-generated. Do not edit manually.',
    '',
  ];

  for (const model of project.models) {
    const table = project.schema.tables[model.tableName];

    lines.push(`## ${model.className}`);
    if (model.isSti) lines.push(`*STI child of \`${model.stiParent}\`*`);
    lines.push(`Table: \`${model.tableName}\``);
    lines.push('');

    // Columns
    if (table) {
      lines.push('### Columns');
      lines.push('| Column | Type | Nullable | Default |');
      lines.push('|--------|------|----------|---------|');
      for (const col of table.columns) {
        lines.push(`| \`${col.name}\` | \`${col.type}\` | ${col.nullable ? 'yes' : 'no'} | ${col.hasDefault ? 'yes' : '—'} |`);
      }
      lines.push('');
    }

    // Enums
    if (model.enums.length > 0) {
      lines.push('### Enums');
      for (const e of model.enums) {
        const vals = Object.entries(e.values).map(([k, v]) => `\`${k}\` → ${v}`).join(', ');
        lines.push(`- **\`${e.propertyName}\`**: ${vals}`);
      }
      lines.push('');
    }

    // Associations
    if (model.associations.length > 0) {
      lines.push('### Associations');
      for (const a of model.associations) {
        const fk = a.foreignKey ?? '(inferred)';
        const through = a.through ? ` through \`${a.through}\`` : '';
        lines.push(`- **${a.kind}** \`${a.propertyName}\` → \`${a.resolvedTable ?? a.explicitTable ?? '?'}\`${through} (FK: \`${fk}\`)`);
      }
      lines.push('');
    }

    // Attr transforms and defaults
    const hasAttrInfo = Object.keys(model.propertyValidations).length > 0 || Object.keys(model.propertyDefaults).length > 0;
    if (hasAttrInfo) {
      lines.push('### Attr Transforms');
      const allProps = new Set([...Object.keys(model.propertyValidations), ...Object.keys(model.propertyDefaults)]);
      for (const prop of allProps) {
        const parts: string[] = [];
        if (model.propertyDefaults[prop]) parts.push(`default: \`${model.propertyDefaults[prop]}\``);
        if (model.propertyValidations[prop]) parts.push(`validate: \`${model.propertyValidations[prop]}\``);
        lines.push(`- **\`${prop}\`**: ${parts.join(', ')}`);
      }
      lines.push('');
    }

    // Scopes
    if (model.scopes.length > 0) {
      lines.push('### Scopes');
      for (const s of model.scopes) {
        const tag = s.isComputed ? ' *(computed)*' : '';
        if (s.isZeroArg) {
          lines.push(`- \`${s.name}\`${tag}`);
        } else {
          const params = s.parameters.map(p => `${p.name}: ${p.type}`).join(', ');
          lines.push(`- \`${s.name}(${params})\`${tag}`);
        }
      }
      lines.push('');
    }

    // Lifecycle hooks
    if (model.hooks.length > 0) {
      lines.push('### Hooks');
      for (const h of model.hooks) {
        const cond = h.condition ? ` if: \`${h.condition}\`` : '';
        const on = h.on ? ` on: ${h.on}` : '';
        lines.push(`- \`@${h.decorator}\` → \`${h.methodName}\`${cond}${on}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

