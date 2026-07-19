import {
  Project,
  Node,
  SyntaxKind,
  CallExpression,
  ClassDeclaration,
  SourceFile,
  type ObjectLiteralExpression,
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
  StateMeta,
  StateTransitionMeta,
  FieldMetaEntry,
  PropertyValidationAnalysis,
  ScopeMeta,
  HookMeta,
  InstanceMethodMeta,
} from './types.js';
import { resolveValidationDeps, parseDeclaredDeps, inferPredicateDeps, unwrapExpression } from './validation-deps.js';

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

    const dbName = tableNameArg.getLiteralValue();
    const columns: ColumnMeta[] = [];

    for (const prop of columnsArg.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const colName = prop.getName().replace(/^"|"$/g, ''); // strip surrounding quotes
      const colInit = prop.getInitializer();
      if (!colInit || !Node.isCallExpression(colInit)) continue;
      columns.push(extractColumn(colName, colInit, pgEnumMap));
    }

    // Key by the EXPORT identifier, not the SQL name — the runtime resolves
    // tables through boot()'s schema object and db.query.*, both keyed by
    // export name. (They only coincide when the export matches the SQL name,
    // e.g. `users`; they diverge for `bidCovenants` → 'bid_covenants'.)
    const exportName = decl.getName();
    tables[exportName] = { name: exportName, dbName, columns };
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
  const stiTypeValue = extractStiTypeValue(classDecl);

  // Table name from @model() decorator
  const tableName = extractModelTableName(classDecl);

  const associations = extractAssociations(classDecl);
  const { enums, enumGroups } = extractEnums(classDecl);
  const states = extractStates(classDecl);
  const fieldMeta = extractFieldMeta(classDecl);
  const scopes = extractScopes(classDecl);
  const hooks = extractHooks(classDecl);
  const instanceMethods = extractInstanceMethods(classDecl);
  const { sources: propertyValidations, analysis: propertyValidationAnalysis } = extractPropertyValidations(classDecl);
  const propertyDefaults = extractPropertyDefaults(classDecl);
  const attrSetReturnTypes = extractAttrSetReturnTypes(classDecl);

  return {
    className,
    tableName,
    filePath: modelPath,
    extendsClass,
    isSti,
    stiParent,
    stiTypeValue,
    associations,
    enums,
    enumGroups,
    states,
    fieldMeta,
    scopes,
    hooks,
    instanceMethods,
    propertyValidations,
    propertyValidationAnalysis,
    propertyDefaults,
    attrSetReturnTypes,
  };
}

