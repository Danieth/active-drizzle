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
import * as path from 'node:path';
import { depsFitProjection } from './validation-deps.js';

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
    // The declarations CANNOT share a basename with the runtime file:
    // `X.model.gen.d.ts` next to `X.model.gen.ts` is treated by tsc's
    // include-glob rules as that file's BUILD OUTPUT and silently excluded
    // from the program — so every `declare module` augmentation (instance
    // field types, statics, scopes) never applied under `tsc --noEmit`.
    const typesBase = base.replace(/\.model\.gen$/, '.model.types.gen');
    files.push({ path: `${typesBase}.d.ts`, content: generateModelTypes(model, project) });
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
export function generateModelTypes(model: ModelMeta, project: ProjectMeta, srcPrefix = '.'): string {
  const lines: string[] = [];
  const recordName = `${model.className}Record`;
  const table = project.schema.tables[model.tableName];
  // STI parent, when it's a model in this project (used to inherit types).
  const stiParentWithModel = model.stiParent && project.models.some(m => m.className === model.stiParent)
    ? model.stiParent
    : null;

  lines.push(`// AUTO-GENERATED — do not edit manually`);
  lines.push(`import type { Relation, IncludeArg, MapInclude } from 'active-drizzle'`);
  lines.push('');

  // ── Instance augmentation ─────────────────────────────────────────────
  lines.push(`declare module '${srcPrefix}/${model.className}.model' {`);
  lines.push(`  interface ${model.className} {`);
  lines.push(`    readonly _associations: ${model.className}Associations;`);

  for (const assoc of model.associations) {
    const assocLine = generateAssociationType(assoc, model, project);
    if (assocLine) lines.push(`    ${assocLine}`);
    // The Rails-style habtm ids set is a REAL instance member (hydrated on
    // read, REPLACES the join-row set on assign) — typing it here is what
    // lets expose/permit allowlists accept it and gives `deal.coOwnerIds`
    // autocomplete instead of `any`.
    if (assoc.kind === 'habtm') {
      lines.push(`    ${habtmIdsKey(assoc.propertyName)}: Array<number | string>`);
    }
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

  // Attr.state: label union field, is<Label>(), can()/can<Event>()/advance(),
  // and per-event assign-only methods.
  for (const st of model.states) {
    const labels = Object.keys(st.values);
    const labelUnion = labels.map(l => `'${l}'`).join(' | ') || 'never';
    lines.push(`    ${st.propertyName}: ${labelUnion} | null`);
    for (const key of labels) {
      lines.push(`    is${capitalize(key)}(): boolean`);
      lines.push(`    to${capitalize(key)}(): ${recordName}`);
    }
    if (st.transitions.length > 0) {
      const eventUnion = st.transitions.map(t => `'${t.event}'`).join(' | ');
      lines.push(`    can(event: ${eventUnion}): boolean`);
      lines.push(`    advance(event: ${eventUnion}): Promise<boolean>`);
      for (const t of st.transitions) {
        lines.push(`    can${capitalize(t.event)}(): boolean`);
        lines.push(`    ${t.event}(): boolean`);
      }
    }
  }

  // Column value properties — the record proxy auto-exposes every column, so
  // the interface must declare them or `this.<col>` is invisible to TS (and
  // collides with the static Attr declaration in error messages). Skip columns
  // already typed by an enum, state, or association declaration — on this
  // model OR an STI ancestor (a subclass re-declaring `status: string` would
  // conflict with the parent's narrowed label union).
  if (table) {
    const covered = new Set<string>();
    for (let m: ModelMeta | undefined = model; m; m = project.models.find(p => p.className === m!.stiParent)) {
      for (const e of m.enums) covered.add(e.propertyName);
      for (const s of m.states) covered.add(s.propertyName);
      for (const a of m.associations) covered.add(a.propertyName);
    }
    for (const col of table.columns) {
      if (covered.has(col.name)) continue;
      lines.push(`    ${col.name}: ${columnToTsType(col)}`);
    }
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

  // OWN statics must NOT be redeclared in the merged namespace — a class's
  // own `static open()` plus a namespace `const open` is TS2451 the moment
  // the augmentation actually applies. Own scopes are typed by the user's
  // static method itself (whose `this.where(...)` resolves through the
  // namespace `where` above, so the return IS the typed Relation). Only
  // scopes this class doesn't declare directly — inherited STI scopes —
  // need a namespace declaration.
  const ownScopeNames = new Set(model.scopes.map(s => s.name));
  const allScopes = collectAllScopes(model, project);
  for (const scope of allScopes) {
    if (ownScopeNames.has(scope.name)) continue;
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

  // enum-group statics are own statics too (`static images = enumGroup(...)`)
  // — same TS2451 collision; the class declaration is the type.

  // NOTE: no namespace `const` for enum/state statics — the class already
  // declares `static <prop> = Attr.enum/state(...)` and TS types it from the
  // initializer; a same-named namespace const is a redeclaration error when
  // the augmentation is actually loaded into the program.

  // Client class type declaration (implementation lives in .gen.ts).
  // For STI subclasses the body is the MERGED ancestor chain — an ambient
  // `extends Parent.Client` can't be used because names inside a `declare
  // module` block resolve in the d.ts file's own scope (where the parent isn't
  // imported), and skipLibCheck would mask the failure. A structural superset
  // keeps the runtime class's static `extends` side compatible.
  const chain = stiChain(model, project);
  const chainAssocs = dedupeBy(chain.flatMap(m => m.associations), a => a.propertyName);
  const chainStates = chain.flatMap(m => m.states);
  const chainMethods = dedupeBy(chain.flatMap(m => m.instanceMethods), im => im.name);
  lines.push(`    class Client {`);
  if (table) {
    for (const col of table.columns) {
      const tsType = columnToTsType(col);
      const isOptional = col.nullable || col.hasDefault;
      lines.push(`      ${col.name}${isOptional ? '?' : ''}: ${tsType};`);
    }
  }
  for (const assoc of chainAssocs) {
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass) continue;
    // `<X>Client` is a global alias from _globals.gen.d.ts — the augmented
    // module can't import, so cross-model references go through globals.
    if (assoc.kind === 'hasMany' || assoc.kind === 'habtm') {
      lines.push(`      ${assoc.propertyName}: ${targetClass}Client[];`);
      if (assoc.kind === 'habtm') {
        lines.push(`      ${habtmIdsKey(assoc.propertyName)}?: Array<number | string>;`);
      }
    } else {
      const nullable = assoc.kind === 'belongsTo' ? isBelongsToNullable(assoc, model, project) : true;
      lines.push(`      ${assoc.propertyName}: ${targetClass}Client${nullable ? ' | null' : ''};`);
    }
  }
  for (const method of chainMethods) {
    if (method.isServerOnly || method.isValidation) continue;
    const paramStr = method.parameters.map(p => `${p.name}: ${p.type}`).join(', ');
    lines.push(`      ${method.name}(${paramStr}): ${method.returnType}`);
  }
  lines.push(`      constructor(payload?: Record<string, any>)`);
  lines.push(`      toJSON(): Record<string, unknown>`);
  lines.push(`      isChanged(): boolean`);
  lines.push(`      restoreAttributes(): void`);
  lines.push(`      validate(path?: string): Record<string, string[]>`);
  const clientEvents = chainStates.flatMap(st => st.transitions.map(t => t.event));
  if (clientEvents.length > 0) {
    lines.push(`      can(event: ${clientEvents.map(e => `'${e}'`).join(' | ')}): boolean`);
  }
  if (chain.some(m => Object.keys(m.fieldMeta ?? {}).length > 0)) {
    lines.push(`      static fieldMeta: Record<string, unknown>`);
  }
  lines.push(`    }`);

  lines.push(`  }`);
  lines.push(`}`);
  lines.push('');

  // ── Stand-alone exports ───────────────────────────────────────────────
  lines.push(`export type ${recordName} = InstanceType<typeof import('./${model.className}.model').${model.className}>`);
  lines.push('');

  lines.push(`// --- Advanced Type Sorcery ---`);
  // STI subclasses inherit the parent's associations at runtime — the type
  // extends the parent's interface (resolved via the _globals.gen.d.ts alias).
  const assocExtends = stiParentWithModel ? `extends ${stiParentWithModel}Associations ` : '';
  lines.push(`export interface ${model.className}Associations ${assocExtends}{`);
  for (const line of renderAssociationMembers(model, project)) lines.push(line);
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
  // acceptsNestedAttributesFor: embed nested Create type recursively —
  // hasMany takes an array of child rows, hasOne a single one
  for (const assoc of model.associations) {
    if (!assoc.acceptsNested) continue;
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass) continue;
    lines.push(`  ${assoc.propertyName}Attributes?: ${targetClass}Create${assoc.kind === 'hasOne' ? '' : '[]'};`);
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
export function generateClientRuntime(model: ModelMeta, project: ProjectMeta, srcPrefix = '.'): string {
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

  // Property validators ship iff every identifier they reference resolves in
  // a client (graceful degradation: foreign refs stay server-only). Validates
  // is the sanctioned exception — its import is emitted below.
  const shippableValidations = Object.entries(model.propertyValidations).filter(
    ([prop]) => (model.propertyValidationAnalysis?.[prop]?.foreignRefs?.length ?? 0) === 0,
  );
  const needsValidates = shippableValidations.some(
    ([prop]) => model.propertyValidationAnalysis?.[prop]?.usesValidates,
  );

  lines.push(`// AUTO-GENERATED — do not edit manually`);
  lines.push(`import { ${model.className} as _${model.className} } from '${srcPrefix}/${model.className}.model.js'`);
  if (needsValidates) {
    lines.push(`import { Validates } from 'active-drizzle'`);
  }
  for (const [cls, basename] of assocImports) {
    lines.push(`import { ${cls} as _${cls} } from '${srcPrefix}/${basename}.js'`);
  }
  lines.push('');
  lines.push(`class ${model.className}Client {`);
  
  // Declare all properties first
  if (table) {
    for (const col of table.columns) {
      const tsType = columnToTsType(col);
      lines.push(`  ${col.name}: ${tsType};`);
    }
  }
  
  for (const assoc of model.associations) {
    const targetClass = resolveAssocClass(assoc, project);
    if (!targetClass) continue;
    if (assoc.kind === 'hasMany' || assoc.kind === 'habtm') {
      lines.push(`  ${assoc.propertyName}: ${targetClass}Client[];`);
    } else {
      lines.push(`  ${assoc.propertyName}: ${targetClass}Client | null;`);
    }
  }
  
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

  // Presentational meta — static data + provable predicates, from the Attrs
  {
    const metaProjection = modelProjectionFields(model, project);
    const metaSource = renderFieldMeta(model, metaProjection);
    if (metaSource) {
      lines.push(`  static fieldMeta = ${metaSource} as const;`);
      lines.push('');
    }
  }

  // Attr.state → client can(event): from-state check + guards that are
  // provable AND whose deps fit this model's projection. Fail-closed: a guard
  // the client can't evaluate makes can() return false — the server-computed
  // answer is the source of truth, the client only ever narrows.
  if (model.states.some(st => st.transitions.length > 0)) {
    const clientProjection = modelProjectionFields(model, project);
    lines.push(`  can(event: string): boolean {`);
    for (const st of model.states) {
      for (const t of st.transitions) {
        const fromCheck = t.from === '*'
          ? 'true'
          : `(${JSON.stringify(t.from)} as readonly string[]).includes(String((this as any).${st.propertyName}))`;
        let guardCheck = 'true';
        if (t.guardSource) {
          const provable = t.guardDeps && !t.guardDepsError && depsFitProjection(t.guardDeps, clientProjection);
          guardCheck = provable ? `Boolean((${t.guardSource})(this as any))` : 'false';
        }
        lines.push(`    if (event === '${t.event}') return ${fromCheck} && ${guardCheck};`);
      }
    }
    lines.push(`    return false;`);
    lines.push(`  }`);
    lines.push('');
  }

  lines.push(`  validate(path = ''): Record<string, string[]> {`);
  lines.push(`    let errors: Record<string, string[]> = {};`);
  lines.push(`    const _push = (field: string, msg: unknown) => {`);
  lines.push(`      if (typeof msg !== 'string') return;`);
  lines.push(`      const t = msg.trim();`);
  lines.push(`      if (!t) return;`);
  lines.push(`      (errors[field] = errors[field] || []).push(t);`);
  lines.push(`    };`);
  // Validators receive (value, draft, field) — record-gates (if/unless) run
  // against the projected draft when they can. A gate touching something this
  // client doesn't have (unpermitted field, server-only method) THROWS here;
  // the catch degrades that validator to a no-op and the server stays
  // authoritative. Never a browser crash, never a false block.
  lines.push(`    const _run = (field: string, validators: any, value: any) => {`);
  lines.push(`      const list = Array.isArray(validators) ? validators : [validators];`);
  lines.push(`      for (const fn of list) {`);
  lines.push(`        if (typeof fn !== 'function') continue;`);
  lines.push(`        try { _push(field, fn(value, this, field)); } catch (e) {`);
  lines.push(`          if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {`);
  lines.push(`            console.warn('[active-drizzle] validator for "' + field + '" threw client-side (treated as server-only):', e);`);
  lines.push(`          }`);
  lines.push(`        }`);
  lines.push(`      }`);
  lines.push(`    };`);

  for (const [prop, code] of shippableValidations) {
    lines.push(`    { const _v = (this as any).${prop}; _run(path ? \`\${path}.${prop}\` : '${prop}', (${code}), _v); }`);
  }

  // Inline @validate instance methods whose deps ⊆ this model's field projection.
  // Unprovable deps are codegen errors (validator); we never ship them quietly.
  const projection = modelProjectionFields(model, project);
  for (const method of model.instanceMethods) {
    if (!method.isValidation || !method.body) continue;
    if (method.validationDepsError || !method.validationDeps) continue;
    if (!depsFitProjection(method.validationDeps, projection)) continue;
    lines.push(`    {`);
    lines.push(`      const _result = ((function(this: any) ${method.body}).call(this));`);
    lines.push(`      _push(path || 'base', _result);`);
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

  // ── Ceiling type (DESIGN-projections) ──────────────────────────────────
  // Every field name + association key as literal types, RECURSIVELY —
  // `access: { … } satisfies ${'{'}Model{'}'}Projection` makes a typo'd field or a
  // nonexistent association a red squiggle at any depth of the ceiling.
  {
    const fieldNames = new Set<string>();
    for (const col of table?.columns ?? []) fieldNames.add(col.name);
    for (const f of Object.keys(model.fieldMeta ?? {})) fieldNames.add(f);
    for (const e of model.enums ?? []) fieldNames.add(e.propertyName);
    for (const s of model.states ?? []) fieldNames.add(s.propertyName);
    for (const a of model.associations) {
      if (a.kind === 'habtm') fieldNames.add(habtmIdsKey(a.propertyName));
    }
    const fieldUnion = [...fieldNames].sort().map(f => `'${f}'`).join(' | ') || 'never';
    const assocEntries: string[] = [];
    const projImports: string[] = [];
    for (const assoc of model.associations) {
      const targetClass = resolveAssocClass(assoc, project);
      if (!targetClass) continue;
      const assocModel = project.models.find(mm => mm.className === targetClass);
      if (!assocModel) continue;
      assocEntries.push(`${assoc.propertyName}?: ${targetClass}Projection`);
      if (targetClass !== model.className) {
        const base = assocModel.filePath.split('/').pop()!.replace('.model.ts', '.model.gen');
        projImports.push(`import type { ${targetClass}Projection } from './${base}.js'`);
      }
    }
    for (const imp of [...new Set(projImports)]) lines.push(imp);
    lines.push('');
    lines.push(`/** Access-ceiling config type — \`access: { editable: [...], viewable: [...], include: {...} } satisfies ${model.className}Projection\`; every field name and association key is typo-proof at any depth. */`);
    lines.push(`export interface ${model.className}Projection {`);
    lines.push(`  /** Writable — implicitly viewable too. */`);
    lines.push(`  editable?: Array<${fieldUnion}>`);
    lines.push(`  /** Read-only. */`);
    lines.push(`  viewable?: Array<${fieldUnion}>`);
    if (assocEntries.length) {
      lines.push(`  include?: { ${assocEntries.join('; ')} }`);
    } else {
      lines.push(`  include?: Record<string, never>`);
    }
    lines.push(`}`);
  }

  return lines.join('\n');
}

/** The model plus its STI ancestors (self first), for merged type emission. */
function stiChain(model: ModelMeta, project: ProjectMeta): ModelMeta[] {
  const chain: ModelMeta[] = [];
  for (let m: ModelMeta | undefined = model; m; m = project.models.find(p => p.className === m!.stiParent)) {
    chain.push(m);
    if (chain.length > 16) break; // cycle guard — validator reports real cycles
  }
  return chain;
}

/** First-wins dedupe (subclass overrides ancestor) preserving order. */
function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => (seen.has(key(item)) ? false : (seen.add(key(item)), true)));
}

/** Members of a model's `<X>Associations` interface (shared with _globals.gen.d.ts). */
/**
 * `owners` → `ownerIds`, using EXACTLY the runtime's rule
 * (application-record `_singularize`) — the emitted key must match what
 * save() looks for, so pluralize (with its irregular tables) is off-limits.
 */
function habtmIdsKey(prop: string): string {
  const s = prop.endsWith('ies') ? prop.slice(0, -3) + 'y'
    : prop.endsWith('ses') || prop.endsWith('xes') || prop.endsWith('zes') ? prop.slice(0, -2)
    : prop.endsWith('s') && !prop.endsWith('ss') ? prop.slice(0, -1)
    : prop;
  return `${s}Ids`;
}

function renderAssociationMembers(model: ModelMeta, project: ProjectMeta): string[] {
  const lines: string[] = [];
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
  return lines;
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
  const cacheKey = `${assoc.kind}|${assoc.propertyName}|${assoc.explicitTable ?? ''}|${assoc.resolvedTable ?? ''}`;
  if (_resolveAssocCache.has(cacheKey)) return _resolveAssocCache.get(cacheKey)!;

  // Polymorphic belongsTo has NO static target class — the row's type column
  // decides at runtime. Inferring one from the property name fabricated
  // references to classes that don't exist (`CommentableClient`).
  if (assoc.kind === 'belongsTo' && assoc.polymorphic) {
    _resolveAssocCache.set(cacheKey, null);
    return null;
  }

  // habtm: marker.table is the JOIN table, never the target — the target is
  // className (Rails' class_name) or inferred from the property name,
  // mirroring the runtime's _findModelByMarker
  if (assoc.kind === 'habtm') {
    const cn = assoc.options?.['className'];
    const inferred = typeof cn === 'string' && cn
      ? cn
      : pluralize.singular(assoc.propertyName).replace(/^\w/, c => c.toUpperCase());
    const m = project.models.find(mm => mm.className === inferred);
    const habtmResult = m ? m.className : inferred;
    _resolveAssocCache.set(cacheKey, habtmResult);
    return habtmResult;
  }

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

/**
 * THE column → emitted-TS-type map — EXHAUSTIVE by construction:
 * `satisfies Record<…>` makes a new ColumnType member a compile error HERE
 * until it is deliberately mapped (the silent `?? 'unknown'` fallthrough
 * that mistyped ranges for weeks is unrepresentable now). 'unknown' values
 * are DELIBERATE and allowlisted by the precision ratchet test — adding a
 * new one fails the suite.
 */
export const COLUMN_TS_TYPE = {
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
  // JSON — arbitrary by nature; Attr.json narrows at the model layer
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
  // Ranges — RAW driver repr is a string ('[1,10)'); Attr.range() parses
  int4range: 'string', int8range: 'string', numrange: 'string',
  tsrange: 'string', tstzrange: 'string', daterange: 'string',
  nummultirange: 'string',
  // Fallbacks
  unknown: 'unknown',
  array: 'unknown[]',
} satisfies Record<Exclude<import('./types.js').ColumnType, 'pgEnum'>, string>

export function columnToTsType(col: ColumnMeta): string {
  let base: string;

  // Native Postgres enum — emit the string literal union directly
  if (col.type === 'pgEnum') {
    base = col.pgEnumValues && col.pgEnumValues.length > 0
      ? col.pgEnumValues.map(v => `'${v}'`).join(' | ')
      : 'string';
  } else {
    const mapped = (COLUMN_TS_TYPE as Record<string, string>)[col.type];
    if (mapped === undefined) {
      // A type outside the union reached codegen — silent 'unknown' here is
      // how the range mistyping survived for weeks. Never again: teach.
      throw new Error(
        `column '${col.name}' has unrecognized type '${col.type}' — add it to ColumnType + ` +
        `COLUMN_TS_TYPE (packages/core/src/codegen), or wrap the column with Attr.new() ` +
        `to declare its shape. Silent 'unknown' typing is not an option anymore.`,
      );
    }
    base = mapped;
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

/** Fields available on the model Client projection (columns + attrs + associations). */
function modelProjectionFields(model: ModelMeta, project: ProjectMeta): Set<string> {
  const fields = new Set<string>();
  const table = project.schema.tables[model.tableName];
  if (table) {
    for (const c of table.columns) fields.add(c.name);
  }
  for (const e of model.enums) fields.add(e.propertyName);
  for (const a of model.associations) fields.add(a.propertyName);
  for (const p of Object.keys(model.propertyValidations)) fields.add(p);
  for (const p of Object.keys(model.propertyDefaults)) fields.add(p);
  for (const p of Object.keys(model.attrSetReturnTypes)) fields.add(p);
  return fields;
}

export function generateRegistry(project: ProjectMeta, registryDir?: string): string {
  const lines: string[] = [];
  lines.push(`// AUTO-GENERATED — do not edit manually`);

  for (const model of project.models) {
    // model.filePath is absolute; imports are relative to where the
    // registry is actually written (the caller passes its output dir)
    const base = registryDir
      ?? (project.models[0] ? path.dirname(project.models[0].filePath) : process.cwd());
    let rel = path.relative(base, model.filePath);
    if (!rel.startsWith('.')) rel = './' + rel;
    // strip .ts, append .js
    rel = rel.replace(/\.ts$/, '.js');
    lines.push(`import { ${model.className} } from '${rel}'`);
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

/**
 * Generates `_globals.gen.d.ts` — AMBIENT global type aliases for every model.
 *
 * The per-model `.gen.d.ts` files augment their model module via
 * `declare module './X.model'`; inside an augmentation block you cannot add
 * imports, so every cross-model type reference (`ProposalRecord`,
 * `OrganizationClient`, …) resolves through these globals instead.
 *
 * The file must stay import/export-free — a d.ts with no top-level
 * import/export is a global script, which is exactly what makes these names
 * visible everywhere. (`import('…')` in type position does not modularize it.)
 *
 * @param outDir absolute directory the file is written to (used to compute
 *               relative import() specifiers; defaults to the first model's dir)
 */
export function generateGlobals(project: ProjectMeta, outDir?: string): string {
  const lines: string[] = [];
  lines.push(`// AUTO-GENERATED — do not edit manually`);
  lines.push(`// Ambient global aliases: cross-model references in the .gen.d.ts`);
  lines.push(`// module augmentations resolve through these (augmentation blocks`);
  lines.push(`// cannot import). This file must not contain import/export statements.`);
  lines.push('');

  const baseDir = outDir ?? (project.models[0] ? path.dirname(project.models[0].filePath) : process.cwd());

  for (const model of project.models) {
    let rel = path.relative(baseDir, model.filePath);
    if (!rel.startsWith('.')) rel = './' + rel;
    rel = rel.replace(/\.ts$/, '.js');
    const imp = `import('${rel}').${model.className}`;
    lines.push(`type ${model.className}Record = InstanceType<typeof ${imp}>`);
    lines.push(`type ${model.className}Client = InstanceType<typeof ${imp}.Client>`);
  }
  lines.push('');

  // Association shapes — global so an STI subclass's d.ts can extend its
  // parent's interface, and so Relation-typed helpers can name them anywhere.
  // (Structurally identical to the module-scoped export in each .gen.d.ts.)
  for (const model of project.models) {
    const parent = model.stiParent && project.models.some(m => m.className === model.stiParent)
      ? model.stiParent
      : null;
    lines.push(`interface ${model.className}Associations ${parent ? `extends ${parent}Associations ` : ''}{`);
    for (const line of renderAssociationMembers(model, project)) lines.push(line);
    lines.push(`}`);
  }
  lines.push('');

  return lines.join('\n');
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
/**
 * Renders a Client's `static fieldMeta` object-literal source.
 *
 * Only fields inside `projection` appear at all; predicates ship only when
 * provable AND their deps fit the projection (a predicate the client can't
 * evaluate is omitted — the field renders as always-present/never-locked and
 * the server stays authoritative). The open `meta:` bag is inlined verbatim —
 * the extractor already proved it's static data.
 */
export function renderFieldMeta(
  model: ModelMeta,
  projection: Set<string>,
  /** Extra literal entries appended into the object (e.g. attachment fields). */
  extraEntries: string[] = [],
): string | null {
  const entries: string[] = [...extraEntries];
  for (const [prop, m] of Object.entries(model.fieldMeta ?? {})) {
    if (!projection.has(prop)) continue;
    const parts: string[] = [];
    // Semantic refinement wins at runtime — presenter resolution falls back
    // to the base kind ('email' → 'string') when no semantic default exists
    if (m.semantic) parts.push(`kind: '${m.semantic}'`);
    else if (m.kind) parts.push(`kind: '${m.kind}'`);
    // Enum/state fields carry their labels so select presenters can
    // enumerate options straight from meta
    const enumDef = model.enums.find(e => e.propertyName === prop);
    const stateDef = model.states.find(st => st.propertyName === prop);
    const labels = enumDef ? Object.keys(enumDef.values) : stateDef ? Object.keys(stateDef.values) : null;
    if (labels) parts.push(`options: ${JSON.stringify(labels)}`);
    if (m.label !== null) parts.push(`label: ${JSON.stringify(m.label)}`);
    if (m.help !== null) parts.push(`help: ${JSON.stringify(m.help)}`);
    if (m.info !== null) parts.push(`info: ${JSON.stringify(m.info)}`);
    if (m.copy) parts.push(`copy: ${JSON.stringify({ by: m.copy.by, ...m.copy.overrides })}`);
    if (m.presenters) parts.push(`presenters: ${JSON.stringify(m.presenters)}`);
    for (const predKey of ['presentIf', 'requiredIf', 'lockedIf'] as const) {
      const pred = m[predKey];
      if (pred && !pred.depsError && pred.deps && depsFitProjection(pred.deps, projection)) {
        parts.push(`${predKey}: (${pred.source})`);
      }
    }
    if (m.extraSource) parts.push(`meta: ${m.extraSource}`);
    if (parts.length > 0) entries.push(`    ${prop}: { ${parts.join(', ')} },`);
  }
  if (entries.length === 0) return null;
  return `{\n${entries.join('\n')}\n  }`;
}

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

    // State machines
    if (model.states.length > 0) {
      lines.push('### State Machines');
      for (const st of model.states) {
        const vals = Object.entries(st.values).map(([k, v]) => `\`${k}\` → ${v}`).join(', ');
        lines.push(`- **\`${st.propertyName}\`**: ${vals}${st.initial ? ` (initial: \`${st.initial}\`)` : ''}`);
        for (const t of st.transitions) {
          const from = t.from === '*' ? '*' : t.from.map(f => `\`${f}\``).join(', ');
          const guard = t.guardSource ? ` — guard: \`${t.guardSource}\`` : '';
          lines.push(`  - \`${t.event}\`: ${from} → \`${t.to}\`${guard}`);
        }
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

