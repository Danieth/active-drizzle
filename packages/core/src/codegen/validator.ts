import type { Diagnostic, ProjectMeta, AssociationMeta, ModelMeta } from './types.js';
import pluralize from 'pluralize';

/**
 * Validate all (or a subset of) models.
 *
 * @param validateOnly - When provided, only models whose `filePath` is in this set are
 *   validated. The full `project` is still passed so cross-model checks (bidirectional
 *   associations, STI parent lookup) have access to all models.
 */
export function validate(project: ProjectMeta, validateOnly?: Set<string>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const model of project.models) {
    if (validateOnly && !validateOnly.has(model.filePath)) continue;
    validateAssociations(model, project, diagnostics);
    validateEnums(model, project, diagnostics);
    validateHooks(model, project, diagnostics);
    validateScopes(model, project, diagnostics);
    validateAttrSetTypes(model, project, diagnostics);
    validateSti(model, project, diagnostics);
  }

  return diagnostics;
}

function err(modelFile: string, message: string, suggestion?: string): Diagnostic {
  const d: Diagnostic = { severity: 'error', modelFile, message };
  if (suggestion !== undefined) d.suggestion = suggestion;
  return d;
}

function warn(modelFile: string, message: string, suggestion?: string): Diagnostic {
  const d: Diagnostic = { severity: 'warning', modelFile, message };
  if (suggestion !== undefined) d.suggestion = suggestion;
  return d;
}