/** Literal value of `static stiType = '…'` — the runtime STI discriminator. */
function extractStiTypeValue(classDecl: ClassDeclaration): string | null {
  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    if (prop.getName() !== 'stiType') continue;
    const init = prop.getInitializer();
    if (init && Node.isStringLiteral(init)) return init.getLiteralValue();
  }
  return null;
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

    // TEACHING GUARD: options wrapped in a cast (`{...} as any`) arrive as
    // an AsExpression, not an object literal — previously a SILENT no-op
    // that broke codegen invisibly. Unwrap the cast when possible; refuse
    // loudly when the options genuinely aren't statically analyzable.
    const unwrap = (n: any): any => {
      let cur = n
      while (cur && (Node.isAsExpression(cur) || Node.isParenthesizedExpression(cur) || Node.isSatisfiesExpression?.(cur))) {
        cur = cur.getExpression()
      }
      return cur
    }
    const optionsNode = (n: any): Record<string, unknown> | 'not-literal' | null => {
      if (!n) return null
      const inner = unwrap(n)
      if (Node.isObjectLiteralExpression(inner)) return parseObjectLiteral(inner as ObjectLiteralExpression)
      return 'not-literal'
    }

    if (args[0] && Node.isStringLiteral(args[0])) {
      explicitTable = args[0].getLiteralValue();
      const o = optionsNode(args[1])
      if (o === 'not-literal') {
        throw new Error(
          `[active-drizzle] association '${prop.getName()}': options must be a PLAIN object literal — ` +
          `found ${args[1]!.getKindName()}. Remove the cast/expression (e.g. drop 'as any'); ` +
          `codegen reads these options statically and a cast makes them invisible.`,
        )
      }
      if (o) options = o
    } else {
      const first = optionsNode(args[0])
      const second = optionsNode(args[1])
      if (first && first !== 'not-literal') {
        // No explicit table — first arg is the options object
        options = first
      } else if (second && second !== 'not-literal') {
        // Explicit-but-empty table slot — `belongsTo(undefined, { polymorphic: true })`
        options = second
      } else if (first === 'not-literal' || second === 'not-literal') {
        throw new Error(
          `[active-drizzle] association '${prop.getName()}': options must be a PLAIN object literal — ` +
          `found ${(first === 'not-literal' ? args[0] : args[1])!.getKindName()}. Remove the cast ` +
          `('as any' etc.); codegen reads these options statically and a cast makes them invisible.`,
        )
      }
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

    // defineEnum(...) and Attr.enum(...) are the same declaration in two dialects.
    // unwrapExpression sees through `{...} as const`.
    if (fnName === 'defineEnum' || fnName === 'Attr.enum') {
      const arg = init.getArguments()[0] && unwrapExpression(init.getArguments()[0]!);
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

/**
 * Extracts Attr.state declarations — states, initial, and the transition
 * graph. Guards (`if:`) run through predicate dep inference so the client
 * can() only ships guards whose deps are provable; unprovable guards carry
 * guardDepsError and the validator turns that into a build error unless the
 * transition declares explicit `deps: [...]`.
 */
function extractStates(classDecl: ClassDeclaration): StateMeta[] {
  const result: StateMeta[] = [];

  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    if (init.getExpression().getText() !== 'Attr.state') continue;

    const configArg = init.getArguments()[0] && unwrapExpression(init.getArguments()[0]!);
    if (!configArg || !Node.isObjectLiteralExpression(configArg)) continue;

    // states: { draft: 0, ... } as const   OR   ['open', 'closed']
    let values: Record<string, number | string> = {};
    const statesProp = configArg.getProperty('states');
    if (Node.isPropertyAssignment(statesProp)) {
      const statesInit = statesProp.getInitializer() && unwrapExpression(statesProp.getInitializer()!);
      if (statesInit && Node.isObjectLiteralExpression(statesInit)) {
        values = parseObjectLiteral(statesInit) as Record<string, number | string>;
      } else if (statesInit && Node.isArrayLiteralExpression(statesInit)) {
        for (const el of statesInit.getElements()) {
          if (Node.isStringLiteral(el)) values[el.getLiteralValue()] = el.getLiteralValue();
        }
      }
    }

    // initial: 'draft'
    let initial: string | null = null;
    const initialProp = configArg.getProperty('initial');
    if (Node.isPropertyAssignment(initialProp)) {
      const v = initialProp.getInitializer();
      if (v && Node.isStringLiteral(v)) initial = v.getLiteralValue();
    }

    // transitions: { submit: { from: [...], to: '...', if: r => ..., message, deps } }
    const transitions: StateTransitionMeta[] = [];
    const transProp = configArg.getProperty('transitions');
    if (Node.isPropertyAssignment(transProp)) {
      const transInit = transProp.getInitializer() && unwrapExpression(transProp.getInitializer()!);
      if (transInit && Node.isObjectLiteralExpression(transInit)) {
        for (const t of transInit.getProperties()) {
          if (!Node.isPropertyAssignment(t)) continue;
          const event = t.getName().replace(/^['"]|['"]$/g, '');
          const tInit = t.getInitializer() && unwrapExpression(t.getInitializer()!);
          if (!tInit || !Node.isObjectLiteralExpression(tInit)) continue;

          let from: string[] | '*' = [];
          const fromProp = tInit.getProperty('from');
          if (Node.isPropertyAssignment(fromProp)) {
            const fv = fromProp.getInitializer() && unwrapExpression(fromProp.getInitializer()!);
            if (fv && Node.isStringLiteral(fv) && fv.getLiteralValue() === '*') from = '*';
            else if (fv && Node.isArrayLiteralExpression(fv)) {
              from = fv.getElements().filter(Node.isStringLiteral).map(e => e.getLiteralValue());
            }
          }

          let to = '';
          const toProp = tInit.getProperty('to');
          if (Node.isPropertyAssignment(toProp)) {
            const tv = toProp.getInitializer();
            if (tv && Node.isStringLiteral(tv)) to = tv.getLiteralValue();
          }

          let message: string | null = null;
          const msgProp = tInit.getProperty('message');
          if (Node.isPropertyAssignment(msgProp)) {
            const mv = msgProp.getInitializer();
            if (mv && Node.isStringLiteral(mv)) message = mv.getLiteralValue();
          }

          // Explicit deps escape hatch for unanalyzable guards
          let declaredDeps: string[] | null = null;
          const depsProp = tInit.getProperty('deps');
          if (Node.isPropertyAssignment(depsProp)) {
            const dv = depsProp.getInitializer();
            if (dv && Node.isArrayLiteralExpression(dv)) {
              declaredDeps = dv.getElements().filter(Node.isStringLiteral).map(e => e.getLiteralValue());
            }
          }

          let guardSource: string | null = null;
          let guardDeps: string[] | null = null;
          let guardDepsError: string | null = null;
          const ifProp = tInit.getProperty('if');
          if (Node.isPropertyAssignment(ifProp)) {
            const g = ifProp.getInitializer() && unwrapExpression(ifProp.getInitializer()!);
            if (g && (Node.isArrowFunction(g) || Node.isFunctionExpression(g))) {
              guardSource = g.getText();
              const inferred = inferPredicateDeps(g, classDecl, `${prop.getName()}.${event} guard`);
              if (inferred.ok) {
                guardDeps = inferred.deps;
              } else if (declaredDeps) {
                guardDeps = [...new Set(declaredDeps)].sort();
              } else {
                guardDepsError = inferred.error;
              }
            } else if (g) {
              guardSource = g.getText();
              guardDepsError = declaredDeps
                ? null
                : `can't infer deps for "${prop.getName()}.${event} guard": guard is not an inline function. Declare deps: [...] on the transition.`;
              if (declaredDeps) guardDeps = [...new Set(declaredDeps)].sort();
            }
          }

          transitions.push({ event, from, to, guardSource, guardDeps, guardDepsError, message });
        }
      }
    }

    result.push({ propertyName: prop.getName(), values, initial, transitions });
  }

  return result;
}

/** Meta keys handled explicitly by extractFieldMeta. */
const META_KEYS = new Set(['label', 'help', 'info', 'copy', 'presenters', 'presentIf', 'requiredIf', 'lockedIf', 'meta'])

/**
 * Lifts presentational meta off every Attr.* declaration: label/help/info
 * (string literals only), copy-by-discriminant, default presenter names,
 * record-predicates (dep-inferred, fail-closed), and the open `meta:` bag
 * (static data only — functions or identifier references are extraction
 * errors the validator turns into build failures).
 */
function extractFieldMeta(classDecl: ClassDeclaration): Record<string, FieldMetaEntry> {
  const result: Record<string, FieldMetaEntry> = {};

  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    const fnName = init.getExpression().getText();
    if (!fnName.startsWith('Attr.')) continue;

    const propertyName = prop.getName();
    const entry: FieldMetaEntry = {
      kind: fnName.slice('Attr.'.length) || null,
      label: null, help: null, info: null,
      copy: null, presenters: null,
      presentIf: null, requiredIf: null, lockedIf: null,
      extraSource: null,
      semantic: null,
      errors: [],
    };

    // Semantic refinement: Validates.email/url/uuid in the validators makes
    // the field targetable by semantic presenters (emailInput over text)
    entry.semantic = detectSemantic(init.getText());

    // The config object is the last object-literal argument (Attr.money takes
    // (column, config); most others take (config)).
    let config: Node | undefined;
    for (const arg of init.getArguments()) {
      const unwrapped = unwrapExpression(arg);
      if (Node.isObjectLiteralExpression(unwrapped)) config = unwrapped;
    }
    if (!config || !Node.isObjectLiteralExpression(config)) {
      if (entry.kind) result[propertyName] = entry;
      continue;
    }
    const cfg: ObjectLiteralExpression = config;

    const stringMeta = (key: 'label' | 'help' | 'info') => {
      const p = cfg.getProperty(key);
      if (!p) return;
      if (Node.isPropertyAssignment(p)) {
        const v = p.getInitializer();
        if (v && Node.isStringLiteral(v)) { entry[key] = v.getLiteralValue(); return; }
        if (v && Node.isNoSubstitutionTemplateLiteral(v)) { entry[key] = v.getLiteralValue(); return; }
      }
      entry.errors.push(`Attr meta "${propertyName}.${key}" must be a string literal — computed values can't be extracted for the client`);
    };
    stringMeta('label');
    stringMeta('help');
    stringMeta('info');

    // copy: { by: 'facilityType', LABEL: { label: '…', help: '…' } }
    const copyProp = cfg.getProperty('copy');
    if (Node.isPropertyAssignment(copyProp)) {
      const cv = copyProp.getInitializer() && unwrapExpression(copyProp.getInitializer()!);
      if (cv && Node.isObjectLiteralExpression(cv)) {
        let by: string | null = null;
        const overrides: Record<string, Record<string, string>> = {};
        for (const p of cv.getProperties()) {
          if (!Node.isPropertyAssignment(p)) continue;
          const key = p.getName().replace(/^['"]|['"]$/g, '');
          const v = p.getInitializer();
          if (key === 'by') {
            if (v && Node.isStringLiteral(v)) by = v.getLiteralValue();
            else entry.errors.push(`Attr meta "${propertyName}.copy.by" must be a string literal`);
            continue;
          }
          if (v && Node.isObjectLiteralExpression(v)) {
            const inner: Record<string, string> = {};
            for (const ip of v.getProperties()) {
              if (!Node.isPropertyAssignment(ip)) continue;
              const iv = ip.getInitializer();
              if (iv && Node.isStringLiteral(iv)) inner[ip.getName().replace(/^['"]|['"]$/g, '')] = iv.getLiteralValue();
              else entry.errors.push(`Attr meta "${propertyName}.copy.${key}" values must be string literals`);
            }
            overrides[key] = inner;
          } else {
            entry.errors.push(`Attr meta "${propertyName}.copy.${key}" must be an object of string literals`);
          }
        }
        if (by) entry.copy = { by, overrides };
        else entry.errors.push(`Attr meta "${propertyName}.copy" requires a 'by' key naming an enum/state Attr`);
      }
    }

    // presenters: { view: 'moneyText', edit: 'moneyInput' }
    const presProp = cfg.getProperty('presenters');
    if (Node.isPropertyAssignment(presProp)) {
      const pv = presProp.getInitializer() && unwrapExpression(presProp.getInitializer()!);
      if (pv && Node.isObjectLiteralExpression(pv)) {
        const presenters: { view?: string; edit?: string } = {};
        for (const p of pv.getProperties()) {
          if (!Node.isPropertyAssignment(p)) continue;
          const key = p.getName();
          const v = p.getInitializer();
          if ((key === 'view' || key === 'edit') && v && Node.isStringLiteral(v)) {
            presenters[key] = v.getLiteralValue();
          }
        }
        if (presenters.view || presenters.edit) entry.presenters = presenters;
      }
    }

    // Record-predicates — dep-inferred, fail-closed
    for (const predKey of ['presentIf', 'requiredIf', 'lockedIf'] as const) {
      const p = cfg.getProperty(predKey);
      if (!Node.isPropertyAssignment(p)) continue;
      const fn = p.getInitializer() && unwrapExpression(p.getInitializer()!);
      if (fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) {
        const inferred = inferPredicateDeps(fn, classDecl, `${propertyName}.${predKey}`);
        entry[predKey] = inferred.ok
          ? { source: fn.getText(), deps: inferred.deps, depsError: null }
          : { source: fn.getText(), deps: null, depsError: inferred.error };
      } else if (fn) {
        entry[predKey] = {
          source: fn.getText(),
          deps: null,
          depsError: `can't infer deps for "${propertyName}.${predKey}": must be an inline arrow function over the record`,
        };
      }
    }

    // Open meta bag — static data only
    const metaProp = cfg.getProperty('meta');
    if (Node.isPropertyAssignment(metaProp)) {
      const mv = metaProp.getInitializer() && unwrapExpression(metaProp.getInitializer()!);
      if (mv && Node.isObjectLiteralExpression(mv)) {
        const bad = findNonSerializable(mv);
        if (bad) {
          entry.errors.push(`Attr meta "${propertyName}.meta" must be static data — found ${bad} (functions and references can't ship as meta)`);
        } else {
          entry.extraSource = mv.getText();
        }
      } else {
        entry.errors.push(`Attr meta "${propertyName}.meta" must be an inline object literal`);
      }
    }

    result[propertyName] = entry;
  }

  return result;
}

/**
 * Returns a description of the first non-static-serializable node inside an
 * object/array literal tree, or null when everything is plain data.
 * Allowed: string/number/boolean/null literals, template strings without
 * substitutions, nested object/array literals, unary minus on numbers.
 */
function findNonSerializable(node: Node): string | null {
  if (Node.isObjectLiteralExpression(node)) {
    for (const p of node.getProperties()) {
      if (!Node.isPropertyAssignment(p)) return `'${p.getText().slice(0, 30)}' (shorthand/spread)`;
      const v = p.getInitializer();
      if (!v) continue;
      const bad = findNonSerializable(unwrapExpression(v));
      if (bad) return bad;
    }
    return null;
  }
  if (Node.isArrayLiteralExpression(node)) {
    for (const el of node.getElements()) {
      const bad = findNonSerializable(unwrapExpression(el));
      if (bad) return bad;
    }
    return null;
  }
  if (
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    node.getKind() === SyntaxKind.TrueKeyword ||
    node.getKind() === SyntaxKind.FalseKeyword ||
    node.getKind() === SyntaxKind.NullKeyword
  ) {
    return null;
  }
  if (Node.isPrefixUnaryExpression(node)) {
    const operand = node.getOperand();
    if (Node.isNumericLiteral(operand)) return null;
  }
  return `\`${node.getText().slice(0, 40)}\``;
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
    const validateDec = method.getDecorators().find(d => d.getName() === 'validate');
    const isValidation = Boolean(validateDec);

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

    if (isValidation) {
      let declaredDeps: string[] | undefined
      try {
        declaredDeps = parseDeclaredDeps(validateDec?.getArguments()[0])
      } catch (e: any) {
        entry.validationDepsError = e?.message ?? String(e)
      }
      if (!entry.validationDepsError) {
        const resolved = resolveValidationDeps(method, classDecl, declaredDeps)
        if (resolved.ok) {
          entry.validationDeps = resolved.deps
          entry.validationDepsSource = resolved.source
        } else {
          entry.validationDepsError = resolved.error
        }
      }
    }

    result.push(entry);
  }

  return result;
}

/** Identifiers that exist in any client runtime — never "foreign". */
const CLIENT_SAFE_GLOBALS = new Set([
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date',
  'RegExp', 'Map', 'Set', 'Symbol', 'BigInt', 'Intl', 'URL', 'Error',
  'TypeError', 'RangeError', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'undefined', 'NaN', 'Infinity', 'console', 'structuredClone',
]);

/**
 * Shippability analysis for a validator expression: which identifiers would
 * be unresolved in a generated client? `Validates` is special-cased (the
 * generators emit its import); anything else foreign means the validator
 * stays server-only — graceful degradation instead of a browser
 * ReferenceError, with a build warning naming the culprit.
 */
function analyzeValidatorExpr(init: Node): PropertyValidationAnalysis {
  const declared = new Set<string>();
  // The initializer itself is often the arrow fn — its params count too
  for (const d of [init, ...init.getDescendants()]) {
    if (Node.isArrowFunction(d) || Node.isFunctionExpression(d)) {
      for (const p of d.getParameters()) {
        const nn = p.getNameNode();
        if (Node.isIdentifier(nn)) declared.add(nn.getText());
        else if (Node.isObjectBindingPattern(nn)) {
          for (const el of nn.getElements()) declared.add(el.getName());
        }
      }
    }
    if (Node.isVariableDeclaration(d)) {
      const nn = d.getNameNode();
      if (Node.isIdentifier(nn)) declared.add(nn.getText());
    }
  }

  let usesValidates = false;
  const foreign = new Set<string>();
  const nodes = Node.isIdentifier(init) ? [init] : init.getDescendants();
  for (const n of nodes) {
    if (!Node.isIdentifier(n)) continue;
    const parent = n.getParent();
    // Property NAMES aren't references: x.foo, { foo: 1 }, method shorthand
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === n) continue;
    if (parent && Node.isPropertyAssignment(parent) && parent.getNameNode() === n) continue;
    if (parent && Node.isBindingElement(parent)) continue;
    const name = n.getText();
    if (name === 'Validates') { usesValidates = true; continue; }
    if (declared.has(name) || CLIENT_SAFE_GLOBALS.has(name)) continue;
    foreign.add(name);
  }
  return { usesValidates, foreignRefs: [...foreign].sort() };
}

/** Semantic refinement from Validates usage in a validator source. */
function detectSemantic(source: string): string | null {
  if (/\bValidates\.email\s*\(/.test(source)) return 'email';
  if (/\bValidates\.url\s*\(/.test(source)) return 'url';
  if (/\bValidates\.uuid\s*\(/.test(source)) return 'uuid';
  return null;
}

function extractPropertyValidations(classDecl: ClassDeclaration): {
  sources: Record<string, string>
  analysis: Record<string, PropertyValidationAnalysis>
} {
  const sources: Record<string, string> = {};
  const analysis: Record<string, PropertyValidationAnalysis> = {};
  for (const prop of classDecl.getStaticProperties()) {
    if (!Node.isPropertyDeclaration(prop)) continue;
    const init = prop.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;

    // Attr.*(…, { validate / validates: … })
    for (const arg of init.getArguments()) {
      if (!Node.isObjectLiteralExpression(arg)) continue;
      const validateProp = arg.getProperty('validates') ?? arg.getProperty('validate');
      if (!Node.isPropertyAssignment(validateProp)) continue;
      const initializer = validateProp.getInitializer();
      if (!initializer) continue;
      // Store source text — array or single function both serialize fine for client emission
      sources[prop.getName()] = initializer.getText();
      analysis[prop.getName()] = analyzeValidatorExpr(initializer);
    }
  }
  return { sources, analysis };
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
    } else if (Node.isObjectLiteralExpression(val)) {
      // Nested objects parse as objects, not source text — association
      // options like order: { position: 'asc' } depend on this
      result[key] = parseObjectLiteral(val);
    } else {
      result[key] = val.getText();
    }
  }
  return result;
}
