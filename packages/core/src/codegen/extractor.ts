import {
  Project,
  Node,
  CallExpression,
  ClassDeclaration,
  SourceFile,
} from 'ts-morph';
import type {
  ModelMeta,
  SchemaMeta,
  TableMeta,
  ColumnMeta,
  ColumnType,
  AssociationMeta,
  EnumMeta,
  EnumGroupMeta,
  ScopeMeta,
  HookMeta,
  InstanceMethodMeta,
} from './types.js';

// ---------------------------------------------------------------------------
// extractSchema
// ---------------------------------------------------------------------------

export function extractSchema(project: Project, schemaPath: string): SchemaMeta {
  const sourceFile = project.getSourceFile(schemaPath);
  if (!sourceFile) throw new Error(`Schema file not found at ${schemaPath}`);

  // Pre-pass: build a map of pgEnum variable name → string values.
  // e.g.  const roleEnum = pgEnum('role', ['admin','user']) → { roleEnum: ['admin','user'] }
  const pgEnumMap = extractPgEnumDeclarations(sourceFile);

  const tables: Record<string, TableMeta> = {};

  // Only scan exported variable declarations — internal helpers won't be pgTable calls
  // and skipping them meaningfully reduces iteration on large schema files.
  const exportedDecls = sourceFile
    .getVariableStatements()
    .filter(stmt => stmt.isExported())
    .flatMap(stmt => stmt.getDeclarations());

  // Fall back to all declarations when the schema exports nothing (rare, but valid)
  const decls = exportedDecls.length > 0
    ? exportedDecls
    : sourceFile.getVariableDeclarations();

  for (const decl of decls) {
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;

    const pgTableCall = findPgTableCall(init, 0);
    if (!pgTableCall) continue;

    const args = pgTableCall.getArguments();
    if (args.length < 2) continue;

    const tableNameArg = args[0];
    const columnsArg = args[1];
    if (!Node.isStringLiteral(tableNameArg) || !Node.isObjectLiteralExpression(columnsArg)) continue;

    const tableName = tableNameArg.getLiteralValue();
    const columns: ColumnMeta[] = [];

    for (const prop of columnsArg.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const colName = prop.getName().replace(/^"|"$/g, ''); // strip surrounding quotes
      const colInit = prop.getInitializer();
      if (!colInit || !Node.isCallExpression(colInit)) continue;
      columns.push(extractColumn(colName, colInit, pgEnumMap));
    }

    tables[tableName] = { name: tableName, columns };
  }

  if (Object.keys(tables).length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[active-drizzle/codegen] No pgTable() calls found in schema file "${schemaPath}". ` +
      'Ensure the file exports Drizzle table variables (e.g. export const users = pgTable(...)).',
    );
  }

  return { tables, filePath: schemaPath };
}

/**
 * Finds all `pgEnum('name', [...values])` declarations in a source file and
 * returns a map of variable-name → string-literal values.
 *
 * Drizzle native enums are used as column types:
 *   const roleEnum = pgEnum('role', ['admin', 'user'])
 *   export const users = pgTable('users', { role: roleEnum('role') })
 */
function extractPgEnumDeclarations(sourceFile: SourceFile): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const decl of sourceFile.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    if (init.getExpression().getText() !== 'pgEnum') continue;
    const args = init.getArguments();
    if (args.length < 2) continue;
    const valuesArg = args[1];
    if (!Node.isArrayLiteralExpression(valuesArg)) continue;
    const values: string[] = [];
    for (const elem of valuesArg.getElements()) {
      if (Node.isStringLiteral(elem)) values.push(elem.getLiteralValue());
    }
    result.set(decl.getName(), values);
  }
  return result;
}

/**
 * Recursively walks chained call expressions to find the innermost `pgTable()`
 * call (e.g. `pgTable(...).enableRLS()`). The `depth` guard prevents runaway
 * recursion on pathological or generated code.
 */
function findPgTableCall(expr: CallExpression, depth: number): CallExpression | undefined {
  if (depth > 10) return undefined; // safety guard against infinite recursion

  const callText = expr.getExpression().getText();
  if (callText === 'pgTable' || callText.endsWith('Table')) return expr;

  // Walk through chained property access (e.g. pgTable(...).enableRLS())
  const inner = expr.getExpression();
  if (Node.isPropertyAccessExpression(inner)) {
    const base = inner.getExpression();
    if (Node.isCallExpression(base)) return findPgTableCall(base, depth + 1);
  }
  return undefined;
}

/**
 * Full Drizzle pg-core column type map.
 * Covers every column function exported by drizzle-orm/pg-core as of v0.40.
 */
const DRIZZLE_TYPE_MAP: Record<string, ColumnType> = {
  // Integers
  integer: 'integer', smallint: 'smallint', bigint: 'bigint',
  serial: 'serial', smallserial: 'smallserial', bigserial: 'bigserial',
  // Floats / decimals
  real: 'real', doublePrecision: 'doublePrecision',
  decimal: 'decimal', numeric: 'numeric',
  // Strings
  text: 'text', varchar: 'varchar', char: 'char', citext: 'citext', uuid: 'uuid',
  // Boolean
  boolean: 'boolean',
  // Date / time
  date: 'date', timestamp: 'timestamp', timestamptz: 'timestamptz',
  time: 'time', interval: 'interval',
  // JSON
  json: 'json', jsonb: 'jsonb',
  // Binary
  bytea: 'bytea',
  // Network
  inet: 'inet', cidr: 'cidr', macaddr: 'macaddr', macaddr8: 'macaddr8',
  // Full-text search
  tsvector: 'tsvector', tsquery: 'tsquery',
  // Bit strings
  bit: 'bit', varbit: 'varbit',
  // Misc
  xml: 'xml', money: 'money', oid: 'oid',
  // Geometry (standard Postgres types)
  point: 'point', line: 'line', lseg: 'lseg', box: 'box',
  path: 'path', polygon: 'polygon', circle: 'circle',
  // Extension types — drizzle-orm/pg-core exports these when extension drivers are loaded
  geometry: 'geometry',  // PostGIS
  vector: 'vector',      // pgvector
};

function extractColumn(
  propName: string,
  call: CallExpression,
  pgEnumMap: Map<string, string[]>,
): ColumnMeta {
  // The property name in the Drizzle schema is the camelCase JS key (e.g. 'assetType').
  // The first arg to the column function is the snake_case DB name (e.g. 'asset_type').
  const camelName = toCamelCase(propName);
  let type: ColumnType = 'unknown';
  let dbName = propName;
  let nullable = true;
  let primaryKey = false;
  let hasDefault = false;
  let isArray = false;
  let isGenerated = false;
  let pgEnumValues: string[] | null = null;

  // Walk the method chain from outermost call back to the base function.
  let current: CallExpression | undefined = call;
  while (current) {
    const expr = current.getExpression();
    if (Node.isPropertyAccessExpression(expr)) {
      const mod = expr.getName();
      if (mod === 'notNull')    nullable = false;
      if (mod === 'primaryKey') primaryKey = true;
      if (mod === 'default' || mod === 'defaultNow') hasDefault = true;
      if (mod === 'array')      isArray = true;
      // generatedAlwaysAsIdentity / generatedByDefaultAsIdentity
      if (mod === 'generatedAlwaysAsIdentity' || mod === 'generatedByDefaultAsIdentity') {
        isGenerated = true;
        hasDefault  = true;  // DB assigns it, so it has a default from Drizzle's perspective
        nullable    = false; // identity columns are always NOT NULL
      }
      const base = expr.getExpression();
      current = Node.isCallExpression(base) ? base : undefined;
    } else if (Node.isIdentifier(expr)) {
      const typeName = expr.getText();
      // 1. Known Drizzle column function
      if (DRIZZLE_TYPE_MAP[typeName]) {
        type = DRIZZLE_TYPE_MAP[typeName]!;
      // 2. pgEnum variable used as a column type — e.g. roleEnum('role')
      } else if (pgEnumMap.has(typeName)) {
        type          = 'pgEnum';
        pgEnumValues  = pgEnumMap.get(typeName)!;
        nullable      = false; // pgEnum columns are NOT NULL by default in Drizzle unless .nullable() called
      }
      const firstArg = current.getArguments()[0];
      if (firstArg && Node.isStringLiteral(firstArg)) dbName = firstArg.getLiteralValue();
      current = undefined;
    } else {
      current = undefined;
    }
  }

  return { name: camelName, dbName, type, nullable, primaryKey, hasDefault, isArray, isGenerated, pgEnumValues };
}

function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// extractModel
// ---------------------------------------------------------------------------

export function extractModel(project: Project, modelPath: string): ModelMeta {
  const sourceFile = project.getSourceFile(modelPath);
  if (!sourceFile) throw new Error(`Model file not found at ${modelPath}`);

  const classDecl = sourceFile.getClasses()[0];
  if (!classDecl) throw new Error(`No class found in ${modelPath}`);

  const className = classDecl.getName() ?? 'Unknown';
  const extendsClass = classDecl.getExtends()?.getExpression().getText() ?? 'ApplicationRecord';
  const isSti = extendsClass !== 'ApplicationRecord';
  const stiParent = isSti ? extendsClass : null;

  // Table name from @model() decorator
  const tableName = extractModelTableName(classDecl);

  const associations = extractAssociations(classDecl);
  const { enums, enumGroups } = extractEnums(classDecl);
  const scopes = extractScopes(classDecl);
  const hooks = extractHooks(classDecl);
  const instanceMethods = extractInstanceMethods(classDecl);
  const propertyValidations = extractPropertyValidations(classDecl);
  const propertyDefaults = extractPropertyDefaults(classDecl);
  const attrSetReturnTypes = extractAttrSetReturnTypes(classDecl);

  return {
    className,
    tableName,
    filePath: modelPath,
    extendsClass,
    isSti,
    stiParent,
    associations,
    enums,
    enumGroups,
    scopes,
    hooks,
    instanceMethods,
    propertyValidations,
    propertyDefaults,
    attrSetReturnTypes,
  };
}

function extractModelTableName(classDecl: ClassDeclaration): string {
  // 1. @model('tableName') decorator
  for (const dec of classDecl.getDecorators()) {
    if (dec.getName() === 'model') {
      const args = dec.getArguments();
      if (args[0] && Node.isStringLiteral(args[0])) return args[0].getLiteralValue();
    }
  }
  // 2. static _activeDrizzleTableName = 'tableName' (runtime assignment)
  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    if (prop.getName() !== '_activeDrizzleTableName') continue;
    const init = prop.getInitializer();
    if (init && Node.isStringLiteral(init)) return init.getLiteralValue();
  }
  return '';
}

function extractAssociations(classDecl: ClassDeclaration): AssociationMeta[] {
  const result: AssociationMeta[] = [];

  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;

    const fnName = init.getExpression().getText();
    const kind =
      fnName === 'belongsTo' ? 'belongsTo'
      : fnName === 'hasMany' ? 'hasMany'
      : fnName === 'hasOne' ? 'hasOne'
      : fnName === 'habtm' ? 'habtm'
      : null;

    if (!kind) continue;

    const propertyName = prop.getName();
    const args = init.getArguments();

    let explicitTable: string | null = null;
    let options: Record<string, unknown> = {};

    if (args[0] && Node.isStringLiteral(args[0])) {
      explicitTable = args[0].getLiteralValue();
      if (args[1] && Node.isObjectLiteralExpression(args[1])) {
        options = parseObjectLiteral(args[1]);
      }
    } else if (args[0] && Node.isObjectLiteralExpression(args[0])) {
      // No explicit table — first arg is the options object
      options = parseObjectLiteral(args[0]);
    }

    result.push({
      kind,
      propertyName,
      resolvedTable: null,
      explicitTable,
      foreignKey: (options.foreignKey as string) ?? null,
      primaryKey: (options.primaryKey as string) ?? null,
      through: (options.through as string) ?? null,
      order: (options.order as any) ?? null,
      polymorphic: (options.polymorphic as boolean) ?? false,
      acceptsNested: (options.acceptsNested as boolean) ?? false,
      options,
    });
  }

  return result;
}

function extractEnums(classDecl: ClassDeclaration): { enums: EnumMeta[], enumGroups: EnumGroupMeta[] } {
  const enums: EnumMeta[] = [];
  const enumGroups: EnumGroupMeta[] = [];

  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const fnName = init.getExpression().getText();
    const propertyName = prop.getName();

    if (fnName === 'defineEnum') {
      const arg = init.getArguments()[0];
      if (arg && Node.isObjectLiteralExpression(arg)) {
        const raw = parseObjectLiteral(arg);
        enums.push({ propertyName, values: raw as Record<string, number> });
      }
    } else if (fnName === 'enumGroup') {
      const args = init.getArguments();
      const enumField = args[0] && Node.isStringLiteral(args[0]) ? args[0].getLiteralValue() : '';
      let range: [number, number] = [0, 0];
      if (args[1] && Node.isArrayLiteralExpression(args[1])) {
        const elems = args[1].getElements();
        range = [Number(elems[0]?.getText()), Number(elems[1]?.getText())];
      }
      enumGroups.push({ propertyName, enumField, range });
    }
  }

  return { enums, enumGroups };
}

function extractScopes(classDecl: ClassDeclaration): ScopeMeta[] {
  const result: ScopeMeta[] = [];

  for (const method of classDecl.getStaticMethods()) {
    const decorators = method.getDecorators();
    const hasScope = decorators.some(d => d.getName() === 'scope');
    const hasComputed = decorators.some(d => d.getName() === 'computed');
    if (!hasScope && !hasComputed) continue;

    const params = method.getParameters().map(p => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? 'unknown',
    }));

    // Extract `this.X` references from the body for validator column checking
    const bodyText = method.getBody()?.getText() ?? '';
    const thisRefMatches = bodyText.match(/\bthis\.([a-zA-Z_][a-zA-Z0-9_]*)/g) ?? [];
    const thisRefs = [...new Set(thisRefMatches.map(m => m.slice(5)))]; // strip 'this.'

    result.push({
      name: method.getName(),
      parameters: params,
      isZeroArg: params.length === 0,
      isComputed: hasComputed,
      thisRefs,
    });
  }

  return result;
}

function extractHooks(classDecl: ClassDeclaration): HookMeta[] {
  const result: HookMeta[] = [];
  const HOOK_NAMES = new Set(['beforeSave', 'afterSave', 'beforeCreate', 'afterCreate', 'afterCommit', 'beforeUpdate', 'afterUpdate', 'beforeDestroy', 'afterDestroy']);

  for (const method of classDecl.getInstanceMethods()) {
    for (const dec of method.getDecorators()) {
      const decName = dec.getName();
      if (!HOOK_NAMES.has(decName)) continue;

      let condition: string | null = null;
      let on: 'create' | 'update' | null = null;

      const args = dec.getArguments();
      if (args[0] && Node.isObjectLiteralExpression(args[0])) {
        const opts = parseObjectLiteral(args[0]);
        condition = (opts.if as string) ?? null;
        on = (opts.on as 'create' | 'update') ?? null;
      }

      result.push({
        decorator: decName,
        methodName: method.getName(),
        condition,
        on,
      });
    }
  }

  return result;
}

function extractInstanceMethods(classDecl: ClassDeclaration): InstanceMethodMeta[] {
  const result: InstanceMethodMeta[] = [];
  const HOOK_NAMES = new Set(['beforeSave', 'afterSave', 'beforeCreate', 'afterCreate', 'afterCommit', 'beforeUpdate', 'afterUpdate', 'beforeDestroy', 'afterDestroy']);

  for (const method of classDecl.getInstanceMethods()) {
    // Skip hooks — already extracted
    const isHook = method.getDecorators().some(d => HOOK_NAMES.has(d.getName()));
    if (isHook) continue;

    const isServerOnly = method.getDecorators().some(d => d.getName() === 'server');
    const isValidation = method.getDecorators().some(d => d.getName() === 'validate');

    // Capture the body text for client-side method emission.
    // Server-only methods are never sent to the client, so no body needed.
    const body = !isServerOnly ? (method.getBody()?.getText() ?? undefined) : undefined;

    const entry: InstanceMethodMeta = {
      name: method.getName(),
      returnType: method.getReturnTypeNode()?.getText() ?? 'unknown',
      parameters: method.getParameters().map(p => ({
        name: p.getName(),
        type: p.getTypeNode()?.getText() ?? 'unknown',
      })),
      isServerOnly,
      isValidation,
    };
    if (body !== undefined) entry.body = body;
    result.push(entry);
  }

  return result;
}

function extractPropertyValidations(classDecl: ClassDeclaration): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    
    // Check for Attr.new({ validate: ... })
    const arg = init.getArguments()[0];
    if (Node.isObjectLiteralExpression(arg)) {
      const validateProp = arg.getProperty('validate');
      if (Node.isPropertyAssignment(validateProp)) {
        result[prop.getName()] = validateProp.getInitializer()?.getText() || '';
      }
    }
  }
  return result;
}

function extractPropertyDefaults(classDecl: ClassDeclaration): Record<string, string> {
  const result: Record<string, string> = {};
  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const fnName = init.getExpression().getText();
    if (!fnName.startsWith('Attr.')) continue;

    // Search all object literal args for a `default` key
    for (const arg of init.getArguments()) {
      if (!Node.isObjectLiteralExpression(arg)) continue;
      const defaultProp = arg.getProperty('default');
      if (Node.isPropertyAssignment(defaultProp)) {
        const defaultText = defaultProp.getInitializer()?.getText();
        if (defaultText) result[prop.getName()] = defaultText;
      }
    }
  }
  return result;
}

/**
 * Infers the return type of each Attr.set() function via static text analysis.
 * We look for simple patterns like `return v * 100` → 'number', `return String(v)` → 'string'.
 * This is deliberately conservative: only emits a type when we're sure.
 */
function extractAttrSetReturnTypes(classDecl: ClassDeclaration): Record<string, string> {
  const result: Record<string, string> = {};

  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const fnName = init.getExpression().getText();
    if (!fnName.startsWith('Attr.')) continue;

    for (const arg of init.getArguments()) {
      if (!Node.isObjectLiteralExpression(arg)) continue;
      const setProp = arg.getProperty('set');
      if (!Node.isPropertyAssignment(setProp)) continue;
      const setFn = setProp.getInitializer();
      if (!setFn) continue;

      const bodyText = setFn.getText();
      // Heuristic: does the body clearly produce a number or string?
      let inferred: string | undefined;
      if (/Math\.round|parseInt|Number\(|Math\.floor|Math\.ceil|\* \d|\d \*/.test(bodyText)) {
        inferred = 'number';
      } else if (/String\(|\.trim\(|\.toLowerCase\(|\.toUpperCase\(|\.toString\(/.test(bodyText)) {
        inferred = 'string';
      } else if (/Boolean\(|=== true|=== false|!! /.test(bodyText)) {
        inferred = 'boolean';
      } else if (/JSON\.stringify/.test(bodyText)) {
        inferred = 'string';
      }

      if (inferred) result[prop.getName()] = inferred;
    }
  }

  return result;
}

function parseObjectLiteral(obj: any): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!Node.isObjectLiteralExpression(obj)) return result;
  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    // Strip surrounding quotes from computed/string-keyed property names
    const key = prop.getName().replace(/^"|"$/g, '');
    const val = prop.getInitializer();
    if (!val) continue;
    if (Node.isStringLiteral(val)) result[key] = val.getLiteralValue();
    else if (Node.isNumericLiteral(val)) result[key] = Number(val.getLiteralValue());
    else if (val.getText() === 'true') result[key] = true;
    else if (val.getText() === 'false') result[key] = false;
    else if (Node.isArrayLiteralExpression(val)) {
      result[key] = val.getElements().map(e => Node.isStringLiteral(e) ? e.getLiteralValue() : e.getText());
    } else {
      result[key] = val.getText();
    }
  }
  return result;
}