function validateAssociations(model: ModelMeta, project: ProjectMeta, out: Diagnostic[]) {
  for (const assoc of model.associations) {
    const targetTable = assoc.explicitTable ?? pluralize(assoc.propertyName);
    const allTables = Object.keys(project.schema.tables);

    const tableExists = targetTable in project.schema.tables;
    if (!tableExists) {
      // Suggest closest matching table using both computed table name and raw property name
      const suggestion = findClose(targetTable, allTables) ?? findClose(assoc.propertyName, allTables);
      out.push(err(
        model.filePath,
        `Association "${assoc.propertyName}": table "${targetTable}" not found in schema.${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
      ));
      continue;
    }

    // FK check for belongsTo — check the owning model's table only when no explicit FK is given
    if (assoc.kind === 'belongsTo') {
      const fkCol = assoc.foreignKey ?? `${assoc.propertyName}Id`;
      const ownerTable = project.schema.tables[model.tableName];
      const hasFk = ownerTable?.columns.some(c =>
        c.name === fkCol || c.dbName === toSnakeCase(fkCol)
      );
      // Only warn when FK is explicitly missing (skip when no ownerTable found in schema)
      if (ownerTable && !hasFk && !assoc.foreignKey) {
        out.push(warn(
          model.filePath,
          `Association "${assoc.propertyName}": expected FK column "${fkCol}" on table "${model.tableName}" but it was not found.`,
        ));
      }
    }

    // FK check for hasMany — check the target table for the foreign key
    if (assoc.kind === 'hasMany' && !assoc.through) {
      const fkCol = assoc.foreignKey ?? `${pluralize.singular(model.className.toLowerCase())}Id`;
      const targetSchema = project.schema.tables[targetTable];
      const hasFk = targetSchema?.columns.some(c =>
        c.name === fkCol || c.dbName === toSnakeCase(fkCol)
      );
      if (targetSchema && !hasFk) {
        out.push(err(
          model.filePath,
          `Association "${assoc.propertyName}": column "${fkCol}" not found on table "${targetTable}".`,
        ));
      }
    }

    // Through-table validation for hasMany :through
    if (assoc.kind === 'hasMany' && assoc.through) {
      if (!(assoc.through in project.schema.tables)) {
        out.push(err(
          model.filePath,
          `Association "${assoc.propertyName}": through table "${assoc.through}" not found in schema.`,
        ));
      }
    }

    // Missing bidirectional association (warning) — check the inverse specifically points back
    const targetModel = project.models.find(m => m.tableName === targetTable);
    if (assoc.kind === 'hasMany') {
      if (!targetModel) {
        out.push(warn(
          model.filePath,
          `Association "${assoc.propertyName}": target model for table "${targetTable}" not found. Cannot verify bidirectional association.`,
        ));
      } else {
        // Inverse must be a belongsTo that points back at this model's table
        const ownerTable = model.tableName;
        const hasInverse = targetModel.associations.some(a =>
          a.kind === 'belongsTo' &&
          (a.explicitTable === ownerTable || (!a.explicitTable && pluralize(a.propertyName) === ownerTable))
        );
        if (!hasInverse) {
          out.push(warn(
            model.filePath,
            `Association "${assoc.propertyName}": no bidirectional belongsTo found on "${targetModel.className}" pointing back to "${ownerTable}". Consider adding it.`,
          ));
        }
      }
    } else if (assoc.kind === 'belongsTo') {
      // Inverse must be a hasMany/hasOne pointing back at this model's table
      const ownerTable = model.tableName;
      const hasInverse = targetModel?.associations.some(a =>
        (a.kind === 'hasMany' || a.kind === 'hasOne') &&
        (a.explicitTable === ownerTable || (!a.explicitTable && pluralize(a.propertyName) === ownerTable))
      );
      if (targetModel && !hasInverse) {
        out.push(warn(
          model.filePath,
          `Association "${assoc.propertyName}": no bidirectional hasMany/hasOne found on "${targetModel.className}" pointing back to "${ownerTable}". Consider adding it.`,
        ));
      }
    }
  }
}

function validateEnums(model: ModelMeta, project: ProjectMeta, out: Diagnostic[]) {
  const table = project.schema.tables[model.tableName];
  if (!table) return;

  for (const enumDef of model.enums) {
    const col = table.columns.find(c => c.name === enumDef.propertyName || c.dbName === toSnakeCase(enumDef.propertyName));
    if (!col) continue; // Virtual field — no schema column, allowed

    const hasIntValues = Object.values(enumDef.values).every(v => typeof v === 'number');
    if (hasIntValues && (col.type === 'text' || col.type === 'varchar')) {
      out.push(err(
        model.filePath,
        `Enum "${enumDef.propertyName}": expects INTEGER or SMALLINT column but found "${col.type}". Update the schema column type.`,
      ));
    }
  }
}

function validateHooks(model: ModelMeta, project: ProjectMeta, out: Diagnostic[]) {
  const table = project.schema.tables[model.tableName];
  if (!table) return;

  for (const hook of model.hooks) {
    if (!hook.condition) continue;

    const fieldName = hook.condition.endsWith('Changed')
      ? hook.condition.slice(0, -7)
      : hook.condition;

    const colExists = table.columns.some(
      c => c.name === fieldName || c.dbName === toSnakeCase(fieldName)
    );
    if (!colExists) {
      out.push(err(
        model.filePath,
        `Hook "${hook.methodName}": condition "${hook.condition}" references field "${fieldName}" which was not found on table "${model.tableName}".`,
      ));
    }
  }
}

// Drizzle column types that map to JavaScript 'number'
const NUMBER_COL_TYPES = new Set(['integer', 'serial', 'bigint', 'smallint', 'real', 'doublePrecision', 'numeric', 'decimal', 'float']);
// Drizzle column types that map to JavaScript 'string'
const STRING_COL_TYPES = new Set(['text', 'varchar', 'char', 'uuid', 'citext']);
// Drizzle column types that map to JavaScript 'boolean'
const BOOLEAN_COL_TYPES = new Set(['boolean']);

function validateAttrSetTypes(model: ModelMeta, project: ProjectMeta, out: Diagnostic[]) {
  const table = project.schema.tables[model.tableName];
  if (!table) return;

  for (const [propName, inferredReturnType] of Object.entries(model.attrSetReturnTypes)) {
    // Find the column — may be directly named propName, or via Attr.for() mapping (use dbName)
    const col = table.columns.find(c => c.name === propName || c.dbName === propName);
    if (!col) continue;

    const colBaseType = col.type.replace('[]', '');
    const mismatch =
      (inferredReturnType === 'number' && STRING_COL_TYPES.has(colBaseType)) ||
      (inferredReturnType === 'number' && BOOLEAN_COL_TYPES.has(colBaseType)) ||
      (inferredReturnType === 'string' && NUMBER_COL_TYPES.has(colBaseType)) ||
      (inferredReturnType === 'string' && BOOLEAN_COL_TYPES.has(colBaseType)) ||
      (inferredReturnType === 'boolean' && NUMBER_COL_TYPES.has(colBaseType)) ||
      (inferredReturnType === 'boolean' && STRING_COL_TYPES.has(colBaseType));

    if (mismatch) {
      out.push(err(
        model.filePath,
        `Attr.set() on "${propName}" appears to return "${inferredReturnType}", but the column "${col.dbName}" is typed as "${col.type}".`,
        `Ensure Attr.set() transforms the value to the correct type for the DB column.`,
      ));
    }
  }
}

function validateScopes(model: ModelMeta, project: ProjectMeta, out: Diagnostic[]) {
  const table = project.schema.tables[model.tableName];
  if (!table) return;

  const validNames = new Set([
    ...table.columns.map(c => c.name),
    ...table.columns.map(c => c.dbName),
    ...model.enums.map(e => e.propertyName),
    // Also allow known method names — is*, to*, *Changed, etc.
  ]);

  for (const scope of model.scopes) {
    for (const ref of scope.thisRefs) {
      // Skip refs that look like method calls (e.g. this.where, this.order, this.createdAt.gte)
      // Only validate plain property accesses — where the ref exactly matches a known column
      if (
        ref === 'where' || ref === 'order' || ref === 'limit' || ref === 'offset' ||
        ref === 'includes' || ref === 'errors' || ref === 'id' || ref === 'tableName'
      ) continue;

      // Check that the referenced property is either a column, an Attr, or an association
      const isKnown =
        validNames.has(ref) ||
        model.associations.some(a => a.propertyName === ref) ||
        ref.startsWith('is') || ref.startsWith('to');

      if (!isKnown) {
        out.push(warn(
          model.filePath,
          `Scope "${scope.name}": references \`this.${ref}\` which was not found as a column or Attr on "${model.tableName}".`,
          `Check that "${ref}" matches the camelCase schema column name.`,
        ));
      }
    }
  }
}

function validateSti(model: ModelMeta, project: ProjectMeta, out: Diagnostic[]) {
  if (!model.isSti || !model.stiParent) return;

  const parent = project.models.find(m => m.className === model.stiParent);
  if (!parent) {
    out.push(err(model.filePath, `STI model "${model.className}" extends "${model.stiParent}" but that model was not found.`));
    return;
  }

  // Parent table must have a type discriminator column
  const parentTable = project.schema.tables[parent.tableName];
  const hasTypeCol = parentTable?.columns.some(c => c.name === 'type' || c.dbName === 'type');
  if (!hasTypeCol) {
    out.push(err(
      model.filePath,
      `STI model "${model.className}": parent table "${parent.tableName}" has no discriminator type column. Add a "type" column (smallint or integer).`,
    ));
  }

  // Warn if no defaultScope on the STI child model — encourage the stiType pattern.
  const hasDefaultScope = model.scopes.some(s => s.name === 'defaultScope');
  if (!hasDefaultScope) {
    out.push(warn(
      model.filePath,
      `STI model "${model.className}": add \`static stiType = <discriminatorValue>\` to your class so active-drizzle automatically injects WHERE type = <value> on all queries and instantiates the correct subclass when loading from the parent table.`,
    ));
  }
}

/**
 * Levenshtein edit distance between two strings.
 * O(m·n) time; only called on small sets of table/column names.
 * Uses a single rolling row instead of a full matrix to keep allocations tiny.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const row: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = row[j]!;
      row[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, row[j - 1]!, row[j]!);
      prev = temp;
    }
  }
  return row[n]!;
}

/**
 * Returns the closest match from `options` to `target`.
 * Only suggests when the distance is within 60 % of the target length —
 * avoids wild guesses on completely unrelated names.
 */
function findClose(target: string, options: string[]): string | null {
  if (options.length === 0) return null;
  const t = target.toLowerCase();
  const threshold = Math.max(2, Math.ceil(t.length * 0.6));
  let best: string | null = null;
  let bestDist = Infinity;
  for (const opt of options) {
    const dist = levenshtein(t, opt.toLowerCase());
    if (dist < bestDist && dist <= threshold) {
      bestDist = dist;
      best = opt;
    }
  }
  return best;
}

function toSnakeCase(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase();
}
